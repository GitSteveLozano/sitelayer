/**
 * `mb-takeoff-ai-takeoff` — mobile AI auto-takeoff setup + review.
 *
 * Ported from Steve's v2 master-flow mockup `V2AITakeoffSetup`
 * ("TAKEOFF · SETUP") and `V2EstAutoTakeoffReview` ("TAKEOFF · REVIEW") for
 * MOBILE. Two route-able screens:
 *   - TakeoffAiTakeoffSetup  — toggle which scope items to measure
 *     (symbol → item targets) + the sheet scope, then RUN. → review.
 *   - TakeoffAiTakeoffReview — accept/adjust the AI-detected quantities with
 *     per-row OK / REVIEW / FLAG status + confidence, then ACCEPT DRAFT.
 *
 * WIRED to the real capture pipeline. RUN posts to the takeoff-drafts
 * capture endpoint (kind=blueprint_vision, dry-run-safe JSON payload — no
 * Anthropic spend unless BLUEPRINT_VISION_MODE=live + ANTHROPIC_API_KEY are
 * set on the API), then routes to REVIEW carrying the real draft id. REVIEW
 * reads the draft's stored TakeoffResult and promotes the kept quantities to
 * committed `takeoff_measurements`.
 *
 * The target toggles + sheet scope copy stay presentational — the capture
 * endpoint takes no per-target/per-sheet selection today (GAP LIST: a scoped
 * blueprint_vision capture payload). They still gate RUN (≥1 target).
 */
import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { MButton, MI, MPill, Spark } from '../../components/m/index.js'
import {
  useCaptureTakeoffDraft,
  usePromoteCapturedQuantities,
  useTakeoffDraftResult,
  useTakeoffDrafts,
  type CapturedQuantity,
} from '../../lib/api/takeoff-drafts.js'

const sectionBar: React.CSSProperties = {
  padding: '10px 20px',
  background: 'var(--m-card-soft)',
  borderTop: '2px solid var(--m-ink)',
  borderBottom: '2px solid var(--m-ink)',
}

function TakeoffAppBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="m-topbar">
      <button type="button" className="m-topbar-back" aria-label="Back" onClick={onBack}>
        <MI.ChevLeft size={22} />
      </button>
      <div className="m-topbar-title">
        <div className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-flex', gap: 5 }}>
          <Spark size={11} state="strong" /> AI · AUTO-TAKEOFF
        </div>
        <div className="m-h1">{title}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setup — symbol → item targets + sheet scope + RUN.
// ---------------------------------------------------------------------------
type Target = { label: string; sub: string; on: boolean }

const TARGETS: Target[] = [
  { label: 'EXTERIOR WALLS · EPS', sub: 'AS NET AREA · 8FT DEFAULT HEIGHT', on: true },
  { label: 'BASECOAT', sub: 'MATCH EPS AREA', on: true },
  { label: 'FINISH COAT', sub: 'MATCH EPS AREA', on: true },
  { label: 'STONE VENEER', sub: 'FOOTPRINT FROM HATCH FILL', on: true },
  { label: 'WINDOW + DOOR DEDUCT', sub: 'CUT FROM WALL AREA', on: true },
  { label: 'SEALANT JOINTS', sub: 'LINEAR · PERIMETER', on: false },
]

export function TakeoffAiTakeoffSetup({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  const [targets, setTargets] = useState<Target[]>(TARGETS)
  const capture = useCaptureTakeoffDraft(projectId)

  const toggle = (idx: number) => setTargets((prev) => prev.map((t, i) => (i === idx ? { ...t, on: !t.on } : t)))
  const enabled = targets.filter((t) => t.on).length

  const run = () => {
    if (!projectId || capture.isPending) return
    // Dry-run-safe capture: the JSON-body path (no multipart PDF) always
    // falls back to the deterministic stub on the API, so this never incurs
    // live Anthropic spend regardless of the env mode.
    capture.mutate(
      { kind: 'blueprint_vision', name: 'AI auto-takeoff', payload: { dryRun: true } },
      {
        onSuccess: (res) =>
          navigate(`/projects/${projectId}/takeoff-ai/takeoff/review`, { state: { draftId: res.draft.id } }),
      },
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <TakeoffAppBar title="DEFINE TARGETS" onBack={() => navigate(`/projects/${projectId}/takeoff-ai`)} />

      <div style={sectionBar}>
        <div className="m-topbar-eyebrow">WHAT TO MEASURE</div>
      </div>
      <div style={{ padding: '14px 20px' }}>
        {targets.map((t, i) => (
          <button
            key={t.label}
            type="button"
            onClick={() => toggle(i)}
            aria-pressed={t.on}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '12px 0',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              background: 'transparent',
              border: 'none',
              borderBottom: i < targets.length - 1 ? '1px solid var(--m-line-2)' : 'none',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                background: t.on ? 'var(--m-accent)' : 'transparent',
                border: '2px solid var(--m-ink)',
                flexShrink: 0,
              }}
              aria-hidden
            />
            <span style={{ flex: 1, minWidth: 0, opacity: t.on ? 1 : 0.55 }}>
              <span style={{ display: 'block', fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>{t.label}</span>
              <span style={{ display: 'block', fontFamily: 'var(--m-num)', fontSize: 9, color: 'var(--m-ink-3)', marginTop: 3, fontWeight: 600 }}>
                {t.sub}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div style={sectionBar}>
        <div className="m-topbar-eyebrow">SHEETS</div>
      </div>
      <div style={{ padding: '14px 20px' }}>
        <div style={{ padding: '14px 16px', background: 'var(--m-card-soft)', border: '2px solid var(--m-ink)' }}>
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>ALL VERIFIED SHEETS · 22</div>
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, color: 'var(--m-ink-3)', marginTop: 4, fontWeight: 600 }}>
            A-101 · A-201..204 · M-101..104 · S-101..103 · …
          </div>
        </div>
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
        <MButton variant="primary" onClick={run} disabled={capture.isPending || enabled === 0}>
          {capture.isPending ? 'Drafting…' : `Run · Draft 22 sheets · ${enabled} targets · ~3m`}
        </MButton>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Review — accept/adjust AI-detected quantities (from the real captured
// TakeoffResult), then promote the kept ones to committed measurements.
// ---------------------------------------------------------------------------
type ReviewStatus = 'ok' | 'review' | 'flag'

/** Confidence floor mirrors the API's review_required gate (q.confidence < 0.5). */
function statusForConfidence(confidence: number): ReviewStatus {
  if (confidence >= 0.8) return 'ok'
  if (confidence >= 0.5) return 'review'
  return 'flag'
}

function confidenceLabel(confidence: number): 'HIGH' | 'MED' | 'LOW' {
  if (confidence >= 0.8) return 'HIGH'
  if (confidence >= 0.5) return 'MED'
  return 'LOW'
}

function statusColor(status: ReviewStatus): string {
  return status === 'ok' ? 'var(--m-green)' : status === 'review' ? 'var(--m-amber)' : 'var(--m-red)'
}

function formatQty(value: number, unit: string): string {
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100
  return `${rounded.toLocaleString()} ${unit.toUpperCase()}`
}

/**
 * Resolve the draft id to review: prefer the one handed over by the setup
 * screen via navigation state; otherwise fall back to the most-recent
 * capture-sourced draft for the project (covers deep-links / refresh).
 */
function useReviewDraftId(projectId: string): string | null {
  const location = useLocation()
  const stateDraftId =
    location.state && typeof location.state === 'object' && 'draftId' in location.state
      ? String((location.state as { draftId?: unknown }).draftId ?? '')
      : ''
  const draftsQuery = useTakeoffDrafts(stateDraftId ? null : projectId)
  if (stateDraftId) return stateDraftId
  const latestCapture = (draftsQuery.data?.drafts ?? [])
    .filter((d) => d.source && d.source !== 'manual')
    .at(-1)
  return latestCapture?.id ?? null
}

export function TakeoffAiTakeoffReview({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  const draftId = useReviewDraftId(projectId)
  const resultQuery = useTakeoffDraftResult(draftId)
  const promote = usePromoteCapturedQuantities(projectId, draftId)

  const quantities = useMemo<CapturedQuantity[]>(
    () => resultQuery.data?.takeoff_result.quantities ?? [],
    [resultQuery.data],
  )

  // Per-quantity keep/drop decisions. OK rows default kept; review/flag rows
  // are kept by default too (the operator can drop them) but surfaced for a
  // closer look. Keyed by quantity id so the promote payload is exact.
  const [dropped, setDropped] = useState<Record<string, boolean>>({})
  const toggleDrop = (id: string) => setDropped((prev) => ({ ...prev, [id]: !prev[id] }))

  const counts = useMemo(
    () =>
      quantities.reduce(
        (acc, q) => {
          acc[statusForConfidence(q.confidence)] += 1
          return acc
        },
        { ok: 0, review: 0, flag: 0 } as Record<ReviewStatus, number>,
      ),
    [quantities],
  )
  const needsReview = counts.review + counts.flag
  const keptIds = useMemo(() => quantities.filter((q) => !dropped[q.id]).map((q) => q.id), [quantities, dropped])

  const accept = () => {
    if (!draftId || keptIds.length === 0 || promote.isPending) return
    promote.mutate(
      { quantity_ids: keptIds },
      { onSuccess: () => navigate(`/projects/${projectId}/takeoff-mobile`) },
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <TakeoffAppBar title="DRAFT REVIEW" onBack={() => navigate(`/projects/${projectId}/takeoff-ai/takeoff`)} />

      <div style={{ padding: 20, borderBottom: '2px solid var(--m-ink)' }}>
        <span
          className="m-topbar-eyebrow"
          style={{ display: 'inline-block', background: 'var(--m-green)', color: '#fff', padding: '3px 8px' }}
        >
          {resultQuery.data?.source ? `SOURCE · ${resultQuery.data.source.toUpperCase()}` : 'AI DRAFT'}
        </span>
        <h2
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 28,
            letterSpacing: '-0.02em',
            marginTop: 12,
            color: 'var(--m-ink)',
          }}
        >
          {resultQuery.isLoading
            ? 'Loading draft…'
            : quantities.length > 0
              ? `${quantities.length} detected ${quantities.length === 1 ? 'quantity' : 'quantities'}.`
              : 'No quantities detected.'}
        </h2>
        <div style={{ fontFamily: 'var(--m-num)', fontSize: 12, marginTop: 10, color: 'var(--m-ink-2)', fontWeight: 600 }}>
          {counts.ok} OK · {counts.review} NEEDS REVIEW · {counts.flag} FLAGGED
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {resultQuery.isError ? (
          <div style={{ padding: 20, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-red)', fontWeight: 600 }}>
            Couldn&apos;t load the draft result. {resultQuery.error.message}
          </div>
        ) : null}
        {!resultQuery.isLoading && !resultQuery.isError && quantities.length === 0 ? (
          <div style={{ padding: 20, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600 }}>
            {draftId ? 'This draft has no detected quantities to review.' : 'Run the auto-takeoff to produce a draft.'}
          </div>
        ) : null}
        {quantities.map((q) => {
          const status = statusForConfidence(q.confidence)
          const isDropped = Boolean(dropped[q.id])
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => toggleDrop(q.id)}
              aria-pressed={!isDropped}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '14px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--m-line-2)',
                opacity: isDropped ? 0.4 : 1,
                cursor: 'pointer',
              }}
            >
              <span style={{ width: 8, alignSelf: 'stretch', background: statusColor(status) }} aria-hidden />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 700,
                    fontSize: 15,
                    textDecoration: isDropped ? 'line-through' : 'none',
                  }}
                >
                  {q.description || q.masterformatCode || q.uniformatCode || q.id}
                </div>
                <div style={{ marginTop: 4 }}>
                  <MPill tone={status === 'ok' ? 'green' : status === 'review' ? 'amber' : 'red'} dot>
                    {confidenceLabel(q.confidence)} · {isDropped ? 'DROPPED' : 'KEEPING'}
                  </MPill>
                </div>
              </div>
              <div style={{ fontFamily: 'var(--m-num)', fontSize: 14, fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {formatQty(q.value, q.unit)}
              </div>
            </button>
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
      <div style={{ padding: '14px 20px', borderTop: '2px solid var(--m-ink)', display: 'flex', gap: 8 }}>
        <MButton variant="ghost" onClick={() => navigate(`/projects/${projectId}/takeoff-ai/takeoff`)} style={{ flex: 1 }}>
          Review {needsReview}
        </MButton>
        <MButton
          variant="primary"
          onClick={accept}
          disabled={promote.isPending || keptIds.length === 0 || !draftId}
          style={{ flex: 2 }}
        >
          {promote.isPending ? 'Promoting…' : `Accept ${keptIds.length} kept`}
        </MButton>
      </div>
    </div>
  )
}
