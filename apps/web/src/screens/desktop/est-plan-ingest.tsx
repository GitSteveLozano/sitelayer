/**
 * Estimator desktop · Plan ingest (Desktop v2 · dsg__44 "Reading the plan
 * set…" / dsg__45 "Plan set ready.").
 *
 * The desktop counterpart of mobile `takeoff-ingest.tsx` (`TakeoffIngest`).
 * One routable full-page screen — mounted in `desktop-workspace.tsx` at
 * `/desktop/ingest/:projectId` — that walks the three ingest states so the
 * estimator desktop flow shows ingest BEFORE the canvas:
 *   - parsing — step progress rail (PDF uploaded → sheets detected →
 *     cross-sheet refs → scale auto-detect → scope pre-classify) + a yellow
 *     "PARSING · 22S LEFT" badge and a determinate progress bar (dsg__44).
 *   - done    — every step ✓, "Plan set ready." → CONFIRM SCALE · START
 *     TAKEOFF / REVIEW SHEETS FIRST (dsg__45).
 *   - failed  — no-text-layer error + manual-fallback / upload-better /
 *     email-architect CTAs + the other failure modes.
 *
 * Like the mobile screen, the "PDF uploaded" / "sheets detected" steps and the
 * detected-sheets grid are backed by REAL blueprint data: the primary
 * (first non-deleted) blueprint document for the project (useProjectBlueprints)
 * and its real page list (useBlueprintPages). The file name + size + sheet
 * count + per-page sheet labels are pulled from those.
 *
 * GAP (same as mobile): there is no live parsing-progress STREAM (cross-sheet
 * ref linking, scale auto-detect, scope pre-classify are not exposed as a
 * progress feed), so the parsing/done/failed states stay selectable via
 * `?state=parsing|done|failed` (+ a dev toggle) and the sub-step copy stays
 * presentational. A SSE/poll ingest-progress endpoint is the suggested fill.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton } from '@/components/m'
import { useBlueprintPages, useProjectBlueprints, type BlueprintDocument, type BlueprintPage } from '@/lib/api/takeoff'

type IngestState = 'parsing' | 'done' | 'failed'

type IngestStep = {
  label: string
  done: boolean
  active?: boolean | undefined
  queued?: boolean | undefined
  sub?: string | undefined
}

function stepsFor(isDone: boolean, sheetCount: number | null): IngestStep[] {
  const sheetLabel =
    sheetCount != null ? `${sheetCount} SHEET${sheetCount === 1 ? '' : 'S'} DETECTED` : 'SHEETS DETECTED'
  return [
    {
      label: 'PDF UPLOADED',
      done: true,
      sub: undefined,
    },
    {
      label: sheetLabel,
      done: sheetCount != null,
      active: sheetCount == null && !isDone,
      // Honest sub-copy: title blocks are read to detect the sheets.
      sub: sheetCount != null ? 'Title blocks read · A-series + S-series' : 'reading title blocks…',
    },
    {
      label: 'CROSS-SHEET REFERENCES',
      done: isDone,
      active: !isDone && sheetCount != null,
      // No callout-extraction feed exists yet, so keep this honest: it links
      // detail callouts across the detected sheets once parsing completes.
      sub: isDone
        ? sheetCount != null
          ? `linking callouts across ${sheetCount} sheets`
          : 'callouts linked'
        : 'scanning callouts…',
    },
    {
      label: 'SCALE AUTO-DETECT',
      done: isDone,
      active: !isDone,
      sub: isDone
        ? sheetCount != null
          ? `${sheetCount} of ${sheetCount} sheets · review needed`
          : 'review needed'
        : 'reading title-block scale bars…',
    },
    {
      label: 'SCOPE PRE-CLASSIFY',
      done: isDone,
      queued: !isDone,
      sub: isDone ? 'EPS · basecoat · stone · plumbing' : 'queued',
    },
  ]
}

/** Human "12.4 MB" / "812 KB" from a byte count (best-effort; blueprints carry
 *  no size in the API row, so this is only used when a size is known). */
function formatBytes(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** A short sheet label for a thumbnail tile ("A-101" style). The API page row
 *  has no sheet-number/title field yet, so derive a stable "PG N" label until
 *  a real title-block sheet number lands. */
function sheetTile(p: BlueprintPage): string {
  return `PG ${p.page_number}`
}

export function EstPlanIngest() {
  const { projectId: projectIdParam } = useParams<{ projectId: string }>()
  const projectId = projectIdParam ?? ''
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Real blueprint data: primary (first non-deleted) doc for the project + its
  // pages — the same shape est-scale-verify + the canvas resolve sheets from.
  const blueprintsQuery = useProjectBlueprints(projectId)
  const primaryDoc = useMemo<BlueprintDocument | null>(() => {
    const docs = (blueprintsQuery.data?.blueprints ?? []).filter((b) => !b.deleted_at)
    return docs[0] ?? null
  }, [blueprintsQuery.data?.blueprints])
  const pagesQuery = useBlueprintPages(primaryDoc?.id ?? null)
  const pages = pagesQuery.data?.pages ?? []
  const sheetCount = pagesQuery.data ? pages.length : null
  const fileName = primaryDoc?.file_name ?? null
  // No file_size travels in the BlueprintDocument row; left null (the header
  // collapses the size segment when unknown rather than fabricating one).
  const fileSize = formatBytes(null)

  const stateParam = (searchParams.get('state') as IngestState | null) ?? 'parsing'
  const [state, setStateLocal] = useState<IngestState>(stateParam)
  const setState = (s: IngestState) => {
    setStateLocal(s)
    const sp = new URLSearchParams(searchParams)
    sp.set('state', s)
    setSearchParams(sp, { replace: true })
  }

  const back = () => navigate('/desktop/takeoff')

  if (state === 'failed') {
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Plan ingest · From a blueprint</DEyebrow>
            <DH1>Plan ingest failed.</DH1>
          </div>

          {/* Error banner — red, mirrors the mobile failure copy. */}
          <div
            style={{
              padding: '20px 22px',
              background: 'var(--m-red)',
              color: '#fff',
              border: '2px solid var(--m-ink)',
            }}
          >
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em' }}>
              ● COULDN&apos;T PARSE
            </div>
            <div
              style={{
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 30,
                lineHeight: 1,
                marginTop: 12,
              }}
            >
              This PDF has no text layer.
            </div>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 12,
                marginTop: 10,
                color: 'rgba(255,255,255,.85)',
                fontWeight: 600,
                lineHeight: 1.5,
              }}
            >
              SCANNED OR IMAGE-ONLY · WE CAN&apos;T READ TITLE BLOCKS OR SCALES AUTOMATICALLY.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <MButton variant="primary" onClick={() => projectId && navigate(`/desktop/canvas/${projectId}`)}>
              Proceed · enter scales manually
            </MButton>
            <MButton variant="ghost" onClick={() => projectId && navigate(`/desktop/canvas/${projectId}`)}>
              Upload a better file
            </MButton>
            <MButton variant="ghost" onClick={back}>
              Email the architect
            </MButton>
          </div>

          <div
            style={{
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card-soft)',
              padding: '14px 16px',
            }}
          >
            <div
              className="d-eyebrow"
              style={{ color: 'var(--m-ink-3)', display: 'block', fontSize: 10, letterSpacing: '0.1em' }}
            >
              OTHER FAILURE MODES
            </div>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                marginTop: 8,
                color: 'var(--m-ink-2)',
                fontWeight: 600,
                lineHeight: 1.6,
              }}
            >
              · CORRUPT / TRUNCATED
              <br />· ENCRYPTED (NEEDS PASSWORD)
              <br />· OVERSIZED (&gt; 200MB)
              <br />· UNSUPPORTED FORMAT
            </div>
          </div>

          <DevStateToggle state={state} onChange={setState} />
        </div>
      </div>
    )
  }

  const isParsing = state === 'parsing'
  const isDone = state === 'done'
  const steps = stepsFor(isDone, sheetCount)
  // Determinate progress: each completed step is one unit; the active step adds
  // a half-step so the bar moves before parsing finishes (dsg__44 bar).
  const doneSteps = steps.filter((s) => s.done).length
  const hasActive = steps.some((s) => s.active)
  const progressPct = isDone
    ? 100
    : Math.min(95, Math.round(((doneSteps + (hasActive ? 0.5 : 0)) / steps.length) * 100))

  return (
    <div className="d-content">
      <div className="d-stack">
        {/* Heading + state badge */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <DEyebrow>From a blueprint · Step 2 of 2</DEyebrow>
            <DH1>{isDone ? 'Plan set ready.' : 'Reading the plan set…'}</DH1>
          </div>
          <span
            style={{
              flexShrink: 0,
              marginTop: 6,
              padding: '6px 12px',
              background: isDone ? 'var(--m-green)' : 'var(--m-accent)',
              color: isDone ? '#fff' : 'var(--m-accent-ink)',
              border: '2px solid var(--m-ink)',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: '0.06em',
              whiteSpace: 'nowrap',
            }}
          >
            {isDone ? '■ PARSED' : '■ PARSING · 22S LEFT'}
          </span>
        </div>

        {/* Two columns: detected-sheets card (left) + AI INGEST step rail (right) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 360px)', gap: 18 }}>
          {/* Left: PDF doc header + detected-sheets grid */}
          <div style={{ border: '2px solid var(--m-ink)', minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '14px 16px',
                borderBottom: '2px solid var(--m-ink)',
              }}
            >
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 44,
                  height: 44,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--m-accent)',
                  color: 'var(--m-accent-ink)',
                  fontFamily: 'var(--m-num)',
                  fontWeight: 800,
                  fontSize: 12,
                }}
              >
                PDF
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 700,
                    fontSize: 15,
                    color: 'var(--m-ink)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {blueprintsQuery.isPending
                    ? 'Loading blueprint…'
                    : fileName
                      ? fileName.toUpperCase()
                      : 'NO BLUEPRINT UPLOADED YET'}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 11,
                    color: 'var(--m-ink-3)',
                    fontWeight: 600,
                    marginTop: 3,
                  }}
                >
                  {[fileSize, sheetCount != null ? `${sheetCount} PAGES` : null].filter(Boolean).join(' · ') ||
                    'PARSING…'}
                </div>
              </div>
              <MButton size="sm" variant="ghost" onClick={() => projectId && navigate(`/desktop/canvas/${projectId}`)}>
                Replace
              </MButton>
            </div>

            <div style={{ padding: '14px 16px' }}>
              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: 'var(--m-ink-3)',
                  fontWeight: 700,
                  marginBottom: 12,
                }}
              >
                Detected sheets{sheetCount != null ? ` · ${sheetCount}` : ''}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                {pages.length === 0
                  ? // No pages yet — show 4 skeleton tiles so the grid reads as
                    // "detecting" rather than empty (matches the dsg__44 trailing
                    // placeholder tiles).
                    Array.from({ length: 4 }).map((_, i) => <SheetTile key={`skeleton-${i}`} label="…" muted />)
                  : pages.map((p) => <SheetTile key={p.id} label={sheetTile(p)} />)}
              </div>
            </div>
          </div>

          {/* Right: AI INGEST step rail (dark head + step list) */}
          <div style={{ border: '2px solid var(--m-ink)', minWidth: 0, alignSelf: 'start' }}>
            <div
              style={{
                background: 'var(--m-ink)',
                color: 'var(--m-sand)',
                padding: '12px 16px',
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: '0.08em',
              }}
            >
              ● AI INGEST
            </div>
            {steps.map((s) => (
              <div
                key={s.label}
                style={{
                  padding: '14px 16px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  borderTop: '1px solid var(--m-line-2)',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 26,
                    height: 26,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: s.done ? 'var(--m-green)' : s.active ? 'var(--m-accent)' : 'transparent',
                    color: s.done ? '#fff' : s.active ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                    border: s.queued ? '2px solid var(--m-line-2)' : '2px solid var(--m-ink)',
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 800,
                    fontSize: 13,
                  }}
                >
                  {s.done ? '✓' : s.active ? '●' : ''}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: 'var(--m-font-display)',
                      fontWeight: 700,
                      fontSize: 13,
                      letterSpacing: '-0.005em',
                      color: s.queued ? 'var(--m-ink-3)' : 'var(--m-ink)',
                    }}
                  >
                    {s.label}
                  </div>
                  {s.sub ? (
                    <div
                      style={{
                        fontFamily: 'var(--m-num)',
                        fontSize: 10,
                        color: 'var(--m-ink-3)',
                        marginTop: 3,
                        fontWeight: 600,
                      }}
                    >
                      {s.sub}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer: progress bar + CTAs (parsing) / start-takeoff CTAs (done) */}
        {isParsing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                flex: 1,
                height: 14,
                border: '2px solid var(--m-ink)',
                background: 'var(--m-card-soft)',
                overflow: 'hidden',
              }}
              role="progressbar"
              aria-valuenow={progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--m-accent)' }} />
            </div>
            <MButton variant="ghost" onClick={back}>
              Cancel
            </MButton>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <MButton variant="primary" onClick={() => projectId && navigate(`/desktop/scale/${projectId}`)}>
              Confirm scale · Start takeoff →
            </MButton>
            <MButton variant="ghost" onClick={() => projectId && navigate(`/desktop/scale/${projectId}`)}>
              Review sheets first
            </MButton>
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
                fontWeight: 700,
              }}
            >
              Next · Scale verify → Canvas
            </span>
          </div>
        )}

        <DevStateToggle state={state} onChange={setState} />
      </div>
    </div>
  )
}

/** A faint hatched thumbnail tile with a sheet label underneath. */
function SheetTile({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <div>
      <div
        aria-hidden
        style={{
          height: 64,
          border: '1.5px solid var(--m-line-2)',
          background:
            'repeating-linear-gradient(45deg, var(--m-card-soft) 0 6px, transparent 6px 12px) var(--m-card-soft)',
          opacity: muted ? 0.5 : 1,
        }}
      />
      <div
        style={{
          textAlign: 'center',
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          color: muted ? 'var(--m-ink-3)' : 'var(--m-ink-2)',
          marginTop: 6,
        }}
      >
        {label}
      </div>
    </div>
  )
}

/**
 * Small state selector so each ingest state is reachable without a live
 * pipeline. The states are real product states (parsing/done/failed) — this
 * just stands in for the pipeline events that would drive them. Mirrors the
 * mobile `DevStateToggle`.
 */
function DevStateToggle({ state, onChange }: { state: IngestState; onChange: (s: IngestState) => void }) {
  return (
    <div style={{ display: 'flex', border: '2px solid var(--m-ink)', maxWidth: 360, background: 'var(--m-card-soft)' }}>
      {(['parsing', 'done', 'failed'] as const).map((s, i, arr) => {
        const on = state === s
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            aria-pressed={on}
            style={{
              flex: 1,
              padding: '8px 0',
              background: on ? 'var(--m-ink)' : 'transparent',
              color: on ? 'var(--m-sand)' : 'var(--m-ink-3)',
              border: 'none',
              borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            {s}
          </button>
        )
      })}
    </div>
  )
}
