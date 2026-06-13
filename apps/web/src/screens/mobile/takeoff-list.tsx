/**
 * Mobile takeoff entry — the SHEETS browser (msg16).
 *
 * Audit (M04): the old screen listed one row per uploaded PDF DOCUMENT. The
 * handoff design is a per-SHEET grid: a "SHEETS · N TOTAL" header naming the
 * active sheet, FILTER tabs (ALL / WITH TAKEOFF / UNVERIFIED), and a grid of
 * sheet tiles with a thumbnail, the sheet code/name, and status badges
 * (a ✓ mark when the page has measurements). Tapping a tile opens the native
 * mobile takeoff canvas (`mb-takeoff`) preselected to that blueprint + page.
 *
 * Sheets come from the latest uploaded blueprint's real page list
 * (useBlueprintPages); "with takeoff" / "unverified" are derived from each
 * page's measurement_count + calibration_set_at. PDF pages are not rasterized
 * to per-page images yet, so each tile shows a placeholder thumbnail rather
 * than a render — the structure (grid / filters / badges) is the design, the
 * picture fills in when rasterization lands.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, useUploadBlueprint } from '@/lib/api'
import { useBlueprintPages, type BlueprintPage } from '@/lib/api/takeoff'
import { useRole } from '@/lib/role'
import { MBody, MButton, MI, MTopBar } from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'

// Mirrors the response from `GET /api/projects/:id/blueprints`. The API
// uses `file_name` / `created_at`; do not rename to camel-case here —
// callers compare straight against the persisted shape.
type BlueprintRow = {
  id: string
  project_id: string
  file_name: string
  storage_path: string
  created_at: string
  deleted_at: string | null
  replaces_blueprint_document_id?: string | null
}

type SheetFilter = 'all' | 'with-takeoff' | 'unverified'

export function MobileTakeoffList({ companySlug }: { companySlug: string }) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const [blueprints, setBlueprints] = useState<readonly BlueprintRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bump to force a re-fetch after a successful upload.
  const [reloadKey, setReloadKey] = useState(0)
  const [filter, setFilter] = useState<SheetFilter>('all')

  // Blueprint upload — admin/foreman/office only (hidden for worker).
  const role = useRole()
  const canUploadBlueprint = role === 'owner' || role === 'foreman'
  const uploadBlueprint = useUploadBlueprint(projectId)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const onPickBlueprintFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file) return
    setUploadError(null)
    uploadBlueprint.mutate(file, {
      // Upload success enters the plan-ingest STEP 3/3 screen (dsg__44/45,
      // audit M03 #12) instead of skipping straight to the canvas. The new
      // document's id travels as `?blueprint=` so ingest can track THIS
      // upload's parse rather than re-deriving "latest doc".
      onSuccess: (doc) => {
        setReloadKey((k) => k + 1)
        navigate(`/projects/${projectId}/takeoff-ai/ingest?blueprint=${encodeURIComponent(doc.id)}`)
      },
      onError: (err) => setUploadError(err instanceof Error ? err.message : 'Upload failed'),
    })
  }

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    apiGet<{ blueprints: BlueprintRow[] }>(`/api/projects/${projectId}/blueprints`, companySlug)
      .then((res) => {
        if (cancelled) return
        setBlueprints(res.blueprints.filter((b) => !b.deleted_at))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, companySlug, reloadKey])

  // The active blueprint document whose SHEETS we browse — newest upload.
  const latestDoc = blueprints && blueprints.length > 0 ? blueprints[blueprints.length - 1]! : null
  const pagesQuery = useBlueprintPages(latestDoc?.id ?? null)
  const pages = useMemo(() => pagesQuery.data?.pages ?? [], [pagesQuery.data])

  const counts = useMemo(() => {
    const withTakeoff = pages.filter((p) => p.measurement_count > 0).length
    const unverified = pages.filter((p) => !p.calibration_set_at).length
    return { all: pages.length, withTakeoff, unverified }
  }, [pages])

  const visiblePages = useMemo(() => {
    if (filter === 'with-takeoff') return pages.filter((p) => p.measurement_count > 0)
    if (filter === 'unverified') return pages.filter((p) => !p.calibration_set_at)
    return pages
  }, [pages, filter])

  const openSheet = (page?: BlueprintPage) => {
    if (!latestDoc) {
      navigate(`/projects/${projectId}/takeoff-mobile`)
      return
    }
    const qs = new URLSearchParams({ blueprint: latestDoc.id })
    if (page) qs.set('page', page.id)
    navigate(`/projects/${projectId}/takeoff-mobile?${qs}`)
  }

  return (
    <>
      <MTopBar
        back
        eyebrow={latestDoc ? `SHEETS · ${counts.all || '—'} TOTAL` : 'BLUEPRINTS'}
        title={latestDoc ? latestDoc.file_name : 'Blueprints'}
        onBack={() => navigate(`/projects/${projectId}`)}
      />
      <MBody>
        {canUploadBlueprint ? (
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/*"
            style={{ display: 'none' }}
            onChange={onPickBlueprintFile}
          />
        ) : null}
        {uploadError ? (
          <div style={{ padding: '8px 16px 0', color: 'var(--m-red)', fontSize: 13 }}>{uploadError}</div>
        ) : null}
        {error ? (
          <div style={{ padding: 24, color: 'var(--m-red)', fontSize: 13 }}>{error}</div>
        ) : blueprints === null ? (
          <>
            <div style={{ padding: '14px 16px 0' }} />
            <MSkeletonList count={3} />
          </>
        ) : blueprints.length === 0 ? (
          <MEmptyState
            title="No drawings yet"
            body="You can still run a takeoff: enter manual quantities per scope item, or upload a drawing to trace polygons and compute square footage."
            {...(canUploadBlueprint
              ? {
                  primaryLabel: uploadBlueprint.isPending ? 'Uploading…' : 'Upload a drawing',
                  onPrimary: () => fileInputRef.current?.click(),
                }
              : {})}
            secondaryLabel="Start takeoff"
            onSecondary={() => navigate(`/projects/${projectId}/takeoff-mobile`)}
          />
        ) : (
          <>
            {/* FILTER tabs (msg16). */}
            <div style={{ padding: '14px 16px 4px' }}>
              <div className="m-topbar-eyebrow" style={{ marginBottom: 8 }}>
                FILTER
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(
                  [
                    { key: 'all', label: `ALL · ${counts.all}` },
                    { key: 'with-takeoff', label: `WITH TAKEOFF · ${counts.withTakeoff}` },
                    { key: 'unverified', label: `UNVERIFIED · ${counts.unverified}` },
                  ] as const
                ).map((t) => {
                  const on = filter === t.key
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setFilter(t.key)}
                      aria-pressed={on}
                      style={{
                        padding: '8px 12px',
                        background: on ? 'var(--m-ink)' : 'transparent',
                        color: on ? 'var(--m-sand)' : 'var(--m-ink-2)',
                        border: '2px solid var(--m-ink)',
                        fontFamily: 'var(--m-num)',
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        cursor: 'pointer',
                      }}
                    >
                      {t.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Sheet grid. */}
            {pagesQuery.isLoading ? (
              <MSkeletonList count={4} />
            ) : pages.length === 0 ? (
              <div style={{ padding: '0 16px 8px', fontSize: 13, color: 'var(--m-ink-3)', lineHeight: 1.5 }}>
                This blueprint has no extracted sheets yet. Open the takeoff to measure against the whole drawing.
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 12,
                  padding: '10px 16px 4px',
                }}
              >
                {visiblePages.map((p) => (
                  <SheetTile key={p.id} page={p} onTap={() => openSheet(p)} />
                ))}
              </div>
            )}

            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <MButton variant="primary" onClick={() => openSheet()}>
                Open mobile takeoff
              </MButton>
              {canUploadBlueprint ? (
                <MButton
                  variant="ghost"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadBlueprint.isPending}
                >
                  {uploadBlueprint.isPending ? 'Uploading…' : '↑ Upload blueprint'}
                </MButton>
              ) : null}
            </div>
          </>
        )}
      </MBody>
    </>
  )
}

/** One sheet tile: placeholder thumbnail + code/name + status badge. */
function SheetTile({ page, onTap }: { page: BlueprintPage; onTap: () => void }) {
  const hasTakeoff = page.measurement_count > 0
  const verified = Boolean(page.calibration_set_at)
  return (
    <button
      type="button"
      onClick={onTap}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        padding: 0,
        background: 'var(--m-card)',
        border: '2px solid var(--m-ink)',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {/* Thumbnail well (placeholder until per-page rasterization lands). */}
      <div
        style={{
          position: 'relative',
          aspectRatio: '4 / 3',
          background: hasTakeoff ? 'var(--m-accent)' : 'var(--m-card-soft)',
          borderBottom: '2px solid var(--m-ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <MI.Layers size={22} />
        {hasTakeoff ? (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 6,
              left: 6,
              width: 18,
              height: 18,
              background: 'var(--m-ink)',
              color: 'var(--m-sand)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 11,
            }}
          >
            ✓
          </span>
        ) : null}
      </div>
      <div style={{ padding: '8px 10px 10px' }}>
        <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700, color: 'var(--m-ink-3)' }}>
          P-{page.page_number}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 700,
            fontSize: 14,
            letterSpacing: '-0.005em',
            marginTop: 1,
          }}
        >
          PAGE {page.page_number}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            marginTop: 4,
            color: verified ? 'var(--m-green)' : 'var(--m-ink-3)',
          }}
        >
          {hasTakeoff ? `${page.measurement_count} TAKEOFF` : verified ? 'VERIFIED' : 'UNVERIFIED'}
        </div>
      </div>
    </button>
  )
}
