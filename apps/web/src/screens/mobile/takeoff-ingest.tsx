/**
 * `mb-takeoff-ingest` — mobile plan-ingest progress / done / failed.
 *
 * Ported from Steve's v2 master-flow mockup `V2EstPlanIngest`
 * ("INGEST · PARSING" / "INGEST · DONE") and `V2IngestFailure`
 * ("INGEST · FAILED") for MOBILE. One routable screen that walks the three
 * ingest states:
 *   - parsing — step progress: PDF uploaded → sheets detected → cross-sheet
 *     refs → scale auto-detect → scope pre-classify (a "~22s remaining" note).
 *   - done    — every step ✓, "Plan set ready" → CONFIRM SCALE · START TAKEOFF.
 *   - failed  — no-text-layer error + manual-fallback / upload-better /
 *     email-architect CTAs + the other failure modes.
 *
 * Partially wired. The "PDF uploaded" / "sheets detected" steps and the
 * done-state are now backed by REAL blueprint data: the latest uploaded
 * blueprint document for the project (useProjectBlueprints) and its real page
 * list (useBlueprintPages). The file name + sheet count are pulled from those.
 *
 * GAP: there is no live parsing-progress STREAM (cross-sheet ref linking,
 * scale auto-detect, scope pre-classify are not exposed as a progress feed),
 * so the parsing/done/failed states remain selectable via
 * `?state=parsing|done|failed` (+ a dev toggle) and the sub-step copy stays
 * presentational. A SSE/poll ingest-progress endpoint is the suggested fill.
 */
import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { MButton, MButtonStack, MI, Spark } from '../../components/m/index.js'
import { useBlueprintPages, useProjectBlueprints } from '../../lib/api/takeoff.js'

type IngestState = 'parsing' | 'done' | 'failed'

type IngestStep = {
  label: string
  done: boolean
  active?: boolean | undefined
  queued?: boolean | undefined
  sub?: string | undefined
}

function stepsFor(isDone: boolean, sheetCount: number | null): IngestStep[] {
  const sheetLabel = sheetCount != null ? `${sheetCount} SHEET${sheetCount === 1 ? '' : 'S'} DETECTED` : 'SHEETS DETECTED'
  return [
    { label: 'PDF UPLOADED', done: true },
    { label: sheetLabel, done: sheetCount != null, active: sheetCount == null && !isDone },
    { label: 'CROSS-SHEET REFERENCES', done: true, sub: '8 callouts linked' },
    {
      label: 'SCALE AUTO-DETECT',
      done: isDone,
      active: !isDone,
      sub: isDone
        ? sheetCount != null
          ? `${sheetCount} of ${sheetCount} sheets · review needed`
          : 'review needed'
        : 'reading title blocks…',
    },
    {
      label: 'SCOPE PRE-CLASSIFY',
      done: isDone,
      queued: !isDone,
      sub: isDone ? 'EPS · base · stone · plumbing' : undefined,
    },
  ]
}

export function TakeoffIngest({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const [searchParams, setSearchParams] = useSearchParams()

  // Real blueprint data: latest uploaded doc for the project + its pages.
  const blueprintsQuery = useProjectBlueprints(projectId)
  const latestDoc = (blueprintsQuery.data?.blueprints ?? []).filter((b) => !b.deleted_at).at(-1) ?? null
  const pagesQuery = useBlueprintPages(latestDoc?.id ?? null)
  const sheetCount = pagesQuery.data?.pages.length ?? null
  const fileName = latestDoc?.file_name ?? null

  const stateParam = (searchParams.get('state') as IngestState | null) ?? 'parsing'
  const [state, setStateLocal] = useState<IngestState>(stateParam)
  const setState = (s: IngestState) => {
    setStateLocal(s)
    const sp = new URLSearchParams(searchParams)
    sp.set('state', s)
    setSearchParams(sp, { replace: true })
  }

  const back = () => navigate(`/projects/${projectId}/takeoff-ai`)

  if (state === 'failed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div className="m-topbar">
          <button type="button" className="m-topbar-back" aria-label="Back" onClick={back}>
            <MI.ChevLeft size={22} />
          </button>
          <div className="m-topbar-title">
            <div className="m-h1">PLAN INGEST FAILED</div>
          </div>
        </div>

        {/* Error banner */}
        <div style={{ padding: '24px 20px', background: 'var(--m-red)', color: '#fff', borderBottom: '2px solid var(--m-ink)' }}>
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em' }}>● COULDN&apos;T PARSE</div>
          <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 32, lineHeight: 0.95, marginTop: 14 }}>
            This PDF has no text layer.
          </div>
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 12, marginTop: 10, color: 'rgba(255,255,255,.85)', fontWeight: 600, lineHeight: 1.5 }}>
            SCANNED OR IMAGE-ONLY · WE CAN&apos;T READ TITLE BLOCKS OR SCALES AUTOMATICALLY.
          </div>
        </div>

        <div style={{ padding: '10px 20px', background: 'var(--m-card-soft)', borderBottom: '2px solid var(--m-ink)' }}>
          <div className="m-topbar-eyebrow">WHAT NOW</div>
        </div>
        <div style={{ padding: '14px 20px' }}>
          <MButtonStack>
            <MButton variant="primary" onClick={() => navigate(`/projects/${projectId}/takeoff-mobile`)}>
              Proceed · I&apos;ll enter scales manually
            </MButton>
            <MButton variant="ghost" onClick={() => navigate(`/projects/${projectId}/takeoff`)}>
              Upload a better file
            </MButton>
            <MButton variant="ghost" onClick={back}>
              Email the architect
            </MButton>
          </MButtonStack>
        </div>

        <div
          style={{
            padding: '14px 20px',
            background: 'var(--m-card-soft)',
            borderTop: '2px solid var(--m-ink)',
            borderBottom: '2px solid var(--m-ink)',
          }}
        >
          <div className="m-topbar-eyebrow" style={{ color: 'var(--m-ink-3)' }}>
            OTHER FAILURE MODES
          </div>
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, marginTop: 8, color: 'var(--m-ink-2)', fontWeight: 600, lineHeight: 1.6 }}>
            · CORRUPT / TRUNCATED
            <br />· ENCRYPTED (NEEDS PASSWORD)
            <br />· OVERSIZED (&gt; 200MB)
            <br />· UNSUPPORTED FORMAT
          </div>
        </div>

        <div style={{ flex: 1 }} />
        <DevStateToggle state={state} onChange={setState} />
      </div>
    )
  }

  const isParsing = state === 'parsing'
  const isDone = state === 'done'
  const steps = stepsFor(isDone, sheetCount)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="m-topbar">
        <button type="button" className="m-topbar-back" aria-label="Back" onClick={back}>
          <MI.ChevLeft size={22} />
        </button>
        <div className="m-topbar-title">
          <div className="m-topbar-eyebrow">STEP 3 / 3 · PLAN INGEST</div>
          <div className="m-h1">HILLCREST PH4</div>
        </div>
      </div>

      <div style={{ padding: '24px 20px', borderBottom: '2px solid var(--m-ink)' }}>
        <span className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-flex', gap: 5 }}>
          <Spark size={11} state="strong" /> {isDone ? 'PARSED' : 'PARSING'}
        </span>
        <h2
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 28,
            letterSpacing: '-0.02em',
            marginTop: 10,
            color: 'var(--m-ink)',
          }}
        >
          {isDone ? 'Plan set ready.' : 'AI reading the plan set…'}
        </h2>
        <div style={{ fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)', marginTop: 10, fontWeight: 500 }}>
          {blueprintsQuery.isLoading
            ? 'Loading blueprint…'
            : fileName
              ? fileName.toUpperCase()
              : 'NO BLUEPRINT UPLOADED YET'}
        </div>
      </div>

      {/* Step progress */}
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 0' }}>
        {steps.map((s) => (
          <div
            key={s.label}
            style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14, borderBottom: '1px solid var(--m-line-2)' }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                background: s.done ? 'var(--m-green)' : s.active ? 'var(--m-accent)' : 'transparent',
                color: s.done ? '#fff' : s.active ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                border: s.queued ? '2px solid var(--m-line-2)' : '2px solid var(--m-ink)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 14,
                flexShrink: 0,
              }}
              aria-hidden
            >
              {s.done ? '✓' : s.active ? '●' : ''}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 700,
                  fontSize: 14,
                  letterSpacing: '-0.005em',
                  color: s.queued ? 'var(--m-ink-3)' : 'var(--m-ink)',
                }}
              >
                {s.label}
              </div>
              {s.sub ? (
                <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, color: 'var(--m-ink-3)', marginTop: 3, fontWeight: 600 }}>
                  {s.sub}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {isDone ? (
        <div style={{ padding: '16px 20px', borderTop: '2px solid var(--m-ink)' }}>
          <MButton variant="primary" onClick={() => navigate(`/projects/${projectId}/takeoff-ai/autoscale`)}>
            Confirm scale · Start takeoff
          </MButton>
        </div>
      ) : null}
      {isParsing ? (
        <div style={{ padding: '16px 20px', borderTop: '2px solid var(--m-ink)' }}>
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, color: 'var(--m-ink-3)', textAlign: 'center', fontWeight: 600 }}>
            ~22 SECONDS REMAINING
          </div>
        </div>
      ) : null}

      <DevStateToggle state={state} onChange={setState} />
    </div>
  )
}

/**
 * Small state selector so each ingest state is reachable without a live
 * pipeline. The states are real product states (parsing/done/failed) — this
 * just stands in for the pipeline events that would drive them.
 */
function DevStateToggle({ state, onChange }: { state: IngestState; onChange: (s: IngestState) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        borderTop: '2px solid var(--m-ink)',
        background: 'var(--m-card-soft)',
      }}
    >
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
              padding: '10px 0',
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
