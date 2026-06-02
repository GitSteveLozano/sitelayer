import { useEffect, useMemo, useState } from 'react'
import { Banner, Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import { MEmptyState } from '@/components/m-states'
import { Attribution } from '@/components/ai'
import {
  API_URL,
  useBlueprintDiffs,
  useProjectBlueprints,
  useProjectMeasurements,
  type BlueprintDocument,
  type TakeoffMeasurement,
} from '@/lib/api'
import { useAuthenticatedObjectUrl } from '@/lib/api/blob-url'
import { blueprintReferenceKind } from '@/lib/takeoff/blueprint-reference'
import { computeRasterDiff, type DiffMode, type DiffResult } from '@/lib/blueprint-diff'

/**
 * `prj-revision-compare-stub` — plan revision compare overlay.
 *
 * Ships a working visual diff. A revision picker selects the before/after
 * blueprint pair and the surface renders a live comparison:
 *
 *   - Client-side raster diff (approach #2, live): both revisions' page
 *     images are loaded as authenticated object URLs, drawn onto a canvas,
 *     and compared per-pixel by perceived luminance. Ink added between
 *     revisions reads BLUE; ink removed reads RED. The estimator gets an
 *     opacity slider plus an Overlay / Side-by-side / Difference toggle.
 *   - Stored diffs (approach #1): `blueprint_page_diffs` (migration 037)
 *     exists, but no API route serves those rows yet, so nothing reads the
 *     stored diffs today. When that endpoint lands, `RevisionDiffSurface`
 *     is where it plugs in.
 *
 * Limitation: the raster diff only runs on image revisions (PNG/JPG/WEBP).
 * PDF revisions can't be rasterized client-side here (no pdf.js in the
 * bundle), so for PDF pairs the surface falls back to side-by-side links.
 *
 * The export name `RevisionCompareStub` is kept so the single importer
 * (takeoff-canvas.tsx) is not broken.
 */
export interface RevisionCompareStubProps {
  open: boolean
  onClose: () => void
  projectId: string
  /** Optional preselected "after" blueprint (the one currently on canvas). */
  initialAfterId?: string | null
}

export function RevisionCompareStub({ open, onClose, projectId, initialAfterId }: RevisionCompareStubProps) {
  const blueprints = useProjectBlueprints(projectId)
  const list: BlueprintDocument[] = useMemo(
    () => [...(blueprints.data?.blueprints ?? [])].sort((a, b) => b.version - a.version),
    [blueprints.data],
  )

  const [afterId, setAfterId] = useState<string>(initialAfterId ?? '')
  const [beforeId, setBeforeId] = useState<string>('')

  // Default the dropdown to the latest pair (current vs. its
  // replaces-target) once the list lands.
  useEffect(() => {
    if (!open || list.length === 0) return
    const after = initialAfterId ? list.find((b) => b.id === initialAfterId) : list[0]
    if (!after) return
    setAfterId((prev) => prev || after.id)
    const before = after.replaces_blueprint_document_id
      ? list.find((b) => b.id === after.replaces_blueprint_document_id)
      : list.find((b) => b.id !== after.id)
    if (before) setBeforeId((prev) => prev || before.id)
  }, [open, initialAfterId, list])

  const after = list.find((b) => b.id === afterId)
  const before = list.find((b) => b.id === beforeId)

  return (
    <Sheet open={open} onClose={onClose} title="Compare revisions">
      <div className="space-y-3">
        {blueprints.isPending ? (
          <div className="text-[12px] text-ink-3">Loading revisions…</div>
        ) : list.length < 2 ? (
          <MEmptyState
            title="Only one revision uploaded"
            body="Compare needs at least two blueprint versions on this project. Upload a re-issued plan to enable side-by-side diffing."
            primaryLabel="Close"
            onPrimary={onClose}
          />
        ) : (
          <>
            <Card tight>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Before</label>
              <select
                value={beforeId}
                onChange={(e) => setBeforeId(e.target.value)}
                className="mt-1 w-full text-[14px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
              >
                <option value="">— pick a revision —</option>
                {list.map((b) => (
                  <option key={b.id} value={b.id}>
                    v{b.version} · {b.file_name}
                  </option>
                ))}
              </select>

              <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mt-3">
                After
              </label>
              <select
                value={afterId}
                onChange={(e) => setAfterId(e.target.value)}
                className="mt-1 w-full text-[14px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
              >
                <option value="">— pick a revision —</option>
                {list.map((b) => (
                  <option key={b.id} value={b.id}>
                    v{b.version} · {b.file_name}
                  </option>
                ))}
              </select>
            </Card>

            <AffectedMeasurementsBadge projectId={projectId} after={after} />

            <RevisionDiffSurface before={before} after={after} />
          </>
        )}

        <div className="pt-1">
          <MobileButton variant="ghost" onClick={onClose}>
            Close
          </MobileButton>
        </div>

        <Attribution source="GET /api/projects/:id/blueprints · GET /api/blueprints/:id/file · GET /api/blueprints/:id/diffs (037 blueprint_page_diffs) · client-side raster diff" />
      </div>
    </Sheet>
  )
}

interface AffectedMeasurementsBadgeProps {
  projectId: string
  after: BlueprintDocument | undefined
}

/**
 * "N measurements affected" badge — consumes the stored
 * `blueprint_page_diffs.affected_measurement_ids` served by
 * `GET /api/blueprints/:id/diffs`. The diffs are keyed to the newer
 * revision's document, so this reads the currently-selected **after**
 * blueprint.
 *
 * When no diff rows have been populated for the revision (no image-diff
 * worker has run, or this revision introduced no overlapping changes) the
 * route returns an empty rollup and this component renders nothing — the
 * badge hides. Diff population is a follow-up slice; this surfaces what the
 * raster-diff/worker has persisted.
 *
 * "Links the affected measurements" by resolving each affected id against the
 * project's measurements and listing its service item + quantity, so the
 * estimator can see exactly which takeoff items live on changed regions.
 */
function AffectedMeasurementsBadge({ projectId, after }: AffectedMeasurementsBadgeProps) {
  const diffs = useBlueprintDiffs(after?.id)
  const measurements = useProjectMeasurements(projectId)
  const [expanded, setExpanded] = useState(false)

  const affectedIds = diffs.data?.affected_measurement_ids ?? []
  const count = diffs.data?.affected_measurement_count ?? affectedIds.length

  // Resolve the affected ids to live measurement rows so we can show what
  // each one measures. Ids with no matching row (soft-deleted since the diff
  // was cached) are surfaced as a bare id so the count still reconciles.
  const byId = useMemo(() => {
    const map = new Map<string, TakeoffMeasurement>()
    for (const m of measurements.data?.measurements ?? []) map.set(m.id, m)
    return map
  }, [measurements.data])

  // Nothing to show until the diffs land and at least one measurement is
  // flagged — the badge hides on an empty result (no rows populated yet).
  if (diffs.isPending || count === 0) return null

  return (
    <Banner
      tone="warn"
      title={
        <span className="inline-flex items-center gap-2">
          <Pill tone="warn" withDot>
            {count} measurement{count === 1 ? '' : 's'} affected
          </Pill>
        </span>
      }
      action={
        affectedIds.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[12px] font-semibold text-accent"
          >
            {expanded ? 'Hide' : 'Show'}
          </button>
        ) : null
      }
    >
      <div>
        This revision changed regions overlapping {count} saved takeoff measurement{count === 1 ? '' : 's'}.
      </div>
      {expanded ? (
        <ul className="mt-2 space-y-1">
          {affectedIds.map((id) => {
            const m = byId.get(id)
            return (
              <li key={id} className="flex items-center justify-between gap-2 text-[12px]">
                {m ? (
                  <>
                    <span className="font-medium truncate">{m.service_item_code}</span>
                    <span className="tabular-nums text-ink-3 shrink-0">
                      {m.quantity} {m.unit}
                    </span>
                  </>
                ) : (
                  <span className="font-mono text-ink-3 truncate">{id}</span>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </Banner>
  )
}

interface RevisionDiffSurfaceProps {
  before: BlueprintDocument | undefined
  after: BlueprintDocument | undefined
}

/**
 * The visual comparison surface. Loads both revisions' files as
 * authenticated object URLs; when both are images it runs the raster diff
 * and renders an interactive overlay. PDF pairs fall back to side-by-side
 * open-file cards.
 */
function RevisionDiffSurface({ before, after }: RevisionDiffSurfaceProps) {
  const [mode, setMode] = useState<DiffMode>('overlay')
  const [opacity, setOpacity] = useState(0.7)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [computing, setComputing] = useState(false)

  const beforePath = before ? `/api/blueprints/${encodeURIComponent(before.id)}/file` : null
  const afterPath = after ? `/api/blueprints/${encodeURIComponent(after.id)}/file` : null

  const beforeBlob = useAuthenticatedObjectUrl(beforePath)
  const afterBlob = useAuthenticatedObjectUrl(afterPath)

  const beforeIsImage = before ? blueprintReferenceKind(before.file_name) === 'image' : false
  const afterIsImage = after ? blueprintReferenceKind(after.file_name) === 'image' : false
  const bothImages = beforeIsImage && afterIsImage

  // Recompute the raster diff whenever the underlying object URLs change.
  useEffect(() => {
    setDiff(null)
    setDiffError(null)
    if (!bothImages || !beforeBlob.url || !afterBlob.url) return

    let cancelled = false
    setComputing(true)
    void computeRasterDiff(beforeBlob.url, afterBlob.url)
      .then((result) => {
        if (cancelled) return
        setDiff(result)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setDiffError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setComputing(false)
      })

    return () => {
      cancelled = true
    }
  }, [bothImages, beforeBlob.url, afterBlob.url])

  if (!before || !after) {
    return (
      <Card tight>
        <div className="text-[12px] text-ink-3">
          Pick a Before and After revision to compare. The latest pair is selected automatically when both exist.
        </div>
      </Card>
    )
  }

  if (before.id === after.id) {
    return (
      <Banner tone="info" title="Same revision picked">
        Before and After point at the same blueprint — choose two different versions to see what changed.
      </Banner>
    )
  }

  const loading = beforeBlob.loading || afterBlob.loading || computing
  const loadError = beforeBlob.error?.message ?? afterBlob.error?.message ?? diffError

  // PDF (or otherwise non-rasterizable) revisions: fall back to side-by-side
  // links rather than failing silently.
  if (!bothImages) {
    return (
      <>
        <Banner tone="info" title="Raster diff needs image pages">
          One or both revisions are PDFs. Client-side pixel diff runs on image pages (PNG/JPG/WEBP); for PDF pairs open
          the files side-by-side below. (When the image-diff worker ships, stored diffs will render here.)
        </Banner>
        <div className="grid grid-cols-2 gap-2">
          <RevisionPreview label="Before" doc={before} />
          <RevisionPreview label="After" doc={after} />
        </div>
      </>
    )
  }

  return (
    <div className="space-y-2">
      <ModeToggle mode={mode} onChange={setMode} />

      {mode === 'overlay' ? (
        <div className="px-1">
          <label className="flex items-center justify-between text-[11px] text-ink-3">
            <span>Overlay opacity</span>
            <span className="tabular-nums">{Math.round(opacity * 100)}%</span>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="w-full mt-1 accent-accent"
            aria-label="Overlay opacity"
          />
        </div>
      ) : null}

      {loading ? (
        <Card tight>
          <div className="text-[12px] text-ink-3">Computing visual diff…</div>
        </Card>
      ) : loadError ? (
        <Banner tone="warn" title="Couldn't build the diff">
          {loadError}
        </Banner>
      ) : (
        <>
          {diff ? <DiffLegend diff={diff} /> : null}
          <Card tight className="overflow-hidden">
            {mode === 'side-by-side' ? (
              <div className="grid grid-cols-2 gap-1">
                <LabeledImage label={`Before · v${before.version}`} url={beforeBlob.url} />
                <LabeledImage label={`After · v${after.version}`} url={afterBlob.url} />
              </div>
            ) : mode === 'difference' ? (
              diff ? (
                <img src={diff.differenceDataUrl} alt="Difference view" className="w-full h-auto block" />
              ) : null
            ) : (
              // overlay
              <div className="relative">
                {afterBlob.url ? (
                  <img src={afterBlob.url} alt="After revision" className="w-full h-auto block" />
                ) : null}
                {diff ? (
                  <img
                    src={diff.overlayDataUrl}
                    alt="Change overlay"
                    className="absolute inset-0 w-full h-full"
                    style={{ opacity, mixBlendMode: 'multiply' }}
                  />
                ) : null}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

function ModeToggle({ mode, onChange }: { mode: DiffMode; onChange: (m: DiffMode) => void }) {
  const options: Array<{ key: DiffMode; label: string }> = [
    { key: 'overlay', label: 'Overlay' },
    { key: 'side-by-side', label: 'Side-by-side' },
    { key: 'difference', label: 'Difference' },
  ]
  return (
    <div className="flex gap-1 rounded-lg bg-card-soft p-1">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={`flex-1 text-[12px] font-semibold py-1.5 rounded-md transition-colors ${
            mode === opt.key ? 'bg-accent text-white' : 'text-ink-3'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function DiffLegend({ diff }: { diff: DiffResult }) {
  const pct = (diff.changedFraction * 100).toFixed(diff.changedFraction < 0.01 ? 2 : 1)
  return (
    <div className="flex items-center gap-2 flex-wrap text-[11px] text-ink-3 px-1">
      <span className="inline-flex items-center gap-1">
        <span className="inline-block w-3 h-3 rounded-sm" style={{ background: 'rgb(37,99,235)' }} /> Added
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block w-3 h-3 rounded-sm" style={{ background: 'rgb(220,38,38)' }} /> Removed
      </span>
      <Pill tone={diff.changedFraction > 0.001 ? 'warn' : 'default'}>{pct}% changed</Pill>
    </div>
  )
}

function LabeledImage({ label, url }: { label: string; url: string | null }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1">{label}</div>
      {url ? (
        <img src={url} alt={label} className="w-full h-auto block rounded" />
      ) : (
        <div className="text-[12px] text-ink-3">No image.</div>
      )}
    </div>
  )
}

interface RevisionPreviewProps {
  label: string
  doc: BlueprintDocument | undefined
}

function RevisionPreview({ label, doc }: RevisionPreviewProps) {
  return (
    <Card tight>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      {doc ? (
        <div className="mt-1">
          <div className="text-[13px] font-semibold truncate">v{doc.version}</div>
          <div className="text-[11px] text-ink-3 truncate">{doc.file_name}</div>
          <a
            href={`${API_URL}/api/blueprints/${encodeURIComponent(doc.id)}/file`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[12px] font-semibold text-accent"
          >
            Open file →
          </a>
        </div>
      ) : (
        <div className="mt-1 text-[12px] text-ink-3">No revision selected.</div>
      )}
    </Card>
  )
}
