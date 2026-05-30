/**
 * Estimator desktop · AI Auto-Takeoff (Desktop v2 · ported from Steve's
 * mockup `DAITakeoffSetup` in /tmp/steve3/03_app.js + `DAITakeoffReview` in
 * /tmp/steve3/04_app.js).
 *
 * Two route-able screens:
 *   - EstAiTakeoffSetup — choose symbol→item targets + sheet scope, then run
 *     the AI auto-takeoff. Renders a faint blueprint backdrop with the float
 *     palette over it (mirrors the mockup's `dt-float` chrome translated to
 *     the repo's `--m-*` tokens).
 *   - EstAiTakeoffReview — accept/adjust the AI-detected quantities and
 *     "ACCEPT DRAFT". OK rows are kept; review/flag rows get a Review action.
 *
 * WIRED to the real capture pipeline. Setup RUN posts to the takeoff-drafts
 * capture endpoint (kind=blueprint_vision, dry-run-safe JSON payload — no
 * Anthropic spend unless BLUEPRINT_VISION_MODE=live + ANTHROPIC_API_KEY are set
 * on the API) and routes to REVIEW carrying the real draft id. REVIEW reads the
 * draft's stored TakeoffResult and promotes the kept quantities to committed
 * `takeoff_measurements` via .../:draftId/promote.
 *
 * The symbol→item target toggles + sheet scope stay presentational — the
 * capture endpoint takes no per-target/per-sheet selection (GAP LIST). They
 * still gate RUN (≥1 target).
 */
import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DLoadingState, type DColumn } from '@/components/d'
import { MAiStripe, MButton, MPill } from '@/components/m'
import {
  useCaptureTakeoffDraft,
  usePromoteCapturedQuantities,
  useTakeoffDraftResult,
  useTakeoffDrafts,
  type CapturedQuantity,
} from '@/lib/api/takeoff-drafts'

// ---------------------------------------------------------------------------
// Shared blueprint backdrop + floating-palette chrome (translated from the
// mockup's DCanvasBackdrop9 / .dt-float / .dt-float-head into repo --m-* tokens).
// ---------------------------------------------------------------------------
function TakeoffBackdrop({ children }: { children?: React.ReactNode }) {
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
          <pattern id="ai-takeoff-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" stroke="var(--m-ink-3)" strokeWidth="0.5" fill="none" />
          </pattern>
        </defs>
        <rect width="1208" height="836" fill="url(#ai-takeoff-grid)" />
        <rect x="300" y="200" width="620" height="420" fill="none" stroke="var(--m-ink)" strokeWidth="3" />
        {children}
      </svg>
    </div>
  )
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

const label: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--m-ink-3)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

// ---------------------------------------------------------------------------
// EstAiTakeoffSetup — symbol→item targets + sheet scope + RUN.
// ---------------------------------------------------------------------------
type TakeoffTarget = {
  sym: string
  item: string
  param: string
  on: boolean
}

const SETUP_TARGETS: TakeoffTarget[] = [
  { sym: 'EXT WALLS', item: 'EPS · 2"', param: 'NET AREA · 8FT DEF', on: true },
  { sym: 'BASECOAT', item: 'Basecoat', param: 'MATCH EPS', on: true },
  { sym: 'WIN/DOOR', item: 'Deduct', param: 'CUT FROM WALL', on: true },
  { sym: 'STONE HATCH', item: 'Stone veneer', param: 'FOOTPRINT', on: true },
  { sym: 'JOINT LINE', item: 'Sealant', param: 'LINEAR · PERIM', on: false },
]

export function EstAiTakeoffSetupPanel({
  projectId,
  onClose,
  onReviewDraft,
}: {
  projectId: string
  onClose: () => void
  onReviewDraft: (draftId: string) => void
}) {
  // Target toggles stay presentational (the capture endpoint takes no
  // per-target selection — GAP). They still gate RUN (≥1 target).
  const [targets, setTargets] = useState<TakeoffTarget[]>(SETUP_TARGETS)
  const capture = useCaptureTakeoffDraft(projectId)

  const toggleTarget = (index: number) => {
    setTargets((prev) => prev.map((t, i) => (i === index ? { ...t, on: !t.on } : t)))
  }

  const enabledCount = targets.filter((t) => t.on).length

  const runTakeoff = () => {
    if (!projectId || capture.isPending) return
    // Dry-run-safe capture (JSON body → deterministic stub on the API; no live
    // Anthropic spend). Carries the real draft id into the review lane.
    capture.mutate(
      { kind: 'blueprint_vision', name: 'AI auto-takeoff', payload: { dryRun: true } },
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
        width: 340,
        background: 'var(--m-card)',
        border: '2px solid var(--m-ink)',
        boxShadow: '6px 6px 0 var(--m-ink)',
        zIndex: 20,
      }}
    >
      <div style={{ ...floatHead, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>● AI · Draft the whole takeoff</span>
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
        <div style={label}>Targets · symbol → item</div>
        <div style={{ marginTop: 10, border: '2px solid var(--m-ink)' }}>
          {targets.map((t, i) => (
            <button
              key={t.sym}
              type="button"
              onClick={() => toggleTarget(i)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '10px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderBottom: i < targets.length - 1 ? '1px solid var(--m-line-2)' : 'none',
                background: t.on ? 'transparent' : 'var(--m-card-soft)',
                cursor: 'pointer',
              }}
              aria-pressed={t.on}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  background: t.on ? 'var(--m-accent)' : 'transparent',
                  border: '2px solid var(--m-ink)',
                  flexShrink: 0,
                }}
                aria-hidden
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 800 }}>
                  {t.sym} <span style={{ color: 'var(--m-ink-3)' }}>→ {t.item}</span>
                </span>
                <span
                  style={{
                    display: 'block',
                    fontFamily: 'var(--m-num)',
                    fontSize: 8,
                    color: 'var(--m-ink-3)',
                    marginTop: 2,
                    fontWeight: 600,
                  }}
                >
                  {t.param}
                </span>
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          style={{
            width: '100%',
            marginTop: 8,
            padding: 8,
            background: 'transparent',
            border: '2px dashed var(--m-line-2)',
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--m-ink-3)',
            cursor: 'pointer',
          }}
        >
          + ADD TARGET
        </button>

        <div style={{ ...label, marginTop: 16 }}>Sheet scope</div>
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: 'var(--m-card-soft)',
            border: '2px solid var(--m-ink)',
          }}
        >
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>ALL VERIFIED · 22 SHEETS</div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 9,
              color: 'var(--m-ink-3)',
              marginTop: 3,
              fontWeight: 600,
            }}
          >
            A-101 · A-201..204 · M-101..104 · …
          </div>
        </div>

        <div
          style={{
            padding: '10px 12px',
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            marginTop: 14,
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          DRAFT 22 SHEETS · {enabledCount} TARGETS · ~3M · REVIEW BEFORE ACCEPT
        </div>
        <MButton variant="primary" onClick={runTakeoff} disabled={capture.isPending || enabledCount === 0}>
          {capture.isPending ? 'Drafting…' : 'Run auto-takeoff →'}
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
  )
}

// ---------------------------------------------------------------------------
// EstAiTakeoffSetup — full-page route shim (faint backdrop + the panel).
// ---------------------------------------------------------------------------
export function EstAiTakeoffSetup() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  return (
    <div className="d-content-full" style={{ position: 'relative' }}>
      <TakeoffBackdrop>
        <polygon
          points="320,220 600,222 602,400 318,398"
          fill="rgba(255,212,0,0.30)"
          stroke="var(--m-ink)"
          strokeWidth="2"
        />
      </TakeoffBackdrop>
      <EstAiTakeoffSetupPanel
        projectId={projectId}
        onClose={() => navigate(projectId ? `/desktop/canvas/${projectId}` : '/desktop/ai-queue')}
        onReviewDraft={(id) => navigate(`/desktop/ai-takeoff/${projectId}/review`, { state: { draftId: id } })}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// EstAiTakeoffReview — accept/adjust AI-detected quantities (from the real
// captured TakeoffResult), then promote the kept ones to committed
// `takeoff_measurements`.
// ---------------------------------------------------------------------------
type TakeoffStatus = 'ok' | 'review' | 'flag'

type TakeoffReviewRow = {
  id: string
  item: string
  qty: string
  confidence: 'HIGH' | 'MED' | 'LOW'
  status: TakeoffStatus
}

// Mirrors REVIEW_REQUIRED_CONFIDENCE_FLOOR (0.7) in @sitelayer/capture-schema:
// the API flags any captured quantity below this as review_required. Keep in sync.
const REVIEW_CONFIDENCE_FLOOR = 0.7

/** Rows at/above the API review floor are safe to keep by default; below it the
 * estimator must review before accepting. <0.5 is flagged as low-confidence. */
function statusForConfidence(confidence: number): TakeoffStatus {
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

function quantityToRow(q: CapturedQuantity): TakeoffReviewRow {
  return {
    id: q.id,
    item: q.description || q.masterformatCode || q.uniformatCode || q.id,
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
function useTakeoffReviewDraftId(projectId: string): string | null {
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

// Status accent bar color — the amber/review tone maps to the accent token.
function statusBar(status: TakeoffStatus): string {
  return status === 'ok' ? 'var(--m-green)' : status === 'review' ? 'var(--m-accent)' : 'var(--m-red)'
}

function confidenceTone(confidence: TakeoffReviewRow['confidence']): 'green' | 'amber' | 'red' {
  return confidence === 'HIGH' ? 'green' : confidence === 'MED' ? 'amber' : 'red'
}

// Per-row review decision. OK rows are kept by default; review/flag rows stay
// 'pending' until the estimator keeps or rejects them.
type RowDecision = 'pending' | 'kept' | 'rejected'

export function EstAiTakeoffReview() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  const draftId = useTakeoffReviewDraftId(projectId)
  const resultQuery = useTakeoffDraftResult(draftId)
  const promote = usePromoteCapturedQuantities(projectId, draftId)

  const rows = useMemo<TakeoffReviewRow[]>(
    () => (resultQuery.data?.takeoff_result.quantities ?? []).map(quantityToRow),
    [resultQuery.data],
  )

  // Real local decision state so Keep/Reject update the UI + KPIs. High-
  // confidence rows default to kept; flagged/review rows wait for a decision.
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({})
  const decisionFor = (r: TakeoffReviewRow): RowDecision => decisions[r.id] ?? (r.status === 'ok' ? 'kept' : 'pending')
  const setDecision = (id: string, decision: RowDecision) => setDecisions((prev) => ({ ...prev, [id]: decision }))

  const counts = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc[r.status] += 1
        return acc
      },
      { ok: 0, review: 0, flag: 0 } as Record<TakeoffStatus, number>,
    )
  }, [rows])

  // Live keep/reject tallies drive the accept affordance + KPI meta.
  const keptIds = rows.filter((r) => decisionFor(r) === 'kept').map((r) => r.id)
  const keptCount = keptIds.length
  const rejectedCount = rows.filter((r) => decisionFor(r) === 'rejected').length
  const pendingCount = rows.filter((r) => decisionFor(r) === 'pending').length

  const acceptDraft = () => {
    if (!draftId || keptCount === 0 || promote.isPending) return
    // Promote only the kept rows into committed `takeoff_measurements`, then
    // route to the project's estimate where the new scope shows up.
    promote.mutate(
      { quantity_ids: keptIds },
      { onSuccess: () => navigate(projectId ? `/desktop/estimate/${projectId}` : '/desktop/ai-queue') },
    )
  }
  const accepting = promote.isPending

  const columns: Array<DColumn<TakeoffReviewRow>> = [
    {
      key: 'status',
      header: '',
      render: (r) => (
        <span style={{ display: 'inline-block', width: 8, height: 28, background: statusBar(r.status) }} aria-hidden />
      ),
    },
    {
      key: 'item',
      header: 'Item',
      render: (r) => (
        <span
          className="d-table-cell-strong"
          style={
            decisionFor(r) === 'rejected' ? { textDecoration: 'line-through', color: 'var(--m-ink-3)' } : undefined
          }
        >
          {r.item}
        </span>
      ),
    },
    {
      key: 'confidence',
      header: 'Confidence',
      render: (r) => (
        <MPill tone={confidenceTone(r.confidence)} dot>
          {r.confidence === 'HIGH' ? 'High' : r.confidence === 'MED' ? 'Medium' : 'Low'}
        </MPill>
      ),
    },
    { key: 'qty', header: 'Qty', numeric: true, render: (r) => r.qty },
    {
      key: 'action',
      header: '',
      numeric: true,
      render: (r) => {
        const decision = decisionFor(r)
        return (
          <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
            <MButton
              size="sm"
              variant={decision === 'kept' ? 'primary' : 'ghost'}
              onClick={() => setDecision(r.id, 'kept')}
            >
              Keep
            </MButton>
            <MButton
              size="sm"
              variant={decision === 'rejected' ? 'primary' : 'ghost'}
              onClick={() => setDecision(r.id, 'rejected')}
            >
              Reject
            </MButton>
          </span>
        )
      },
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <DEyebrow>
              {resultQuery.data?.source ? `Source · ${resultQuery.data.source}` : 'AI auto-takeoff'} · {rows.length}{' '}
              items
            </DEyebrow>
            <DH1>Review draft</DH1>
          </div>
          <MButton variant="primary" onClick={acceptDraft} disabled={accepting || keptCount === 0 || !draftId}>
            {accepting ? 'Promoting…' : `Accept ${keptCount} kept`}
          </MButton>
        </div>

        {promote.isError ? (
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700, color: 'var(--m-red)' }}>
            ● {promote.error.message || 'Promote failed — try again.'}
          </div>
        ) : null}

        <MAiStripe
          eyebrow="AI auto-takeoff"
          title="Detected quantities — review before they hit the estimate"
          attribution="Auto-takeoff · review required"
        >
          The AI read every verified sheet and produced one row per scope item. High-confidence rows are kept as-is;
          medium and low-confidence rows are flagged for a closer look. Nothing is committed until you accept the draft.
        </MAiStripe>

        <DKpiStrip>
          <DKpi
            label="Kept"
            value={String(keptCount)}
            meta={`${counts.ok} high-confidence`}
            metaTone={keptCount > 0 ? 'good' : undefined}
          />
          <DKpi
            label="Pending"
            value={String(pendingCount)}
            tone={pendingCount > 0 ? 'accent' : undefined}
            meta={pendingCount > 0 ? 'Needs a decision' : 'All reviewed'}
          />
          <DKpi
            label="Rejected"
            value={String(rejectedCount)}
            meta={rejectedCount > 0 ? 'Dropped from draft' : 'None'}
            metaTone={rejectedCount > 0 ? 'bad' : undefined}
          />
        </DKpiStrip>

        {accepting ? (
          <DLoadingState label="Promoting accepted quantities…" />
        ) : resultQuery.isLoading ? (
          <DLoadingState label="Loading captured draft…" />
        ) : resultQuery.isError ? (
          <DataTable<TakeoffReviewRow>
            title="AI takeoff draft"
            columns={columns}
            rows={[]}
            rowKey={(r) => r.id}
            empty={`Couldn't load the draft result. ${resultQuery.error.message}`}
          />
        ) : (
          <DataTable<TakeoffReviewRow>
            title="AI takeoff draft"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            empty={
              draftId
                ? 'This draft has no detected quantities.'
                : 'No detected quantities. Run the auto-takeoff to populate this draft.'
            }
          />
        )}
      </div>
    </div>
  )
}
