/**
 * Estimator desktop · AI Auto-Count (Desktop v2 · ported from Steve's mockup
 * `DAICountSetup` + `DAICountReview` in /tmp/steve3/04_app.js).
 *
 * Two route-able screens:
 *   - EstAiCountSetup — pick a clicked symbol, sensitivity, and the mech sheets
 *     to scan, then run the AI symbol count. Float palette over a faint
 *     blueprint backdrop.
 *   - EstAiCountReview — canvas with the AI-overlaid count markers + a
 *     keyboard-driven review panel (J/K navigate · Y keep · N reject). Low-
 *     confidence detections are flagged red; APPROVE keeps the clean set.
 *
 * WIRED to the real capture pipeline. Setup RUN posts to the takeoff-drafts
 * capture endpoint (kind=blueprint_vision, dry-run-safe JSON payload — no
 * Anthropic spend) and routes to REVIEW with the real draft id. REVIEW reads
 * the draft's stored TakeoffResult and promotes the kept quantities to
 * committed `takeoff_measurements` via .../:draftId/promote.
 *
 * GAP: the pipeline returns whole-draft quantities, not a per-symbol count
 * keyed to the clicked symbol. The symbol/sensitivity/sheet-scope controls
 * stay presentational; REVIEW lists the captured quantities in the keep/reject
 * lane. A dedicated single-symbol auto-count endpoint is a GAP. The board
 * marker overlay is decorative.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { DEyebrow } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import {
  useCaptureTakeoffDraft,
  usePromoteCapturedQuantities,
  useTakeoffDraftResult,
  useTakeoffDrafts,
  type CapturedQuantity,
} from '@/lib/api/takeoff-drafts'

type Sensitivity = 'STRICT' | 'NORMAL' | 'LOOSE'

const label: React.CSSProperties = {
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

function CountBackdrop({ children }: { children?: React.ReactNode }) {
  return (
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
        {children}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EstAiCountSetupPanel — the float palette only (symbol + sensitivity + sheet
// scope + RUN). Mounted as an overlay INSIDE the takeoff canvas (canvas
// visible behind), or wrapped by the full-page EstAiCountSetup route shim.
// ---------------------------------------------------------------------------
export function EstAiCountSetupPanel({
  projectId,
  onClose,
  onReviewDraft,
}: {
  projectId: string
  onClose: () => void
  onReviewDraft: (draftId: string) => void
}) {
  const sheets = ['M-101', 'M-102', 'M-103', 'M-104']
  const [sensitivity, setSensitivity] = useState<Sensitivity>('NORMAL')
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sheets.map((s) => [s, true])),
  )
  const capture = useCaptureTakeoffDraft(projectId)

  const toggleSheet = (sheet: string) => {
    setSelected((prev) => ({ ...prev, [sheet]: !prev[sheet] }))
  }
  const selectedCount = sheets.filter((s) => selected[s]).length

  const runCount = () => {
    if (!projectId || capture.isPending) return
    // Dry-run-safe capture (JSON body → deterministic stub on the API; no live
    // Anthropic spend). Carries the real draft id into the review lane.
    capture.mutate(
      { kind: 'blueprint_vision', name: 'AI auto-count', payload: { dryRun: true } },
      {
        onSuccess: (res) => onReviewDraft(res.draft.id),
      },
    )
  }

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
        <span>● AI · Count a symbol</span>
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
        <div style={{ ...label, fontWeight: 600 }}>Clicked · A-104 sheet</div>
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

        <div style={{ ...label, marginTop: 18 }}>Sensitivity</div>
        <div style={{ display: 'flex', border: '2px solid var(--m-ink)', marginTop: 8 }}>
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
                  padding: '10px 0',
                  background: on ? 'var(--m-accent)' : 'transparent',
                  color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                  border: 'none',
                  borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {s}
              </button>
            )
          })}
        </div>

        <div style={{ ...label, marginTop: 18 }}>Scan · {selectedCount} mech sheets</div>
        <div style={{ marginTop: 8 }}>
          {sheets.map((s) => {
            const on = Boolean(selected[s])
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSheet(s)}
                aria-pressed={on}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 0',
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    background: on ? 'var(--m-accent)' : 'transparent',
                    border: '2px solid var(--m-ink)',
                  }}
                  aria-hidden
                />
                <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 600 }}>{s}</span>
              </button>
            )
          })}
        </div>

        <div style={{ marginTop: 18 }}>
          <MButton variant="primary" onClick={runCount} disabled={capture.isPending || selectedCount === 0}>
            {capture.isPending ? 'Scanning…' : 'Run · ~30s'}
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

// ---------------------------------------------------------------------------
// EstAiCountSetup — full-page route shim (faint backdrop + the panel).
// ---------------------------------------------------------------------------
export function EstAiCountSetup() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  return (
    <div className="d-content-full" style={{ position: 'relative' }}>
      <CountBackdrop>
        <circle cx="500" cy="400" r="16" fill="var(--m-accent)" stroke="var(--m-ink)" strokeWidth="3" />
      </CountBackdrop>
      <EstAiCountSetupPanel
        projectId={projectId}
        onClose={() => navigate(projectId ? `/desktop/canvas/${projectId}` : '/desktop/ai-queue')}
        onReviewDraft={(id) => navigate(`/desktop/ai-count/${projectId}/review`, { state: { draftId: id } })}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// EstAiCountReview — canvas markers + keyboard review panel.
// ---------------------------------------------------------------------------
type CountStatus = 'ok' | 'review' | 'flag'

type CountDetection = {
  id: string
  label: string
  qty: string
  confidence: 'HIGH' | 'MED' | 'LOW'
  status: CountStatus
}

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

function confidenceLabelFor(confidence: number): 'HIGH' | 'MED' | 'LOW' {
  if (confidence >= REVIEW_CONFIDENCE_FLOOR) return 'HIGH'
  if (confidence >= 0.5) return 'MED'
  return 'LOW'
}

function formatQty(value: number, unit: string): string {
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100
  return `${rounded.toLocaleString()} ${unit.toUpperCase()}`
}

function quantityToDetection(q: CapturedQuantity): CountDetection {
  return {
    id: q.id,
    label: q.description || q.masterformatCode || q.uniformatCode || q.id,
    qty: formatQty(q.value, q.unit),
    confidence: confidenceLabelFor(q.confidence),
    status: statusForConfidence(q.confidence),
  }
}

/**
 * Resolve the draft id to review: prefer the one handed over by the setup
 * screen via navigation state; otherwise fall back to the most-recent
 * capture-sourced draft for the project (covers deep-links / refresh).
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

// Marker positions in the review canvas (x, y, low?) — verbatim from mockup.
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

// Mono Y/N chip mirroring the keyboard keep/reject contract for click users.
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

// Per-detection review decision. 'pending' detections inherit their AI status
// until the estimator keeps/rejects them with Y/N (or a click).
type Decision = 'pending' | 'kept' | 'rejected'

export function EstAiCountReview() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  const draftId = useCountReviewDraftId(projectId)
  const resultQuery = useTakeoffDraftResult(draftId)
  const promote = usePromoteCapturedQuantities(projectId, draftId)

  // Real captured quantities, mapped into the detection row shape.
  const dets = useMemo<CountDetection[]>(
    () => (resultQuery.data?.takeoff_result.quantities ?? []).map(quantityToDetection),
    [resultQuery.data],
  )

  // Default the active row to the first flagged detection so the estimator
  // lands on the one that needs a decision, not row 0.
  const firstFlagged = useMemo(() => {
    const idx = dets.findIndex((d) => d.status !== 'ok')
    return idx >= 0 ? idx : 0
  }, [dets])
  const [active, setActive] = useState(firstFlagged)

  // Per-row keep/reject decisions. Keyed by detection id so reordering stays safe.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})

  const decisionFor = (d: CountDetection): Decision => decisions[d.id] ?? 'pending'
  const setDecision = (id: string, decision: Decision) => setDecisions((prev) => ({ ...prev, [id]: decision }))

  // J/K navigate · Y keep · N reject — the keyboard contract the banner
  // advertises. Acting on a row also advances to the next one so the estimator
  // can clear the flagged set without leaving the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack keys while typing in an input/textarea.
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      const key = e.key.toLowerCase()
      if (key === 'j') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, dets.length - 1))
      } else if (key === 'k') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
      } else if (key === 'y') {
        e.preventDefault()
        const d = dets[active]
        if (d) setDecision(d.id, 'kept')
        setActive((i) => Math.min(i + 1, dets.length - 1))
      } else if (key === 'n') {
        e.preventDefault()
        const d = dets[active]
        if (d) setDecision(d.id, 'rejected')
        setActive((i) => Math.min(i + 1, dets.length - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, dets])

  const total = dets.length
  // High-confidence detections are auto-kept; flagged rows are kept only once
  // the estimator explicitly keeps them. Rejected rows drop out of the count.
  const keptDets = dets.filter((d) => {
    const decision = decisionFor(d)
    if (decision === 'rejected') return false
    if (decision === 'kept') return true
    return d.status === 'ok'
  })
  const kept = keptDets.length
  const keptIds = keptDets.map((d) => d.id)
  const rejectedCount = dets.filter((d) => decisionFor(d) === 'rejected').length
  const approving = promote.isPending

  const approve = () => {
    if (!draftId || keptIds.length === 0 || promote.isPending) return
    promote.mutate(
      { quantity_ids: keptIds },
      { onSuccess: () => navigate(projectId ? `/desktop/estimate/${projectId}` : '/desktop/ai-queue') },
    )
  }

  return (
    <div className="d-content-full" style={{ position: 'relative' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', height: '100%' }}>
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
            {MARKERS.map(([x, y, low], i) => (
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
              {dets.filter((d) => d.status !== 'ok').length} LOW-CONF FLAGGED
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
          </div>
          {dets.map((d, i) => {
            const on = i === active
            const decision = decisionFor(d)
            return (
              <div
                key={d.id}
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
                <span style={{ width: 8, height: 8, background: statusBg(d.status) }} aria-hidden />
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
                  {d.label} · {d.qty}
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
                  <MPill tone={d.confidence === 'HIGH' ? 'green' : d.confidence === 'MED' ? 'amber' : 'red'}>
                    {d.confidence}
                  </MPill>
                )}
                {/* Y/N affordances mirror the keyboard contract for click users. */}
                <span style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    aria-label={`Keep ${d.id}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setActive(i)
                      setDecision(d.id, 'kept')
                    }}
                    style={decisionChip(decision === 'kept', 'keep')}
                  >
                    Y
                  </button>
                  <button
                    type="button"
                    aria-label={`Reject ${d.id}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setActive(i)
                      setDecision(d.id, 'rejected')
                    }}
                    style={decisionChip(decision === 'rejected', 'reject')}
                  >
                    N
                  </button>
                </span>
              </div>
            )
          })}
          {!resultQuery.isLoading && dets.length === 0 ? (
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
  )
}
