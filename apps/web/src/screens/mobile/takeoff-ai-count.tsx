/**
 * `takeoff-ai-count` — RESPONSIVE AI auto-count setup + review.
 *
 * Phase B of the responsive consolidation (docs/RESPONSIVE_CONSOLIDATION_ANALYSIS.md):
 * this single screen replaces the former desktop twin `screens/desktop/est-ai-count.tsx`
 * and the mobile `screens/mobile/takeoff-ai-count.tsx`. It renders the MOBILE hero/
 * keep-reject-lane layout by default and the DESKTOP canvas-markers + keyboard
 * review-panel layout at the Tailwind `lg:` (≥1024px) breakpoint. The data + capture
 * layer is shared verbatim — the merge is layout-only.
 *
 * Two route-able screens (each reachable from BOTH the `/desktop/*` route table
 * and the `/projects/*` mobile route table — `useNavFamily` keeps each tree's own
 * navigation targets):
 *   - TakeoffAiCountSetup  — confirm the tapped symbol, pick match sensitivity, and
 *     choose which sheets to scan, then RUN. → review.
 *   - TakeoffAiCountReview — hero count + the detected marks + a keep/reject lane.
 *     At `lg:` the lane is paired with the AI-overlaid count-marker CANVAS and a
 *     keyboard contract (J/K navigate · Y keep · N reject) the mobile surface omits.
 *
 * WIRED to the real capture pipeline. RUN posts to the takeoff-drafts capture
 * endpoint (kind=blueprint_vision, dry-run-safe JSON payload — no Anthropic spend)
 * and routes to REVIEW with the real draft id. REVIEW reads the draft's stored
 * TakeoffResult and promotes the kept quantities to committed `takeoff_measurements`.
 *
 * M1 (per-symbol count): the symbol / sensitivity / sheet-scope controls are no
 * longer presentational — RUN threads them into the capture payload as a
 * `count_scope`, and the pipeline returns a per-symbol count of the tapped symbol
 * scoped to the selected sheets at the chosen sensitivity (instance count + one
 * marker coordinate per instance). The desktop review canvas renders the real
 * instance markers from the result's geometry.objects[]. When no symbol is chosen
 * the pipeline falls back to the whole-draft path (unchanged).
 *
 * FOLLOW-UP (flagged in the PR): the live single-symbol VISION detector. This slice
 * honors the scope deterministically in the dry-run only. The symbol identity is
 * still the mockup's hardcoded "Diffuser — 24\" round" until a canvas symbol-pick
 * sets it.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { DEyebrow } from '../../components/d/index.js'
import { MBanner, MButton, MI, MPill, Spark } from '../../components/m/index.js'
import {
  countMarkersFromResult,
  countScopePayload,
  useCaptureTakeoffDraft,
  usePromoteCapturedQuantities,
  useTakeoffDraftResult,
  useTakeoffDrafts,
  type CapturedQuantity,
} from '../../lib/api/takeoff-drafts.js'

type Sensitivity = 'STRICT' | 'NORMAL' | 'LOOSE'

// Demo-data notice (C1, takeoff deep-dive 2026-06-01). RUN posts
// `payload: { dryRun: true }` with a JSON body and never streams a PDF, so this
// flow ALWAYS returns deterministic demo/stub quantities, never a real AI symbol
// read. The review surface always carries an explicit demo banner so a stub count
// can never be mistaken for a real read and submitted in a bid.
// Follow-up: wire the live multipart Claude-vision path (out of scope here).
const DEMO_BADGE_TITLE = 'DEMO DATA · NOT A REAL AI SYMBOL COUNT'
const DEMO_BADGE_BODY =
  'This count is placeholder demo data, not detected from your sheets. Do not submit it in a bid — verify every mark against the real drawing first.'

const eyebrow: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--m-ink-3)',
}

const dLabel: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--m-ink-3)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

const floatHead: React.CSSProperties = {
  padding: '10px 14px',
  borderBottom: '2px solid var(--m-ink)',
  background: 'var(--m-ink)',
  color: 'var(--m-accent)',
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

const sectionBar: React.CSSProperties = {
  padding: '10px 20px',
  background: 'var(--m-card-soft)',
  borderTop: '2px solid var(--m-ink)',
  borderBottom: '2px solid var(--m-ink)',
}

function CountAppBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="m-topbar">
      <button type="button" className="m-topbar-back" aria-label="Back" onClick={onBack}>
        <MI.ChevLeft size={22} />
      </button>
      <div className="m-topbar-title">
        <div className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-flex', gap: 5 }}>
          <Spark size={11} state="strong" /> AI · AUTO-COUNT
        </div>
        <div className="m-h1">{title}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Navigation family. This screen is mounted under BOTH the `/desktop/*` route
// table and the `/projects/*` mobile route table. We keep each tree's own
// navigation targets verbatim by branching on the current path prefix.
// (Phase D will collapse the two route tables; until then this keeps both routes
// working with no behavior change.)
// ---------------------------------------------------------------------------
function useNavFamily(projectId: string) {
  const location = useLocation()
  const isDesktopRoute = location.pathname.startsWith('/desktop')
  if (isDesktopRoute) {
    return {
      setupBack: () => (projectId ? `/desktop/canvas/${projectId}` : '/desktop/ai-queue'),
      toReview: () => `/desktop/ai-count/${projectId}/review`,
      reviewBack: () => `/desktop/ai-count/${projectId}`,
      afterApprove: () => (projectId ? `/desktop/estimate/${projectId}` : '/desktop/ai-queue'),
    }
  }
  return {
    setupBack: () => `/projects/${projectId}/takeoff-ai`,
    toReview: () => `/projects/${projectId}/takeoff-ai/count/review`,
    reviewBack: () => `/projects/${projectId}/takeoff-ai/count`,
    afterApprove: () => `/projects/${projectId}/takeoff-mobile`,
  }
}

// ---------------------------------------------------------------------------
// Setup — symbol confirm + sensitivity + sheet scope + RUN (shared logic; two
// layouts). The chosen symbol / sheets / sensitivity thread into the capture
// payload as a `count_scope`.
// ---------------------------------------------------------------------------
type ScanSheet = { code: string; label: string; on: boolean; dim?: boolean; sub?: string }

const SCAN_SHEETS: ScanSheet[] = [
  { code: 'M-101', label: 'M-101 · MECH PLAN', on: true },
  { code: 'M-102', label: 'M-102 · MECH UPPER', on: true },
  { code: 'M-103', label: 'M-103 · MECH LOWER', on: true },
  { code: 'M-104', label: 'M-104 · MECH ROOF', on: true },
  { code: 'A-201', label: 'A-201 · EAST ELEV.', on: false, dim: true, sub: 'NOT A MECH SHEET' },
]

// Shared setup hook — owns the tapped symbol scope, sensitivity, sheet toggles
// and the dry-run-safe capture RUN. Both the responsive screen and the standalone
// `EstAiCountSetupPanel` (consumed by the desktop est-canvas overlay) use it.
function useCountSetup(projectId: string, onReviewDraft: (draftId: string) => void) {
  // The tapped symbol the count is scoped to. Hardcoded to the mockup's tapped
  // symbol for now (the canvas symbol-pick that sets this is a separate slice);
  // it threads through to the capture payload so the pipeline counts THIS symbol.
  const countSymbol = { label: 'Diffuser — 24" round', sheet: 'A-104' }
  const [sensitivity, setSensitivity] = useState<Sensitivity>('NORMAL')
  const [sheets, setSheets] = useState<ScanSheet[]>(SCAN_SHEETS)
  const capture = useCaptureTakeoffDraft(projectId)

  const toggleSheet = (code: string) =>
    setSheets((prev) => prev.map((s) => (s.code === code && !s.dim ? { ...s, on: !s.on } : s)))
  const scanCount = sheets.filter((s) => s.on).length

  const run = () => {
    if (!projectId || capture.isPending) return
    // Dry-run-safe capture (JSON body → deterministic stub on the API; no live
    // Anthropic spend). Carries the real draft id into the review lane.
    //
    // M1: thread the tapped symbol / selected sheets / sensitivity into the
    // capture payload as a `count_scope` so the pipeline returns a per-symbol
    // count of THIS symbol scoped to the selected sheets — not a whole draft.
    // draft_kind='count' tags the draft so the company AI queue routes review to
    // the count reviewer (migration 122).
    const scopedSheets = sheets.filter((s) => s.on).map((s) => s.code)
    capture.mutate(
      {
        kind: 'blueprint_vision',
        draft_kind: 'count',
        name: `AI count · ${countSymbol.label}`,
        payload: countScopePayload({ symbol: countSymbol, sheets: scopedSheets, sensitivity }),
      },
      { onSuccess: (res) => onReviewDraft(res.draft.id) },
    )
  }

  return { sheets, toggleSheet, scanCount, sensitivity, setSensitivity, capture, run }
}

type CountSetupState = ReturnType<typeof useCountSetup>

// Sensitivity segmented control — shared between layouts (differs only in cell
// padding/font; the desktop float uses 10px/10px-pad, mobile 11px/16px-pad).
function SensitivityControl({
  sensitivity,
  setSensitivity,
  variant,
}: {
  sensitivity: Sensitivity
  setSensitivity: (s: Sensitivity) => void
  variant: 'mobile' | 'desktop'
}) {
  return (
    <div style={{ display: 'flex', border: '2px solid var(--m-ink)', marginTop: variant === 'desktop' ? 8 : 0 }}>
      {(['STRICT', 'NORMAL', 'LOOSE'] as const).map((s, i, arr) => {
        const on = sensitivity === s
        return (
          <button
            key={s}
            type="button"
            onClick={() => setSensitivity(s)}
            aria-pressed={on}
            style={{
              flex: 1,
              padding: variant === 'desktop' ? '10px 0' : '16px 0',
              background: on ? 'var(--m-accent)' : 'transparent',
              color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
              border: 'none',
              borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
              fontFamily: 'var(--m-num)',
              fontSize: variant === 'desktop' ? 10 : 11,
              fontWeight: 700,
              letterSpacing: variant === 'desktop' ? undefined : '0.06em',
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

// Desktop float palette — the `.dt-float` chrome only (no backdrop). Presentational
// over a `CountSetupState`. Mounted INSIDE the takeoff canvas via the exported
// `EstAiCountSetupPanel`, or by the responsive screen's desktop layout block.
function CountSetupFloat({ setup, onClose }: { setup: CountSetupState; onClose: () => void }) {
  const { sheets, toggleSheet, scanCount, sensitivity, setSensitivity, capture, run } = setup
  return (
    <div
      style={{
        position: 'absolute',
        top: 24,
        right: 24,
        width: 300,
        background: 'var(--m-card)',
        border: '2px solid var(--m-ink)',
        boxShadow: '6px 6px 0 var(--m-ink)',
        zIndex: 20,
      }}
    >
      <div style={{ ...floatHead, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>● AI · Count a symbol · DEMO</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--m-accent)',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 800,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ padding: 18 }}>
        <div style={{ ...dLabel, fontWeight: 600 }}>Clicked · A-104 sheet</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <span
            style={{
              width: 44,
              height: 44,
              background: 'var(--m-accent)',
              border: '2px solid var(--m-ink)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 18,
            }}
            aria-hidden
          >
            ◯
          </span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Diffuser · 24" round</span>
        </div>

        <div style={{ ...dLabel, marginTop: 18 }}>Sensitivity</div>
        <SensitivityControl sensitivity={sensitivity} setSensitivity={setSensitivity} variant="desktop" />

        <div style={{ ...dLabel, marginTop: 18 }}>Scan · {scanCount} mech sheets</div>
        <div style={{ marginTop: 8 }}>
          {sheets.map((s) => (
            <button
              key={s.code}
              type="button"
              onClick={() => toggleSheet(s.code)}
              disabled={s.dim}
              aria-pressed={s.on}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 0',
                width: '100%',
                background: 'transparent',
                border: 'none',
                cursor: s.dim ? 'default' : 'pointer',
                opacity: s.dim ? 0.4 : 1,
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  background: s.on ? 'var(--m-accent)' : 'transparent',
                  border: '2px solid var(--m-ink)',
                }}
                aria-hidden
              />
              <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 600 }}>{s.code}</span>
            </button>
          ))}
        </div>

        <div style={{ marginTop: 18 }}>
          <MButton variant="primary" onClick={run} disabled={capture.isPending || scanCount === 0}>
            {capture.isPending ? 'Scanning…' : 'Run demo count · ~30s'}
          </MButton>
          {capture.isError ? (
            <div
              style={{
                marginTop: 10,
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--m-red)',
              }}
            >
              ● {capture.error.message || 'Capture failed — try again.'}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Standalone AI auto-count SETUP float palette. Self-contained (owns the setup
 * hooks). Mounted as an overlay INSIDE the desktop takeoff canvas (est-canvas.tsx)
 * with the canvas visible behind. Kept exported so that Phase-C canvas consumer is
 * unaffected by the desktop↔mobile screen merge.
 */
export function EstAiCountSetupPanel({
  projectId,
  onClose,
  onReviewDraft,
}: {
  projectId: string
  onClose: () => void
  onReviewDraft: (draftId: string) => void
}) {
  const setup = useCountSetup(projectId, onReviewDraft)
  return <CountSetupFloat setup={setup} onClose={onClose} />
}

export function TakeoffAiCountSetup({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const nav = useNavFamily(projectId)

  const setup = useCountSetup(projectId, (draftId) => navigate(nav.toReview(), { state: { draftId } }))
  const { sheets, toggleSheet, scanCount, sensitivity, setSensitivity, capture, run } = setup

  return (
    <>
      {/* MOBILE layout (default, hidden ≥lg). */}
      <div
        className="lg:hidden"
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}
      >
        <CountAppBar title="TAP A SYMBOL" onBack={() => navigate(nav.setupBack())} />

        {/* Tapped symbol */}
        <div style={{ padding: '24px 20px', borderBottom: '2px solid var(--m-ink)' }}>
          <div style={eyebrow}>TAPPED · A-104 SHEET</div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 14 }}>
            <span
              style={{
                width: 64,
                height: 64,
                background: 'var(--m-accent)',
                border: '2px solid var(--m-ink)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 24,
                flexShrink: 0,
              }}
              aria-hidden
            >
              ◯
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 16 }}>
                DIFFUSER · 24&quot; ROUND
              </div>
              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  color: 'var(--m-ink-3)',
                  marginTop: 4,
                  fontWeight: 600,
                }}
              >
                OR: <span style={{ textDecoration: 'underline' }}>PICK DIFFERENT</span>
              </div>
            </div>
          </div>
        </div>

        {/* Sensitivity */}
        <div style={sectionBar}>
          <div className="m-topbar-eyebrow">MATCH SENSITIVITY</div>
        </div>
        <div style={{ padding: '18px 20px', borderBottom: '2px solid var(--m-ink)' }}>
          <SensitivityControl sensitivity={sensitivity} setSensitivity={setSensitivity} variant="mobile" />
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              color: 'var(--m-ink-3)',
              marginTop: 10,
              fontWeight: 600,
              lineHeight: 1.45,
            }}
          >
            NORMAL = HIGH-CONF AUTO + REVIEW THE EDGES.
          </div>
        </div>

        {/* Sheet scope */}
        <div style={sectionBar}>
          <div className="m-topbar-eyebrow">SCAN WHICH SHEETS</div>
        </div>
        <div style={{ padding: '14px 20px' }}>
          {sheets.map((s, i) => (
            <button
              key={s.code}
              type="button"
              onClick={() => toggleSheet(s.code)}
              disabled={s.dim}
              aria-pressed={s.on}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '12px 0',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: 'transparent',
                border: 'none',
                borderBottom: i < sheets.length - 1 ? '1px solid var(--m-line-2)' : 'none',
                cursor: s.dim ? 'default' : 'pointer',
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  background: s.on ? 'var(--m-accent)' : 'transparent',
                  border: '2px solid var(--m-ink)',
                  opacity: s.dim ? 0.4 : 1,
                  flexShrink: 0,
                }}
                aria-hidden
              />
              <span style={{ flex: 1, minWidth: 0, opacity: s.dim ? 0.4 : 1 }}>
                <span style={{ display: 'block', fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>
                  {s.label}
                </span>
                {s.sub ? (
                  <span
                    style={{
                      display: 'block',
                      fontFamily: 'var(--m-num)',
                      fontSize: 9,
                      color: 'var(--m-ink-3)',
                      marginTop: 3,
                      fontWeight: 600,
                    }}
                  >
                    {s.sub}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <div style={{ padding: '14px 20px 18px', borderTop: '2px solid var(--m-ink)' }}>
          {capture.isError ? (
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--m-red)',
                marginBottom: 10,
              }}
            >
              ● {capture.error.message || 'Capture failed — try again.'}
            </div>
          ) : null}
          <MButton variant="primary" onClick={run} disabled={capture.isPending || scanCount === 0}>
            {capture.isPending ? 'Scanning…' : `Run demo · ${scanCount} sheet${scanCount === 1 ? '' : 's'} · stub`}
          </MButton>
        </div>
      </div>

      {/* DESKTOP layout (≥lg only) — faint blueprint backdrop + floating palette. */}
      <div className="hidden lg:block d-content-full" style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'var(--m-ink-2)', overflow: 'hidden' }}>
          <svg
            viewBox="0 0 1208 836"
            width="100%"
            height="100%"
            preserveAspectRatio="xMidYMid slice"
            style={{ position: 'absolute', inset: 0, opacity: 0.4 }}
            aria-hidden="true"
          >
            <defs>
              <pattern id="ai-count-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M 24 0 L 0 0 0 24" stroke="var(--m-ink-3)" strokeWidth="0.5" fill="none" />
              </pattern>
            </defs>
            <rect width="1208" height="836" fill="url(#ai-count-grid)" />
            <circle cx="500" cy="400" r="16" fill="var(--m-accent)" stroke="var(--m-ink)" strokeWidth="3" />
          </svg>
        </div>
        <CountSetupFloat setup={setup} onClose={() => navigate(nav.setupBack())} />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Review — hero count + keep/reject lane (mobile) paired with the AI-overlaid
// count-marker canvas + keyboard contract (desktop). Shared decision/keptIds
// logic over the captured quantities; both layouts promote the kept ones.
// ---------------------------------------------------------------------------
type CountStatus = 'ok' | 'review' | 'flag'

// Mirrors REVIEW_REQUIRED_CONFIDENCE_FLOOR (0.7) in @sitelayer/capture-schema:
// the API flags any captured quantity below this as review_required. Keep in sync.
const REVIEW_CONFIDENCE_FLOOR = 0.7

/** Rows at/above the API review floor are safe to keep by default; below it the
 * estimator must review before accepting. <0.5 is flagged as low-confidence. */
function statusForConfidence(confidence: number): CountStatus {
  if (confidence >= REVIEW_CONFIDENCE_FLOOR) return 'ok'
  if (confidence >= 0.5) return 'review'
  return 'flag'
}

function confidenceLabel(confidence: number): 'HIGH' | 'MED' | 'LOW' {
  if (confidence >= REVIEW_CONFIDENCE_FLOOR) return 'HIGH'
  if (confidence >= 0.5) return 'MED'
  return 'LOW'
}

function formatQty(value: number, unit: string): string {
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100
  return `${rounded.toLocaleString()} ${unit.toUpperCase()}`
}

/**
 * Resolve the draft id to review: prefer the one handed over by the setup screen
 * via navigation state; otherwise fall back to the most-recent capture-sourced
 * draft for the project (covers deep-links / refresh).
 */
function useCountReviewDraftId(projectId: string): string | null {
  const location = useLocation()
  const stateDraftId =
    location.state && typeof location.state === 'object' && 'draftId' in location.state
      ? String((location.state as { draftId?: unknown }).draftId ?? '')
      : ''
  const draftsQuery = useTakeoffDrafts(stateDraftId ? null : projectId)
  if (stateDraftId) return stateDraftId
  const latestCapture = (draftsQuery.data?.drafts ?? []).filter((d) => d.source && d.source !== 'manual').at(-1)
  return latestCapture?.id ?? null
}

// Decorative marker positions in the desktop review canvas (x, y, low?) — verbatim
// from the mockup; used as a fallback when the result emits no instance objects.
const MARKERS: Array<[number, number, boolean]> = [
  [180, 240, false],
  [340, 240, false],
  [500, 240, false],
  [660, 240, false],
  [180, 440, false],
  [340, 440, false],
  [500, 440, false],
  [180, 600, true],
  [660, 600, true],
]

function statusBg(status: CountStatus): string {
  return status === 'flag' ? 'var(--m-red)' : status === 'review' ? 'var(--m-accent)' : 'var(--m-green)'
}

// Mono Y/N chip mirroring the keyboard keep/reject contract for click users (desktop).
function decisionChip(on: boolean, kind: 'keep' | 'reject'): React.CSSProperties {
  const tone = kind === 'keep' ? 'var(--m-green)' : 'var(--m-red)'
  return {
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: on ? tone : 'transparent',
    color: on ? 'var(--m-sand)' : tone,
    border: `2px solid ${tone}`,
    fontFamily: 'var(--m-num)',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
    flexShrink: 0,
  }
}

// Per-row review decision. 'pending' rows inherit their AI status until the
// estimator keeps/rejects them.
type Decision = 'pending' | 'kept' | 'rejected'

export function TakeoffAiCountReview({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const nav = useNavFamily(projectId)

  const draftId = useCountReviewDraftId(projectId)
  const resultQuery = useTakeoffDraftResult(draftId)
  const promote = usePromoteCapturedQuantities(projectId, draftId)

  const quantities = useMemo<CapturedQuantity[]>(
    () => resultQuery.data?.takeoff_result.quantities ?? [],
    [resultQuery.data],
  )

  // M1: per-symbol count markers (one per detected instance) carried on the
  // result's geometry.objects[]. Falls back to the decorative MARKERS layout for
  // whole-draft results that don't emit instance objects. (Desktop canvas only.)
  const realMarkers = useMemo(() => countMarkersFromResult(resultQuery.data?.takeoff_result), [resultQuery.data])
  const markers: Array<[number, number, boolean]> =
    realMarkers.length > 0 ? realMarkers.map((m): [number, number, boolean] => [m.x, m.y, m.low]) : MARKERS

  // Per-row keep/reject decisions, keyed by quantity id. High-confidence (ok)
  // rows are auto-kept; review/flag rows are kept only once explicitly kept.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const decisionFor = (id: string, status: CountStatus): Decision =>
    decisions[id] ?? (status === 'ok' ? 'kept' : 'pending')
  const setDecision = (id: string, decision: Decision) => setDecisions((prev) => ({ ...prev, [id]: decision }))
  const isKept = (q: CapturedQuantity) => decisionFor(q.id, statusForConfidence(q.confidence)) === 'kept'

  // Default the active row to the first flagged detection so the estimator lands
  // on the one that needs a decision, not row 0 (desktop keyboard nav).
  const firstFlagged = useMemo(() => {
    const idx = quantities.findIndex((q) => statusForConfidence(q.confidence) !== 'ok')
    return idx >= 0 ? idx : 0
  }, [quantities])
  const [active, setActive] = useState(firstFlagged)

  const confidenceBuckets = useMemo(
    () =>
      quantities.reduce(
        (acc, q) => {
          acc[confidenceLabel(q.confidence)] += 1
          return acc
        },
        { HIGH: 0, MED: 0, LOW: 0 },
      ),
    [quantities],
  )

  const total = quantities.length
  const keptIds = quantities.filter(isKept).map((q) => q.id)
  const kept = keptIds.length
  const rejectedCount = quantities.filter(
    (q) => decisionFor(q.id, statusForConfidence(q.confidence)) === 'rejected',
  ).length
  const flaggedCount = quantities.filter((q) => statusForConfidence(q.confidence) !== 'ok').length
  const approving = promote.isPending

  // J/K navigate · Y keep · N reject — the keyboard contract the desktop banner
  // advertises. Acting on a row also advances to the next one so the estimator can
  // clear the flagged set without leaving the keyboard. (Desktop-only affordance;
  // listening globally is harmless on mobile — touch users never trigger it.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      const key = e.key.toLowerCase()
      if (key === 'j') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, quantities.length - 1))
      } else if (key === 'k') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
      } else if (key === 'y') {
        e.preventDefault()
        const q = quantities[active]
        if (q) setDecision(q.id, 'kept')
        setActive((i) => Math.min(i + 1, quantities.length - 1))
      } else if (key === 'n') {
        e.preventDefault()
        const q = quantities[active]
        if (q) setDecision(q.id, 'rejected')
        setActive((i) => Math.min(i + 1, quantities.length - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, quantities])

  const approve = () => {
    if (!draftId || keptIds.length === 0 || promote.isPending) return
    promote.mutate({ quantity_ids: keptIds }, { onSuccess: () => navigate(nav.afterApprove()) })
  }

  return (
    <>
      {/* MOBILE layout (default, hidden ≥lg) — hero count slab + keep/reject lane. */}
      <div className="lg:hidden" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <CountAppBar title="REVIEW COUNT" onBack={() => navigate(nav.reviewBack())} />

        {/* Hero count slab */}
        <div style={{ padding: 20, background: 'var(--m-ink)', color: 'var(--m-sand)' }}>
          <div className="m-topbar-eyebrow" style={{ color: 'var(--m-amber)' }}>
            DEMO · {resultQuery.data?.source ? resultQuery.data.source.toUpperCase() : 'AI DETECTED'} · STUB
          </div>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 72,
              lineHeight: 0.9,
              letterSpacing: '-0.035em',
              marginTop: 6,
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--m-sand)',
            }}
          >
            {resultQuery.isLoading ? '…' : kept}
            <span style={{ fontSize: 24, color: 'var(--m-ink-4)', marginLeft: 6 }}> KEPT</span>
          </div>
          <div
            style={{ fontFamily: 'var(--m-num)', fontSize: 12, marginTop: 8, color: 'var(--m-ink-4)', fontWeight: 600 }}
          >
            HIGH {confidenceBuckets.HIGH} · MED {confidenceBuckets.MED} · LOW {confidenceBuckets.LOW}
          </div>
        </div>

        <div style={{ padding: '14px 20px 0' }}>
          <MBanner tone="warn" icon={<MI.AlertTri size={18} />} title={DEMO_BADGE_TITLE} body={DEMO_BADGE_BODY} />
        </div>

        {/* Keep/reject lane over the captured quantities */}
        <div
          style={{
            padding: '10px 20px',
            background: 'var(--m-ink)',
            color: 'var(--m-accent)',
            borderTop: '2px solid var(--m-ink)',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          TAP A ROW · Y KEEP · N REJECT
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {resultQuery.isError ? (
            <div
              style={{ padding: 20, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-red)', fontWeight: 600 }}
            >
              Couldn&apos;t load the count result. {resultQuery.error.message}
            </div>
          ) : null}
          {!resultQuery.isLoading && !resultQuery.isError && quantities.length === 0 ? (
            <div
              style={{
                padding: 20,
                fontFamily: 'var(--m-num)',
                fontSize: 12,
                color: 'var(--m-ink-3)',
                fontWeight: 600,
              }}
            >
              {draftId ? 'This draft has no detected quantities.' : 'Run the count to produce a draft.'}
            </div>
          ) : null}
          {quantities.map((q, i) => {
            const on = i === active
            const kR = isKept(q)
            return (
              <div
                key={q.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 20px',
                  borderBottom: '1px solid var(--m-line-2)',
                  background: on ? 'var(--m-accent-soft)' : 'transparent',
                  opacity: kR ? 1 : 0.45,
                }}
              >
                <button
                  type="button"
                  onClick={() => setActive(i)}
                  aria-pressed={on}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    background: 'transparent',
                    border: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{ width: 8, height: 8, background: kR ? 'var(--m-accent)' : 'var(--m-red)' }}
                    aria-hidden
                  />
                  <span style={{ flex: 1, fontFamily: 'var(--m-num)', fontSize: 12, fontWeight: 700, minWidth: 0 }}>
                    {q.description || q.masterformatCode || q.id} · {formatQty(q.value, q.unit)}
                  </span>
                  <MPill
                    tone={
                      confidenceLabel(q.confidence) === 'HIGH'
                        ? 'green'
                        : confidenceLabel(q.confidence) === 'MED'
                          ? 'amber'
                          : 'red'
                    }
                  >
                    {confidenceLabel(q.confidence)}
                  </MPill>
                </button>
                <button
                  type="button"
                  onClick={() => setDecision(q.id, 'kept')}
                  aria-label={`Keep ${q.id}`}
                  style={{
                    padding: '6px 12px',
                    background: kR ? 'var(--m-green)' : 'transparent',
                    color: kR ? '#fff' : 'var(--m-ink-3)',
                    border: '2px solid var(--m-ink)',
                    fontFamily: 'var(--m-num)',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Y
                </button>
                <button
                  type="button"
                  onClick={() => setDecision(q.id, 'rejected')}
                  aria-label={`Reject ${q.id}`}
                  style={{
                    padding: '6px 12px',
                    background: !kR ? 'var(--m-red)' : 'transparent',
                    color: !kR ? '#fff' : 'var(--m-ink-3)',
                    border: '2px solid var(--m-ink)',
                    fontFamily: 'var(--m-num)',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  N
                </button>
              </div>
            )
          })}
        </div>

        {promote.isError ? (
          <div
            style={{
              padding: '10px 20px',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--m-red)',
              borderTop: '2px solid var(--m-ink)',
            }}
          >
            ● {promote.error.message || 'Promote failed — try again.'}
          </div>
        ) : null}
        <div style={{ padding: '14px 20px', display: 'flex', gap: 8, borderTop: '2px solid var(--m-ink)' }}>
          <MButton variant="ghost" onClick={() => navigate(nav.reviewBack())} style={{ flex: 1 }}>
            Re-run
          </MButton>
          <MButton
            variant="primary"
            onClick={approve}
            disabled={promote.isPending || keptIds.length === 0 || !draftId}
            style={{ flex: 2 }}
          >
            {promote.isPending ? 'Promoting…' : `Approve ${keptIds.length}`}
          </MButton>
        </div>
      </div>

      {/* DESKTOP layout (≥lg only) — canvas markers + keyboard review panel. */}
      <div className="hidden lg:block d-content-full" style={{ position: 'relative' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', height: '100%' }}>
          {/* Canvas with overlaid count markers */}
          <div
            style={{
              position: 'relative',
              overflow: 'hidden',
              background: 'var(--m-card-soft)',
              borderRight: '2px solid var(--m-ink)',
            }}
          >
            <svg
              viewBox="0 0 900 836"
              width="100%"
              height="100%"
              preserveAspectRatio="xMidYMid slice"
              style={{ position: 'absolute', inset: 0 }}
              aria-hidden="true"
            >
              <defs>
                <pattern id="ai-count-review-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                  <path d="M 24 0 L 0 0 0 24" stroke="var(--m-ink-3)" strokeWidth="0.5" fill="none" />
                </pattern>
              </defs>
              <rect width="900" height="836" fill="url(#ai-count-review-grid)" />
              <rect x="80" y="120" width="740" height="560" fill="none" stroke="var(--m-ink)" strokeWidth="3" />
              {markers.map(([x, y, low], i) => (
                <g key={i}>
                  <circle
                    cx={x}
                    cy={y}
                    r="18"
                    fill={low ? 'var(--m-red)' : 'var(--m-accent)'}
                    stroke="var(--m-ink)"
                    strokeWidth="3"
                  />
                  {low ? (
                    <text
                      x={x}
                      y={y + 5}
                      fontFamily="var(--m-num)"
                      fontSize="16"
                      fontWeight="800"
                      textAnchor="middle"
                      fill="#fff"
                    >
                      ?
                    </text>
                  ) : null}
                </g>
              ))}
            </svg>
          </div>

          {/* Keyboard review panel */}
          <div style={{ overflowY: 'auto', background: 'var(--m-card)' }}>
            <div style={{ padding: 20, borderBottom: '2px solid var(--m-ink)' }}>
              <DEyebrow>
                {resultQuery.isLoading ? 'AI · loading…' : `AI · ${total} found`}
                {resultQuery.data?.source ? ` · ${resultQuery.data.source}` : ''}
              </DEyebrow>
              <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 36, marginTop: 6 }}>
                {kept} <span style={{ fontSize: 16, color: 'var(--m-green)' }}>kept</span>
              </div>
              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  color: 'var(--m-ink-2)',
                  marginTop: 6,
                  fontWeight: 600,
                }}
              >
                {flaggedCount} LOW-CONF FLAGGED
                {rejectedCount > 0 ? ` · ${rejectedCount} REJECTED` : ''}
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'var(--m-ink)',
                  color: 'var(--m-accent)',
                  marginTop: 14,
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}
              >
                J/K NAVIGATE · Y KEEP · N REJECT
              </div>
              <div style={{ marginTop: 14 }}>
                <MBanner tone="warn" icon={<MI.AlertTri size={18} />} title={DEMO_BADGE_TITLE} body={DEMO_BADGE_BODY} />
              </div>
            </div>
            {quantities.map((q, i) => {
              const on = i === active
              const status = statusForConfidence(q.confidence)
              const decision = decisionFor(q.id, status)
              const label = q.description || q.masterformatCode || q.uniformatCode || q.id
              const confidence = confidenceLabel(q.confidence)
              return (
                <div
                  key={q.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  onClick={() => setActive(i)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setActive(i)
                    }
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '14px 20px',
                    borderBottom: '1px solid var(--m-line-2)',
                    borderLeft: on ? '4px solid var(--m-ink)' : '4px solid transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    background: on ? 'var(--m-accent)' : 'transparent',
                    opacity: decision === 'rejected' ? 0.5 : 1,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 8, height: 8, background: statusBg(status) }} aria-hidden />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontFamily: 'var(--m-num)',
                      fontSize: 12,
                      fontWeight: 700,
                      textDecoration: decision === 'rejected' ? 'line-through' : 'none',
                    }}
                  >
                    {label} · {formatQty(q.value, q.unit)}
                  </span>
                  {decision === 'kept' ? (
                    <MPill tone="green" dot>
                      KEPT
                    </MPill>
                  ) : decision === 'rejected' ? (
                    <MPill tone="red" dot>
                      REJECTED
                    </MPill>
                  ) : (
                    <MPill tone={confidence === 'HIGH' ? 'green' : confidence === 'MED' ? 'amber' : 'red'}>
                      {confidence}
                    </MPill>
                  )}
                  {/* Y/N affordances mirror the keyboard contract for click users. */}
                  <span style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      aria-label={`Keep ${q.id}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setActive(i)
                        setDecision(q.id, 'kept')
                      }}
                      style={decisionChip(decision === 'kept', 'keep')}
                    >
                      Y
                    </button>
                    <button
                      type="button"
                      aria-label={`Reject ${q.id}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setActive(i)
                        setDecision(q.id, 'rejected')
                      }}
                      style={decisionChip(decision === 'rejected', 'reject')}
                    >
                      N
                    </button>
                  </span>
                </div>
              )
            })}
            {!resultQuery.isLoading && quantities.length === 0 ? (
              <div
                style={{
                  padding: '16px 20px',
                  fontFamily: 'var(--m-num)',
                  fontSize: 12,
                  color: 'var(--m-ink-3)',
                  fontWeight: 600,
                }}
              >
                {resultQuery.isError
                  ? `Couldn't load the count result. ${resultQuery.error.message}`
                  : draftId
                    ? 'This draft has no detected quantities.'
                    : 'Run the count to produce a draft.'}
              </div>
            ) : null}
            {promote.isError ? (
              <div
                style={{
                  padding: '12px 20px 0',
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--m-red)',
                }}
              >
                ● {promote.error.message || 'Promote failed — try again.'}
              </div>
            ) : null}
            <div style={{ padding: '16px 20px' }}>
              <MButton variant="primary" onClick={approve} disabled={approving || kept === 0 || !draftId}>
                {approving ? 'Promoting…' : `Approve ${kept} clean`}
              </MButton>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
