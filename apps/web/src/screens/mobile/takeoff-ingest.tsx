/**
 * `takeoff-ingest` — responsive plan-ingest progress / done / failed.
 *
 * Phase B (responsive consolidation) merge of the former desktop twin
 * `screens/desktop/est-plan-ingest.tsx` (`EstPlanIngest`) and this mobile
 * `TakeoffIngest`. ONE routable screen mounted by BOTH the mobile shell
 * (`/projects/:projectId/takeoff-ai/ingest`) and the desktop workspace
 * (`/desktop/ingest/:projectId`). It walks the three ingest states:
 *   - parsing — step progress: PDF uploaded → sheets detected → cross-sheet
 *     refs → scale auto-detect → scope pre-classify. Mobile shows a "~22s
 *     remaining" note; desktop shows a determinate progress bar (dsg__44).
 *   - done    — every step ✓, "Plan set ready" → CONFIRM SCALE · START TAKEOFF.
 *   - failed  — no-text-layer error + manual-fallback / upload-better /
 *     email-architect CTAs + the other failure modes.
 *
 * Layout is responsive: the mobile step-list + topbar render by default; at the
 * `lg:` (≥1024px) breakpoint the desktop two-column layout (detected-sheets card
 * + AI INGEST step rail + progress-bar footer, dsg__44/45) takes over. Both the
 * data layer (REAL blueprint data — `useProjectBlueprints` + `useBlueprintPages`,
 * file name + sheet count + per-page tiles) AND the per-surface navigation graph
 * are preserved exactly: the screen detects whether it is mounted on the
 * `/desktop/*` surface and routes/labels accordingly (desktop → /desktop/scale,
 * /desktop/canvas; mobile → /projects/:id/takeoff-ai/autoscale, /takeoff-mobile,
 * /takeoff, /takeoff-ai). Each surface keeps its original blueprint-selection
 * semantics too (desktop = primary/first non-deleted doc; mobile = latest upload).
 *
 * GAP (both surfaces, unchanged): there is no live parsing-progress STREAM
 * (cross-sheet ref linking, scale auto-detect, scope pre-classify are not
 * exposed as a progress feed), so the parsing/done/failed states stay selectable
 * via `?state=parsing|done|failed` (+ a dev toggle) and the sub-step copy stays
 * presentational. A SSE/poll ingest-progress endpoint is the suggested fill.
 */
import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MButtonStack, MI, Spark } from '../../components/m/index.js'
import {
  useBlueprintPages,
  useProjectBlueprints,
  type BlueprintDocument,
  type BlueprintPage,
} from '../../lib/api/takeoff.js'

type IngestState = 'parsing' | 'done' | 'failed'

type IngestStep = {
  label: string
  done: boolean
  active?: boolean | undefined
  queued?: boolean | undefined
  sub?: string | undefined
}

/**
 * Step rail copy. The desktop and mobile twins drifted to slightly different
 * sub-copy (e.g. "EPS · basecoat · stone · plumbing" desktop vs
 * "EPS · base · stone · plumbing" mobile; desktop carries a "queued" / detected
 * sub on extra steps). `surface` keeps each side's exact wording so neither is
 * regressed by the merge.
 */
function stepsFor(isDone: boolean, sheetCount: number | null, surface: 'desktop' | 'mobile'): IngestStep[] {
  const sheetLabel =
    sheetCount != null ? `${sheetCount} SHEET${sheetCount === 1 ? '' : 'S'} DETECTED` : 'SHEETS DETECTED'
  const desktop = surface === 'desktop'
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
      // Desktop carries an honest title-block sub-line; mobile left this bare.
      sub: desktop
        ? sheetCount != null
          ? 'Title blocks read · A-series + S-series'
          : 'reading title blocks…'
        : undefined,
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
        : desktop
          ? 'reading title-block scale bars…'
          : 'reading title blocks…',
    },
    {
      label: 'SCOPE PRE-CLASSIFY',
      done: isDone,
      queued: !isDone,
      // Desktop spells "basecoat" and shows a "queued" sub while pending; mobile
      // says "base" and leaves the pending sub empty. Preserve both verbatim.
      sub: isDone
        ? desktop
          ? 'EPS · basecoat · stone · plumbing'
          : 'EPS · base · stone · plumbing'
        : desktop
          ? 'queued'
          : undefined,
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

export function TakeoffIngest({ companySlug }: { companySlug?: string }) {
  void companySlug
  const { projectId: projectIdParam } = useParams<{ projectId: string }>()
  const projectId = projectIdParam ?? ''
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  // Surface detection — this one component mounts on BOTH the /desktop/* and the
  // mobile /projects/* route trees. The navigation graph + a couple of copy/
  // doc-selection deltas are surface-specific (not viewport-specific), so they
  // key off the mounting surface; the visual layout still reflows via `lg:`.
  const isDesktop = location.pathname.startsWith('/desktop')

  // Real blueprint data — same shape est-scale-verify + the canvas resolve
  // sheets from. Desktop verified against the PRIMARY (first non-deleted) doc;
  // mobile browsed the LATEST upload. Keep each surface's original selection.
  const blueprintsQuery = useProjectBlueprints(projectId)
  const selectedDoc = useMemo<BlueprintDocument | null>(() => {
    const docs = (blueprintsQuery.data?.blueprints ?? []).filter((b) => !b.deleted_at)
    return (isDesktop ? docs[0] : docs.at(-1)) ?? null
  }, [blueprintsQuery.data?.blueprints, isDesktop])
  const pagesQuery = useBlueprintPages(selectedDoc?.id ?? null)
  const pages = pagesQuery.data?.pages ?? []
  const sheetCount = pagesQuery.data ? pages.length : null
  const fileName = selectedDoc?.file_name ?? null
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

  // Per-surface navigation targets — preserved verbatim from each twin.
  const back = () => navigate(isDesktop ? '/desktop/takeoff' : `/projects/${projectId}/takeoff-ai`)
  const goConfirmScale = () =>
    navigate(isDesktop ? `/desktop/scale/${projectId}` : `/projects/${projectId}/takeoff-ai/autoscale`)
  // Failed-state CTAs. Desktop sent "proceed" and "upload a better file" both to
  // the canvas; mobile sent "proceed" to takeoff-mobile and "upload" to takeoff.
  const goProceedManual = () =>
    navigate(isDesktop ? `/desktop/canvas/${projectId}` : `/projects/${projectId}/takeoff-mobile`)
  const goUploadBetter = () => navigate(isDesktop ? `/desktop/canvas/${projectId}` : `/projects/${projectId}/takeoff`)
  // Desktop's "Replace" header action.
  const goReplace = () => navigate(`/desktop/canvas/${projectId}`)

  const isParsing = state === 'parsing'
  const isDone = state === 'done'
  const steps = stepsFor(isDone, sheetCount, isDesktop ? 'desktop' : 'mobile')

  // Determinate progress (desktop bar, dsg__44): each completed step is one
  // unit; the active step adds a half-step so the bar moves before parsing ends.
  const doneSteps = steps.filter((s) => s.done).length
  const hasActive = steps.some((s) => s.active)
  const progressPct = isDone
    ? 100
    : Math.min(95, Math.round(((doneSteps + (hasActive ? 0.5 : 0)) / steps.length) * 100))

  // ---- FAILED state (shared logic; two responsive renders) ----
  if (state === 'failed') {
    return (
      <>
        {/* Mobile failure render (default; hidden ≥lg) */}
        <div
          className="lg:hidden"
          style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}
        >
          <div className="m-topbar">
            <button type="button" className="m-topbar-back" aria-label="Back" onClick={back}>
              <MI.ChevLeft size={22} />
            </button>
            <div className="m-topbar-title">
              <div className="m-h1">PLAN INGEST FAILED</div>
            </div>
          </div>

          {/* Error banner */}
          <div
            style={{
              padding: '24px 20px',
              background: 'var(--m-red)',
              color: '#fff',
              borderBottom: '2px solid var(--m-ink)',
            }}
          >
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em' }}>
              ● COULDN&apos;T PARSE
            </div>
            <div
              style={{
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 32,
                lineHeight: 0.95,
                marginTop: 14,
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

          <div
            style={{ padding: '10px 20px', background: 'var(--m-card-soft)', borderBottom: '2px solid var(--m-ink)' }}
          >
            <div className="m-topbar-eyebrow">WHAT NOW</div>
          </div>
          <div style={{ padding: '14px 20px' }}>
            <MButtonStack>
              <MButton variant="primary" onClick={goProceedManual}>
                Proceed · I&apos;ll enter scales manually
              </MButton>
              <MButton variant="ghost" onClick={goUploadBetter}>
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

          <div style={{ flex: 1 }} />
          <DevStateToggle state={state} onChange={setState} variant="mobile" />
        </div>

        {/* Desktop failure render (≥lg) */}
        <div className="hidden lg:block d-content">
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
              <MButton variant="primary" onClick={goProceedManual}>
                Proceed · enter scales manually
              </MButton>
              <MButton variant="ghost" onClick={goUploadBetter}>
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

            <DevStateToggle state={state} onChange={setState} variant="desktop" />
          </div>
        </div>
      </>
    )
  }

  // ---- PARSING / DONE state (shared logic; two responsive renders) ----
  return (
    <>
      {/* Mobile render (default; hidden ≥lg) */}
      <div
        className="lg:hidden"
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}
      >
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
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              color: 'var(--m-ink-3)',
              marginTop: 10,
              fontWeight: 500,
            }}
          >
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
              style={{
                padding: '14px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                borderBottom: '1px solid var(--m-line-2)',
              }}
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

        {isDone ? (
          <div style={{ padding: '16px 20px', borderTop: '2px solid var(--m-ink)' }}>
            <MButton variant="primary" onClick={goConfirmScale}>
              Confirm scale · Start takeoff
            </MButton>
          </div>
        ) : null}
        {isParsing ? (
          <div style={{ padding: '16px 20px', borderTop: '2px solid var(--m-ink)' }}>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                color: 'var(--m-ink-3)',
                textAlign: 'center',
                fontWeight: 600,
              }}
            >
              ~22 SECONDS REMAINING
            </div>
          </div>
        ) : null}

        <DevStateToggle state={state} onChange={setState} variant="mobile" />
      </div>

      {/* Desktop render (≥lg) — two-column detected-sheets + AI INGEST rail */}
      <div className="hidden lg:block d-content">
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
                <MButton size="sm" variant="ghost" onClick={goReplace}>
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
              <MButton variant="primary" onClick={goConfirmScale}>
                Confirm scale · Start takeoff →
              </MButton>
              <MButton variant="ghost" onClick={goConfirmScale}>
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

          <DevStateToggle state={state} onChange={setState} variant="desktop" />
        </div>
      </div>
    </>
  )
}

/** A faint hatched thumbnail tile with a sheet label underneath (desktop). */
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
 * just stands in for the pipeline events that would drive them. The `variant`
 * matches the slightly heavier desktop padding / standalone (no top border)
 * mobile chrome the two twins each shipped.
 */
function DevStateToggle({
  state,
  onChange,
  variant,
}: {
  state: IngestState
  onChange: (s: IngestState) => void
  variant: 'desktop' | 'mobile'
}) {
  const desktop = variant === 'desktop'
  return (
    <div
      style={
        desktop
          ? { display: 'flex', border: '2px solid var(--m-ink)', maxWidth: 360, background: 'var(--m-card-soft)' }
          : { display: 'flex', borderTop: '2px solid var(--m-ink)', background: 'var(--m-card-soft)' }
      }
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
              padding: desktop ? '8px 0' : '10px 0',
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
