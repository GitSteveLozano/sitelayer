import { useEffect, useState } from 'react'
import { AgentSurface, AiEyebrow, Attribution, Spark, useRejectSheet, type SparkState } from '@/components/ai'
import { Card, MobileButton } from '@/components/mobile'
import {
  usePromoteCapturedQuantities,
  useTakeoffDraftResult,
  type CapturedQuantity,
  type TakeoffDraft,
} from '@/lib/api'

// AI-captured quantity review/promote surface — extracted from v1
// takeoff-canvas.tsx so the consolidated est-canvas editor can review and
// promote captured proposals (closing the capture→review→promote loop).
// Confidence is ordinal (never a percent); the promote endpoint is additive /
// idempotent on the server.

/**
 * `AgentSuggestionsPanel` — operator review surface for the AI-captured
 * `TakeoffResult.quantities[]` stashed on a draft (Phase C.3, redesigned to
 * use the calm-AI design language documented in `AI Layer.html` and
 * `ai-keystone.jsx`).
 *
 * Each captured quantity gets its own dashed-border `AgentSurface` card
 * with three equal-weight actions:
 *   - Confirm  → POST to /promote with `quantity_ids: [thisOne]`. Picks up
 *                the inline `service_item_code` edit when the operator
 *                retyped the captured code.
 *   - Edit     → toggles an inline service_item_code input. Persisted as
 *                the next Confirm's override.
 *   - Reject   → opens `RejectSheet` with four structured reasons
 *                (`wrong_code`, `wrong_quantity`, `not_in_scope`, `other`).
 *                Rejected quantities hide for the session (we don't have
 *                a backend yet for rejection signals — keeping that as a
 *                follow-on PR per the spec).
 *
 * Confidence is ordinal, never a numeric percent (the hard rule from
 * `AI Layer.html`). High ≥0.85 → `Spark state="strong"` and pre-staged for
 * the bulk "Confirm all high-confidence" CTA. Medium 0.6–0.85 → `accent`,
 * offered one-by-one. Low <0.6 → hidden behind a "Show low-confidence (N)"
 * disclosure so the canvas isn't drowned in noise on a bad capture.
 *
 * The captured result on the draft is left intact so a later operator can
 * still re-promote the same quantities under different codes if needed —
 * the promote endpoint is additive and idempotent in that sense.
 */
interface AgentSuggestionsPanelProps {
  projectId: string
  draft: TakeoffDraft
}

/** Ordinal confidence buckets — keep these in sync with the `Spark` states
 * mapped in `confidenceState` below. Hard rule from `AI Layer.html`:
 * confidence is **ordinal**, never a percentage. */
type ConfidenceBucket = 'high' | 'medium' | 'low'

function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence >= 0.85) return 'high'
  if (confidence >= 0.6) return 'medium'
  return 'low'
}

function confidenceState(bucket: ConfidenceBucket): SparkState {
  switch (bucket) {
    case 'high':
      return 'strong'
    case 'medium':
      return 'accent'
    case 'low':
      return 'muted'
  }
}

function confidenceLabel(bucket: ConfidenceBucket): string {
  switch (bucket) {
    case 'high':
      return 'High confidence'
    case 'medium':
      return 'Medium confidence'
    case 'low':
      return 'Low confidence'
  }
}

/** Four canonical rejection reasons, matching the spec. `RejectSheet`
 * renders these as equal-weight chips per the AI-layer anti-pattern rule
 * against free-text rejections. */
const TAKEOFF_REJECT_REASONS = ['wrong_code', 'wrong_quantity', 'not_in_scope', 'other'] as const

/** Pretty-print a capture source / provenance kind for the eyebrow line.
 * Matches the design intent ("Blueprint vision · captured 2m ago") rather
 * than spitting the raw enum at the operator. */
function formatSource(draftSource: string | undefined, provenanceKind: string | undefined): string {
  // Provenance is the more specific signal; fall back to draft source so
  // we always show something even when the pipeline emitted a minimal
  // provenance record.
  const raw = provenanceKind ?? draftSource ?? 'capture'
  switch (raw) {
    case 'blueprint_vision':
    case 'blueprint':
      return 'Blueprint vision'
    case 'roomplan':
      return 'RoomPlan capture'
    case 'photogrammetry':
      return 'Photogrammetry'
    case 'drone':
      return 'Drone capture'
    case 'manual':
      return 'Manual entry'
    case 'derived':
      return 'Derived'
    default:
      return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
}

/** Loose "2m ago" formatter — no need to pull in date-fns for one line.
 * Falls back to `captured just now` for the no-timestamp case so the
 * eyebrow doesn't read awkwardly. */
function formatRelativeTime(timestamp: string | undefined): string {
  if (!timestamp) return 'just now'
  const t = Date.parse(timestamp)
  if (!Number.isFinite(t)) return 'just now'
  const delta = Date.now() - t
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  return `${Math.round(delta / 86_400_000)}d ago`
}

/** Build the Attribution emphasis line. Names the source specifically per
 * the AI-layer rule (specificity is the trust signal — never "AI"). */
function attributionEmphasisFor(
  provenanceKind: string | undefined,
  draftSource: string | undefined,
  pipelineVersion: string | null | undefined,
): string {
  const base = (() => {
    switch (provenanceKind ?? draftSource) {
      case 'blueprint_vision':
      case 'blueprint':
        return 'Claude vision PDF extraction'
      case 'roomplan':
        return 'iPad RoomPlan capture'
      case 'photogrammetry':
        return 'photogrammetry mesh labels'
      case 'drone':
        return 'drone orthomosaic sidecar'
      case 'derived':
        return 'derived from prior quantities'
      default:
        return 'capture pipeline'
    }
  })()
  return pipelineVersion ? `${base} (v${pipelineVersion})` : base
}

export function AgentSuggestionsPanel({ projectId, draft }: AgentSuggestionsPanelProps) {
  const result = useTakeoffDraftResult(draft.id)
  const promote = usePromoteCapturedQuantities(projectId, draft.id)
  const [rejectNode, askReject] = useRejectSheet()
  // Per-quantity inline edit toggle + override value. Persists across
  // renders so the operator can stage edits before Confirming.
  const [editing, setEditing] = useState<Set<string>>(new Set())
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  // Session-scoped rejection state. We don't have a backend signal for
  // structured takeoff rejections yet (the spec calls it out as optional);
  // hiding rejected quantities until the page reloads is the lightest
  // honest UX — operators can refresh to bring them back.
  const [rejected, setRejected] = useState<Record<string, string>>({})
  // Track which row is currently in-flight so we can disable just that
  // card's buttons rather than the whole panel. The promote mutation is
  // shared so we serialise per-id via this state.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  // Disclosure for low-confidence rows. Defaults to hidden per the design
  // rule "low → hidden by default behind 'Show low-confidence (N)'".
  const [showLow, setShowLow] = useState(false)

  // Pre-fill the override input with the captured code so the operator
  // only has to type when they actually want to remap. Live updates so
  // newly-captured drafts (capture → switch → here) hydrate correctly.
  useEffect(() => {
    if (!result.data) return
    setOverrides((prev) => {
      const next: Record<string, string> = { ...prev }
      for (const q of result.data.takeoff_result.quantities) {
        if (next[q.id] === undefined) {
          next[q.id] = derivedCodeFor(q) ?? ''
        }
      }
      return next
    })
  }, [result.data])

  const quantities = result.data?.takeoff_result.quantities ?? []
  const pipelineVersion = result.data?.pipeline_version ?? draft.pipeline_version ?? null
  // The capture pipelines stamp `producedAt`/`capturedAt` onto the result;
  // fall back to the draft's `created_at` so we always have a usable
  // timestamp for the eyebrow line.
  const capturedAt =
    (result.data?.takeoff_result as { producedAt?: string; capturedAt?: string } | undefined)?.producedAt ??
    (result.data?.takeoff_result as { producedAt?: string; capturedAt?: string } | undefined)?.capturedAt ??
    draft.created_at

  const visible = quantities.filter((q) => !rejected[q.id])
  const highConfidence = visible.filter((q) => confidenceBucket(q.confidence) === 'high')
  const mediumConfidence = visible.filter((q) => confidenceBucket(q.confidence) === 'medium')
  const lowConfidence = visible.filter((q) => confidenceBucket(q.confidence) === 'low')

  const onConfirm = (q: CapturedQuantity) => {
    setError(null)
    setSummary(null)
    setBusyId(q.id)
    const candidate = (overrides[q.id] ?? '').trim()
    const derived = derivedCodeFor(q) ?? ''
    // Only forward the override when the operator actually retyped — the
    // server falls back to the AI-derived MasterFormat/UniFormat/OmniClass
    // code otherwise (and bypasses the curated-catalog gate for review).
    const overridesToSend: Record<string, string> = {}
    if (candidate.length > 0 && candidate !== derived) {
      overridesToSend[q.id] = candidate
    }
    promote.mutate(
      {
        quantity_ids: [q.id],
        ...(Object.keys(overridesToSend).length > 0 ? { service_item_code_overrides: overridesToSend } : {}),
      },
      {
        onSuccess: (res) => {
          setBusyId(null)
          // Promotion is additive on the server — hide the quantity from
          // the suggestion panel so the operator doesn't see it twice. The
          // promoted row already shows up in the canvas measurement list.
          setRejected((prev) => ({ ...prev, [q.id]: 'confirmed' }))
          setEditing((prev) => {
            const next = new Set(prev)
            next.delete(q.id)
            return next
          })
          const parts = [`Confirmed ${res.promoted_count}.`]
          if (res.skipped_count > 0) parts.push(`Skipped ${res.skipped_count}.`)
          setSummary(parts.join(' '))
        },
        onError: (err) => {
          setBusyId(null)
          setError(err instanceof Error ? err.message : 'Confirm failed')
        },
      },
    )
  }

  const onBulkConfirmHigh = () => {
    setError(null)
    setSummary(null)
    if (highConfidence.length === 0) return
    setBusyId('__bulk__')
    const ids = highConfidence.map((q) => q.id)
    // Bulk path doesn't apply per-row edits — operators that want to
    // remap a code should Confirm that row individually. Stick to the
    // canonical AI-derived codes so the server takes the fast path.
    promote.mutate(
      { quantity_ids: ids },
      {
        onSuccess: (res) => {
          setBusyId(null)
          setRejected((prev) => {
            const next = { ...prev }
            for (const id of ids) next[id] = 'confirmed'
            return next
          })
          const parts = [`Confirmed ${res.promoted_count}.`]
          if (res.skipped_count > 0) parts.push(`Skipped ${res.skipped_count}.`)
          setSummary(parts.join(' '))
        },
        onError: (err) => {
          setBusyId(null)
          setError(err instanceof Error ? err.message : 'Bulk confirm failed')
        },
      },
    )
  }

  const onToggleEdit = (id: string) => {
    setEditing((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const onReject = async (q: CapturedQuantity) => {
    const reason = await askReject({
      title: 'Reject this captured quantity?',
      body: 'Pick the closest match — this trains the model.',
      reasons: TAKEOFF_REJECT_REASONS,
    })
    if (reason === null) return
    setRejected((prev) => ({ ...prev, [q.id]: reason }))
    setSummary(`Rejected (${reason.replace(/_/g, ' ')}).`)
  }

  if (result.isLoading) {
    return (
      <Card tight>
        <AiEyebrow>Agent suggestions</AiEyebrow>
        <div className="text-[12px] text-ink-3 italic mt-1.5">Loading captured result…</div>
      </Card>
    )
  }

  if (result.isError || !result.data) {
    return (
      <Card tight>
        <AiEyebrow>Agent suggestions</AiEyebrow>
        <div className="text-[12px] text-ink-3 leading-snug mt-1.5">
          Capture from a blueprint or upload to see AI-suggested quantities.
        </div>
      </Card>
    )
  }

  if (quantities.length === 0) {
    return (
      <Card tight>
        <AiEyebrow>Agent suggestions</AiEyebrow>
        <div className="text-[12px] text-ink-3 leading-snug mt-1.5">
          The capture pipeline returned no quantities. Re-run the capture or escalate to manual takeoff.
        </div>
      </Card>
    )
  }

  if (visible.length === 0) {
    return (
      <Card tight>
        <AiEyebrow>Agent suggestions</AiEyebrow>
        <div className="text-[12px] text-ink-3 leading-snug mt-1.5">
          All {quantities.length} captured quantities have been confirmed or rejected this session.
        </div>
        {summary ? <div className="mt-1.5 text-[11px] text-ink-3">{summary}</div> : null}
      </Card>
    )
  }

  return (
    <div>
      <Card tight>
        <div className="flex items-baseline justify-between">
          <AiEyebrow>Agent suggestions · {visible.length} pending</AiEyebrow>
          {highConfidence.length > 0 ? (
            <button
              type="button"
              onClick={onBulkConfirmHigh}
              disabled={promote.isPending}
              className="text-[11px] font-semibold text-accent disabled:opacity-50"
            >
              {busyId === '__bulk__' ? 'Confirming…' : `Confirm all high-confidence (${highConfidence.length})`}
            </button>
          ) : null}
        </div>
        {summary ? <div className="mt-1.5 text-[11px] text-ink-3">{summary}</div> : null}
        {error ? <div className="mt-1.5 text-[12px] text-warn">{error}</div> : null}
      </Card>

      {/* High + medium confidence stack first; low confidence sits behind
          a disclosure per the design rule. AgentSurface contributes its own
          top margin so we don't need to add spacing between cards. */}
      {[...highConfidence, ...mediumConfidence].map((q) => (
        <AgentSuggestionCard
          key={q.id}
          quantity={q}
          draftSource={draft.source}
          pipelineVersion={pipelineVersion}
          capturedAt={capturedAt}
          override={overrides[q.id] ?? ''}
          isEditing={editing.has(q.id)}
          isBusy={busyId === q.id || promote.isPending}
          onOverrideChange={(value) => setOverrides((prev) => ({ ...prev, [q.id]: value }))}
          onConfirm={() => onConfirm(q)}
          onToggleEdit={() => onToggleEdit(q.id)}
          onReject={() => void onReject(q)}
        />
      ))}

      {lowConfidence.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowLow((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 bg-card-soft border border-line rounded text-[12px] font-medium text-ink-2"
          >
            <span className="flex items-center gap-2">
              <Spark state="muted" size={10} aria-label="" />
              {showLow ? 'Hide low-confidence' : `Show low-confidence (${lowConfidence.length})`}
            </span>
            <span className="text-ink-3">{showLow ? '−' : '+'}</span>
          </button>
          {showLow
            ? lowConfidence.map((q) => (
                <AgentSuggestionCard
                  key={q.id}
                  quantity={q}
                  draftSource={draft.source}
                  pipelineVersion={pipelineVersion}
                  capturedAt={capturedAt}
                  override={overrides[q.id] ?? ''}
                  isEditing={editing.has(q.id)}
                  isBusy={busyId === q.id || promote.isPending}
                  onOverrideChange={(value) => setOverrides((prev) => ({ ...prev, [q.id]: value }))}
                  onConfirm={() => onConfirm(q)}
                  onToggleEdit={() => onToggleEdit(q.id)}
                  onReject={() => void onReject(q)}
                />
              ))
            : null}
        </div>
      ) : null}

      {rejectNode}
    </div>
  )
}

/**
 * Single captured-quantity card rendered inside an `AgentSurface`.
 *
 * Layout follows `ai-keystone.jsx` §05a / `AI Layer.html`:
 *   - dashed border + corner banner ("Agent draft · review before sending")
 *   - eyebrow line with source + relative timestamp
 *   - title = `{value} {unit} · {service_item_code}` (per the spec)
 *   - body = short description from the captured quantity
 *   - `Attribution` line at the bottom naming the producing pipeline
 *   - three equal-weight buttons (Confirm / Edit / Reject)
 *
 * The Edit toggle reveals an inline `service_item_code` input; pressing
 * Confirm afterwards forwards the typed value as a per-quantity override.
 */
interface AgentSuggestionCardProps {
  quantity: CapturedQuantity
  draftSource: TakeoffDraft['source']
  pipelineVersion: string | null | undefined
  capturedAt: string
  override: string
  isEditing: boolean
  isBusy: boolean
  onOverrideChange: (value: string) => void
  onConfirm: () => void
  onToggleEdit: () => void
  onReject: () => void
}

function AgentSuggestionCard({
  quantity,
  draftSource,
  pipelineVersion,
  capturedAt,
  override,
  isEditing,
  isBusy,
  onOverrideChange,
  onConfirm,
  onToggleEdit,
  onReject,
}: AgentSuggestionCardProps) {
  const bucket = confidenceBucket(quantity.confidence)
  const sparkState = confidenceState(bucket)
  const provenanceKind = quantity.provenance?.kind
  const displayedCode = override.trim() || derivedCodeFor(quantity) || 'unknown code'
  const banner = `Agent draft · ${confidenceLabel(bucket).toLowerCase()}`
  return (
    <AgentSurface banner={banner}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">
            <Spark state={sparkState} size={11} aria-label={confidenceLabel(bucket)} />
            <span>
              {formatSource(draftSource, provenanceKind)} · captured {formatRelativeTime(capturedAt)}
            </span>
          </div>
          <div className="mt-1 text-[13px] font-semibold leading-tight">
            <span className="font-mono tabular-nums">
              {Number(quantity.value).toFixed(2)} {quantity.unit}
            </span>{' '}
            · <span className="font-mono">{displayedCode}</span>
          </div>
          {quantity.description ? (
            <div className="mt-1 text-[12px] text-ink-2 leading-snug">{quantity.description}</div>
          ) : null}
        </div>
      </div>

      {isEditing ? (
        <div className="mt-2 flex items-center gap-2">
          <label
            htmlFor={`agent-code-${quantity.id}`}
            className="text-[10px] uppercase tracking-[0.06em] text-ink-3 shrink-0"
          >
            Code
          </label>
          <input
            id={`agent-code-${quantity.id}`}
            type="text"
            value={override}
            onChange={(e) => onOverrideChange(e.target.value)}
            placeholder={derivedCodeFor(quantity) ?? 'service_item_code'}
            className="flex-1 min-w-0 px-2 py-1 rounded border border-line bg-card-soft text-[12px] font-mono"
          />
        </div>
      ) : null}

      <div className="mt-3 pt-2 border-t border-dashed border-line-2 flex items-center justify-between gap-2">
        <Attribution
          source="Based on"
          emphasis={attributionEmphasisFor(provenanceKind, draftSource, pipelineVersion)}
          state={sparkState}
        />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <MobileButton variant="primary" size="sm" fullWidth={false} onClick={onConfirm} disabled={isBusy}>
          {isBusy ? 'Working…' : 'Confirm'}
        </MobileButton>
        <MobileButton
          variant={isEditing ? 'quiet' : 'ghost'}
          size="sm"
          fullWidth={false}
          onClick={onToggleEdit}
          disabled={isBusy}
        >
          {isEditing ? 'Done' : 'Edit'}
        </MobileButton>
        <MobileButton variant="ghost" size="sm" fullWidth={false} onClick={onReject} disabled={isBusy}>
          Reject
        </MobileButton>
      </div>
    </AgentSurface>
  )
}

/** Prefer MasterFormat (matches sitelayer's curated service_items code
 * shape), then UniFormat, then OmniClass. Returns null when the quantity
 * carries no classification at all — the operator must type one before
 * the promote endpoint will accept it. */
function derivedCodeFor(q: CapturedQuantity): string | null {
  return q.masterformatCode ?? q.uniformatCode ?? q.omniclassCode ?? null
}
