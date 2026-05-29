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
 * There is no company-wide AI-drafts feed hook yet (same gap noted in
 * est-ai-queue.tsx), so the mockup's demo targets/rows stay as presentational
 * content. The real run/accept handlers are local-state no-ops wired to the UI
 * — a TODO marks where the capture pipeline
 * (POST /api/projects/:id/takeoff-drafts/capture + .../:draftId/promote) lands.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DLoadingState, type DColumn } from '@/components/d'
import { MAiStripe, MButton, MPill } from '@/components/m'

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

export function EstAiTakeoffSetup() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  // Demo targets stay presentational; the on/off toggles are real local state
  // so the palette is interactive. // TODO: persist targets + run the capture
  // pipeline (POST /api/projects/:id/takeoff-drafts/capture) once wired.
  const [targets, setTargets] = useState<TakeoffTarget[]>(SETUP_TARGETS)
  const [running, setRunning] = useState(false)

  const toggleTarget = (index: number) => {
    setTargets((prev) => prev.map((t, i) => (i === index ? { ...t, on: !t.on } : t)))
  }

  const enabledCount = targets.filter((t) => t.on).length

  const runTakeoff = () => {
    setRunning(true)
    // No capture pipeline run yet — jump straight to the review lane so the
    // estimator can see what the AI produced.
    navigate(projectId ? `/desktop/ai-takeoff/${projectId}/review` : '/desktop/ai-queue')
  }

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

      <div
        style={{
          position: 'absolute',
          top: 24,
          right: 24,
          width: 340,
          background: 'var(--m-card)',
          border: '2px solid var(--m-ink)',
          boxShadow: '6px 6px 0 var(--m-ink)',
        }}
      >
        <div style={floatHead}>● AI · Draft the whole takeoff</div>
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
          <MButton variant="primary" onClick={runTakeoff} disabled={running || enabledCount === 0}>
            {running ? 'Starting…' : 'Run auto-takeoff →'}
          </MButton>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EstAiTakeoffReview — accept/adjust AI-detected quantities, ACCEPT DRAFT.
// ---------------------------------------------------------------------------
type TakeoffStatus = 'ok' | 'review' | 'flag'

type TakeoffReviewRow = {
  id: string
  item: string
  qty: string
  confidence: 'HIGH' | 'MED' | 'LOW'
  status: TakeoffStatus
}

const REVIEW_ROWS: TakeoffReviewRow[] = [
  { id: 'eps-2', item: 'EPS Board · 2"', qty: '4,785 SF', confidence: 'HIGH', status: 'ok' },
  { id: 'basecoat', item: 'Basecoat · polymer', qty: '4,785 SF', confidence: 'HIGH', status: 'ok' },
  { id: 'stone', item: 'Stone veneer', qty: '420 SF', confidence: 'HIGH', status: 'ok' },
  { id: 'sealant', item: 'Sealant joint', qty: '320 LF', confidence: 'MED', status: 'review' },
  { id: 'diffuser', item: 'Diffuser · 24"', qty: '214 EA', confidence: 'HIGH', status: 'ok' },
  { id: 'flashing', item: 'Parapet flashing', qty: '180 LF', confidence: 'LOW', status: 'flag' },
]

// Status accent bar color — the amber/review tone maps to the accent token.
function statusBar(status: TakeoffStatus): string {
  return status === 'ok' ? 'var(--m-green)' : status === 'review' ? 'var(--m-accent)' : 'var(--m-red)'
}

function confidenceTone(confidence: TakeoffReviewRow['confidence']): 'green' | 'amber' | 'red' {
  return confidence === 'HIGH' ? 'green' : confidence === 'MED' ? 'amber' : 'red'
}

export function EstAiTakeoffReview() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  // Demo draft stays presentational. // TODO: back with a real draft snapshot
  // from the capture pipeline (takeoff_drafts.source='blueprint_vision') and
  // promote selected quantities via .../:draftId/promote.
  const rows = useMemo<TakeoffReviewRow[]>(() => REVIEW_ROWS, [])

  const counts = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc[r.status] += 1
        return acc
      },
      { ok: 0, review: 0, flag: 0 } as Record<TakeoffStatus, number>,
    )
  }, [rows])

  const [accepting, setAccepting] = useState(false)
  const acceptDraft = () => {
    setAccepting(true)
    // No promote endpoint wired yet — route to the project's quantities review.
    navigate(projectId ? `/desktop/estimate/${projectId}` : '/desktop/ai-queue')
  }

  const columns: Array<DColumn<TakeoffReviewRow>> = [
    {
      key: 'status',
      header: '',
      render: (r) => (
        <span style={{ display: 'inline-block', width: 8, height: 28, background: statusBar(r.status) }} aria-hidden />
      ),
    },
    { key: 'item', header: 'Item', render: (r) => <span className="d-table-cell-strong">{r.item}</span> },
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
      render: (r) =>
        r.status === 'ok' ? (
          <MPill tone="green" dot>
            Keep
          </MPill>
        ) : (
          <MButton size="sm" variant="ghost" onClick={() => {}}>
            Review
          </MButton>
        ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <DEyebrow>Drafted in 42s · 6 items · 22 sheets</DEyebrow>
            <DH1>Review draft</DH1>
          </div>
          <MButton variant="primary" onClick={acceptDraft} disabled={accepting}>
            {accepting ? 'Accepting…' : 'Accept draft'}
          </MButton>
        </div>

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
            label="OK"
            value={String(counts.ok)}
            meta="High confidence"
            metaTone={counts.ok > 0 ? 'good' : undefined}
          />
          <DKpi
            label="Review"
            value={String(counts.review)}
            tone={counts.review > 0 ? 'accent' : undefined}
            meta="Needs a look"
          />
          <DKpi
            label="Flagged"
            value={String(counts.flag)}
            meta={counts.flag > 0 ? 'Low confidence' : 'None'}
            metaTone={counts.flag > 0 ? 'bad' : undefined}
          />
        </DKpiStrip>

        {accepting ? (
          <DLoadingState label="Promoting accepted quantities…" />
        ) : (
          <DataTable<TakeoffReviewRow>
            title="AI takeoff draft"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            empty="No detected quantities. Run the auto-takeoff to populate this draft."
          />
        )}
      </div>
    </div>
  )
}
