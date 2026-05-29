/**
 * `mb-takeoff-autoscale` — mobile AI autoscale verify.
 *
 * Ported from Steve's v2 master-flow mockup `V2EstScaleAuto`
 * ("AUTOSCALE · VERIFY") for MOBILE. The AI auto-detects a scale per sheet;
 * the estimator verifies each one (an N/22 verified counter at the top, a
 * per-sheet HIGH/MED/LOW confidence list below). Takeoff quantities aren't
 * trusted until every sheet is verified, so the "Open takeoff" CTA stays
 * disabled while sheets remain.
 *
 * Partially wired. The per-sheet list, scale text, and the N/total verified
 * counter are now backed by REAL blueprint pages (useBlueprintPages on the
 * project's latest blueprint document). A page counts as "verified" when its
 * two-point calibration is set (calibration_set_at != null), mirroring how the
 * polygon canvas trusts a scale.
 *
 * GAP: a sheet's CHECK action cannot truly calibrate from here — the calibrate
 * endpoint (POST /api/blueprint-pages/:id/calibrate, via useCalibratePage)
 * needs two on-image points (x1,y1,x2,y2) + a world distance, which this
 * summary screen doesn't capture. CHECK therefore marks the sheet verified
 * LOCALLY (so the gate is exercisable); real calibration belongs to the canvas
 * two-point picker. AI scale auto-detect (a per-page suggested scale +
 * confidence) is also not an API today.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MButton, MI, Spark } from '../../components/m/index.js'
import { useBlueprintPages, useProjectBlueprints } from '../../lib/api/takeoff.js'

type ScaleSheet = {
  /** Real blueprint_pages.id when backed by data; synthetic for fallback. */
  id: string
  code: string
  label: string
  scale: string
  verified: boolean
  /** Locally-checked this session (real calibration would need the canvas picker). */
  locallyChecked?: boolean
}

export function TakeoffAutoscale({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  // Real blueprint data: the project's latest blueprint document + its pages.
  const blueprintsQuery = useProjectBlueprints(projectId)
  const latestDoc = (blueprintsQuery.data?.blueprints ?? []).filter((b) => !b.deleted_at).at(-1) ?? null
  const docScale = latestDoc?.sheet_scale ?? null
  const pagesQuery = useBlueprintPages(latestDoc?.id ?? null)

  // Map real pages into the sheet list. A page is "verified" when its
  // two-point calibration has been set. Scale text prefers the page's own
  // world unit/distance, falling back to the document's sheet_scale.
  const pages = pagesQuery.data?.pages ?? []
  const dataSheets = useMemo<ScaleSheet[]>(
    () =>
      pages.map((p) => {
        const calibrated = Boolean(p.calibration_set_at)
        const scaleText =
          calibrated && p.calibration_world_distance
            ? `${p.calibration_world_distance} ${p.calibration_world_unit ?? ''}`.trim()
            : (docScale ?? 'UNSET')
        return {
          id: p.id,
          code: `P-${p.page_number}`,
          label: `PAGE ${p.page_number}`,
          scale: scaleText,
          verified: calibrated,
        }
      }),
    [pages, docScale],
  )

  // Local CHECK overlay so the verify gate is exercisable even though true
  // calibration needs the canvas picker (see header GAP).
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const check = (id: string) => setChecked((prev) => ({ ...prev, [id]: true }))

  const sheets = useMemo<ScaleSheet[]>(
    () => dataSheets.map((s) => (checked[s.id] ? { ...s, verified: true, locallyChecked: true } : s)),
    [dataSheets, checked],
  )

  const totalSheets = sheets.length
  const verifiedInList = useMemo(() => sheets.filter((s) => s.verified).length, [sheets])
  const toReview = Math.max(totalSheets - verifiedInList, 0)
  const allVerified = totalSheets > 0 && toReview === 0

  const back = () => navigate(`/projects/${projectId}/takeoff-ai/ingest`)
  const openTakeoff = () => navigate(`/projects/${projectId}/takeoff-mobile`)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="m-topbar">
        <button type="button" className="m-topbar-back" aria-label="Back" onClick={back}>
          <MI.ChevLeft size={22} />
        </button>
        <div className="m-topbar-title">
          <div className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-flex', gap: 5 }}>
            <Spark size={11} state="strong" /> AI AUTOSCALE
          </div>
          <div className="m-h1">VERIFY SCALES</div>
        </div>
      </div>

      {/* N / 22 verified counter */}
      <div style={{ padding: '18px 20px', borderBottom: '2px solid var(--m-ink)' }}>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 42,
            lineHeight: 0.9,
            letterSpacing: '-0.025em',
            color: 'var(--m-ink)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {verifiedInList}
          <span style={{ color: 'var(--m-ink-3)' }}> / {totalSheets}</span>
        </div>
        <div
          style={{ fontFamily: 'var(--m-num)', fontSize: 12, marginTop: 6, fontWeight: 600, color: 'var(--m-ink-2)' }}
        >
          VERIFIED · {toReview} TO REVIEW
        </div>
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            marginTop: 14,
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1.45,
          }}
        >
          Tap each sheet to confirm. Takeoff quantities won&apos;t be trusted until every sheet is verified.
        </div>
      </div>

      {/* Per-sheet scale list (real blueprint pages) */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {pagesQuery.isLoading || blueprintsQuery.isLoading ? (
          <div
            style={{ padding: 20, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600 }}
          >
            Loading sheets…
          </div>
        ) : null}
        {!pagesQuery.isLoading && !blueprintsQuery.isLoading && totalSheets === 0 ? (
          <div
            style={{ padding: 20, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600 }}
          >
            {latestDoc ? 'This blueprint has no pages to verify.' : 'No blueprint uploaded yet.'}
          </div>
        ) : null}
        {sheets.map((s) => (
          <div
            key={s.id}
            style={{
              padding: '14px 20px',
              borderBottom: '1px solid var(--m-line-2)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <span
              style={{
                width: 36,
                height: 36,
                background: s.verified ? 'var(--m-green)' : 'transparent',
                color: s.verified ? '#fff' : 'var(--m-ink-3)',
                border: '2px solid var(--m-ink)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 16,
                flexShrink: 0,
              }}
              aria-hidden
            >
              {s.verified ? '✓' : '○'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700, color: 'var(--m-ink-3)' }}>
                  {s.code}
                </span>
                <span style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 }}>{s.label}</span>
              </div>
              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  marginTop: 3,
                  color: 'var(--m-ink)',
                }}
              >
                {s.scale}
                {s.locallyChecked ? ' · CHECKED' : s.verified ? ' · CALIBRATED' : ' · NEEDS SCALE'}
              </div>
            </div>
            {!s.verified ? (
              <button
                type="button"
                onClick={() => check(s.id)}
                style={{
                  padding: '8px 12px',
                  background: 'var(--m-ink)',
                  color: 'var(--m-sand)',
                  border: '2px solid var(--m-ink)',
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  cursor: 'pointer',
                }}
              >
                CHECK
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div style={{ padding: '16px 20px', borderTop: '2px solid var(--m-ink)' }}>
        <MButton variant={allVerified ? 'primary' : 'ghost'} onClick={openTakeoff} disabled={!allVerified}>
          {allVerified ? 'Open takeoff' : `Open takeoff · ${toReview} sheets left`}
        </MButton>
      </div>
    </div>
  )
}
