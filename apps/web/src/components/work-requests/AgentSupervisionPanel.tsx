import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { MBanner, MButton, MButtonStack, MInput, MPill, MSectionH } from '../m/index.js'
import type { ContextHandoffEvent, ContextWorkItem, WorkRequestSupportPacketSummary } from '@/lib/api'
import {
  anchorDiverged,
  extractReplayAnchors,
  extractReplayTimeline,
  isAwaitingReview,
  latestAgentCallback,
  mapUtteranceToReviewAction,
  reviewActionLabel,
  selectReplayCapture,
  type ReplayAnchor,
  type ReplayTimelineEvent,
  type ReviewAction,
} from '@/lib/agent-supervision'
import { ReproReplayPanel } from './ReproReplayPanel.js'

/**
 * AGENT SUPERVISION console (v1) — the review / replay / exception surface that
 * relocates the dashboard to "where you review, judge, and replay the agent's
 * work". A self-contained panel mounted on BOTH the field-request and app-issue
 * detail screens; it is domain-agnostic and stays capability-gated by its host
 * (the host only passes review-action callbacks when the caller may act).
 *
 * Three parts, in operator priority order:
 *   1. FAST review action row — one-tap Approve / Reject / Reopen / Reverse for a
 *      review_ready item (Reverse only inside the reversibility window). No nested
 *      menus. Wired to the existing events/append + reverse endpoints via the
 *      callbacks the host supplies.
 *   2. "What happened" REPLAY view — the workflow_event_log transition timeline +
 *      the deterministic anchor replay (first_divergence) as a navigable sequence.
 *      Renders the `server_context.anchors` / `.timeline` the finalize path
 *      already pinned (no extra fetch); the diverged transition is the prime
 *      suspect and is highlighted.
 *   3. AGENT OUTPUT vs CONTEXT — side-by-side of the agent's latest callback
 *      result (message / status / artifacts) against the captured context (route,
 *      entity, problem, agent_prompt).
 */

export type { ReviewAction } from '@/lib/agent-supervision'

export interface AgentSupervisionReviewHandlers {
  /** resolution.accepted */
  onApprove?: () => void
  /** work_item.status_changed -> wont_do */
  onReject?: () => void
  /** resolution.reopened */
  onReopen?: () => void
  /** reverse endpoint; only callable inside the reversibility window. */
  onReverse?: (reason: string) => void
  /** Whether reverse is currently allowed (window open + capability + not closed). */
  canReverse?: boolean
  /** Disable the whole action row while a mutation is in flight. */
  busy?: boolean
  /** Surfaced above the row when a review action failed. */
  error?: string | null
}

export interface AgentSupervisionPanelProps {
  workItem: ContextWorkItem
  events: ContextHandoffEvent[]
  supportPacket?: WorkRequestSupportPacketSummary | null | undefined
  /**
   * The full support packet's `server_context` (anchors + timeline). Only
   * available when the host loaded the full packet (operator/admin scope); when
   * absent the replay view shows a hint instead of the deterministic detail.
   */
  serverContext?: Record<string, unknown> | null | undefined
  /** The packet's LLM agent_prompt, when the full packet is loaded. */
  agentPrompt?: string | null | undefined
  /** Review handlers; omit (or leave undefined) to render the panel read-only. */
  review?: AgentSupervisionReviewHandlers | undefined
}

export function AgentSupervisionPanel({
  workItem,
  events,
  supportPacket,
  serverContext,
  agentPrompt,
  review,
}: AgentSupervisionPanelProps) {
  const anchors = useMemo(() => extractReplayAnchors(serverContext), [serverContext])
  const timeline = useMemo(() => extractReplayTimeline(serverContext), [serverContext])
  const replayCapture = useMemo(() => selectReplayCapture(serverContext), [serverContext])
  const callback = useMemo(() => latestAgentCallback(events), [events])
  const awaitingReview = isAwaitingReview(workItem.status)

  return (
    <section data-testid="agent-supervision-panel">
      <MSectionH>Agent supervision</MSectionH>
      {review && awaitingReview ? <ReviewActionRow status={workItem.status} review={review} /> : null}
      <ReplayView
        anchors={anchors}
        timeline={timeline}
        hasServerContext={Boolean(serverContext)}
        replayCapture={replayCapture}
      />
      <AgentOutputVsContext
        workItem={workItem}
        supportPacket={supportPacket}
        callback={callback}
        agentPrompt={agentPrompt}
      />
    </section>
  )
}

function ReviewActionRow({
  status,
  review,
}: {
  status: ContextWorkItem['status']
  review: AgentSupervisionReviewHandlers
}) {
  const [reverseReason, setReverseReason] = useState('')
  const [showReverse, setShowReverse] = useState(false)
  const busy = Boolean(review.busy)

  // Which actions this row can actually run, given the host-supplied handlers +
  // capability gating. The voice control proposes only from this set.
  const availableActions = useMemo<ReviewAction[]>(() => {
    const actions: ReviewAction[] = []
    if (review.onApprove) actions.push('approve')
    if (review.onReject) actions.push('reject')
    if (review.onReopen) actions.push('reopen')
    if (review.onReverse && review.canReverse) actions.push('reverse')
    return actions
  }, [review.onApprove, review.onReject, review.onReopen, review.onReverse, review.canReverse])

  // VOICE-APPROVE confirm-gate: a spoken keyword PROPOSES an action; committing
  // routes through the SAME handlers the buttons use. Reverse is irreversible +
  // needs a reason, so a confirmed voice "reverse" opens the reason flow rather
  // than firing blind — never auto-commit a destructive action from an utterance.
  const runReviewAction = (action: ReviewAction) => {
    switch (action) {
      case 'approve':
        review.onApprove?.()
        return
      case 'reject':
        review.onReject?.()
        return
      case 'reopen':
        review.onReopen?.()
        return
      case 'reverse':
        setShowReverse(true)
        return
    }
  }

  return (
    <div style={{ padding: '0 16px 4px', display: 'grid', gap: 10 }}>
      <div style={reviewHeaderStyle}>
        <MPill tone="accent" dot>
          {status === 'proposal_expired' ? 'Needs decision' : 'Ready for review'}
        </MPill>
        <span style={reviewHintStyle}>The agent finished — approve, reject, or send it back.</span>
      </div>
      {review.error ? <MBanner tone="error" title="Review action failed" body={review.error} /> : null}
      <VoiceApproveControl availableActions={availableActions} busy={busy} onConfirm={runReviewAction} />
      <MButtonStack>
        {review.onApprove ? (
          <MButton variant="primary" disabled={busy} onClick={review.onApprove}>
            Approve
          </MButton>
        ) : null}
        {review.onReject ? (
          <MButton variant="ghost" disabled={busy} onClick={review.onReject}>
            Reject
          </MButton>
        ) : null}
        {review.onReopen ? (
          <MButton variant="ghost" disabled={busy} onClick={review.onReopen}>
            Reopen
          </MButton>
        ) : null}
        {review.onReverse && review.canReverse ? (
          <MButton variant="ghost" disabled={busy} onClick={() => setShowReverse((v) => !v)}>
            {showReverse ? 'Cancel reverse' : 'Reverse'}
          </MButton>
        ) : null}
      </MButtonStack>
      {review.onReverse && review.canReverse && showReverse ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <MInput
            aria-label="Reverse reason"
            value={reverseReason}
            onChange={(event) => setReverseReason(event.currentTarget.value)}
            placeholder="Why reverse the agent's change?"
          />
          <MButton
            variant="primary"
            disabled={busy || !reverseReason.trim()}
            onClick={() => {
              review.onReverse?.(reverseReason.trim())
              setReverseReason('')
              setShowReverse(false)
            }}
          >
            Confirm reverse
          </MButton>
        </div>
      ) : null}
    </div>
  )
}

// Minimal Web Speech API surface — TypeScript's lib doesn't ship the type. Kept
// local (mirrors the foreman daily-log voice control) to avoid extra ambient
// types. The recognizer is feature-detected; the whole control no-ops + hides
// when SpeechRecognition is unavailable.
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}
interface SpeechRecognitionResultEvent {
  results: ArrayLike<{ isFinal?: boolean; [index: number]: { transcript: string } }>
}

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * VOICE-APPROVE — optional hands-free control on the fast-review row. The mic
 * dictates an utterance, `mapUtteranceToReviewAction` proposes one of the
 * available review actions, and the operator must tap a visual CONFIRM before it
 * commits (voice proposes, a one-tap confirm disposes). A raw utterance can never
 * auto-fire a destructive/irreversible action. Feature-detected: when
 * SpeechRecognition is unsupported the control renders nothing.
 */
function VoiceApproveControl({
  availableActions,
  busy,
  onConfirm,
}: {
  availableActions: ReviewAction[]
  busy: boolean
  onConfirm: (action: ReviewAction) => void
}) {
  const supported = useMemo(() => getSpeechRecognitionCtor() !== null, [])
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')
  const [proposed, setProposed] = useState<ReviewAction | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  // Stop the recognizer if the row unmounts mid-listen — otherwise the mic keeps
  // capturing audio after the panel is gone.
  useEffect(() => {
    return () => recognitionRef.current?.stop()
  }, [])

  if (!supported || availableActions.length === 0) return null

  const available = new Set(availableActions)

  const startListening = () => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor || listening) return
    setNotice(null)
    setProposed(null)
    setHeard('')
    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (event: SpeechRecognitionResultEvent) => {
      let text = ''
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i]?.[0]?.transcript ?? ''
      }
      setHeard(text)
      const action = mapUtteranceToReviewAction(text)
      if (action && available.has(action)) {
        setProposed(action)
        setNotice(null)
      } else if (text.trim()) {
        setProposed(null)
      }
    }
    rec.onend = () => {
      setListening(false)
      // Resolve the final verdict once dictation ends, so an unrecognized phrase
      // surfaces a clear "didn't catch that" rather than silently doing nothing.
      setHeard((finalText) => {
        const action = mapUtteranceToReviewAction(finalText)
        if (action && available.has(action)) {
          setProposed(action)
        } else if (finalText.trim()) {
          setProposed(null)
          setNotice('Didn’t catch an action — try “approve”, “reject”, “reopen”, or “reverse”.')
        }
        return finalText
      })
    }
    rec.onerror = () => {
      setListening(false)
      setNotice('Voice capture failed — use the buttons below.')
    }
    rec.start()
    recognitionRef.current = rec
    setListening(true)
  }

  const stopListening = () => {
    recognitionRef.current?.stop()
    setListening(false)
  }

  const reset = () => {
    setProposed(null)
    setHeard('')
    setNotice(null)
  }

  return (
    <div style={voiceWrapStyle}>
      <div style={voiceRowStyle}>
        <MButton
          variant={listening ? 'primary' : 'ghost'}
          size="sm"
          disabled={busy}
          aria-label={listening ? 'Stop voice review' : 'Start voice review'}
          aria-pressed={listening}
          onClick={listening ? stopListening : startListening}
        >
          {listening ? 'Stop mic' : 'Voice review'}
        </MButton>
        {listening ? <span style={voiceHintStyle}>Listening… say approve, reject, reopen, or reverse.</span> : null}
        {!listening && heard ? <span style={voiceHeardStyle}>Heard: “{heard.trim()}”</span> : null}
      </div>
      {proposed ? (
        <div style={voiceConfirmStyle} data-testid="voice-confirm">
          <span style={voiceConfirmTextStyle}>
            Voice proposes: <strong>{reviewActionLabel(proposed)}</strong>. Confirm to{' '}
            {proposed === 'reverse' ? 'open the reverse step' : 'commit'}.
          </span>
          <div style={voiceConfirmButtonsStyle}>
            <MButton
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => {
                onConfirm(proposed)
                reset()
              }}
            >
              Confirm {reviewActionLabel(proposed).toLowerCase()}
            </MButton>
            <MButton variant="ghost" size="sm" disabled={busy} onClick={reset}>
              Cancel
            </MButton>
          </div>
        </div>
      ) : notice ? (
        <span style={voiceNoticeStyle}>{notice}</span>
      ) : null}
    </div>
  )
}

function ReplayView({
  anchors,
  timeline,
  hasServerContext,
  replayCapture,
}: {
  anchors: ReplayAnchor[]
  timeline: ReplayTimelineEvent[]
  hasServerContext: boolean
  replayCapture: ReturnType<typeof selectReplayCapture>
}) {
  // The replay is a single navigable sequence: the pinned statechart anchors
  // first (the broken transition is the prime suspect), then the chronological
  // in-window timeline. Selecting a step shows its detail below — "show me what
  // the agent did / where state broke".
  const steps = useMemo(() => buildReplaySteps(anchors, timeline), [anchors, timeline])
  const divergedIndex = steps.findIndex((step) => step.kind === 'anchor' && anchorDiverged(step.anchor))
  const [selected, setSelected] = useState(0)
  const activeIndex = selected < steps.length ? selected : 0
  const active = steps[activeIndex] ?? null

  return (
    <>
      <MSectionH>What happened (replay)</MSectionH>
      <div style={{ padding: '0 16px', display: 'grid', gap: 10 }}>
        {/* REAL REPLAY: the captured rrweb session recording — watch what actually
            happened, alongside the deterministic statechart replay below. Bytes are
            pulled on demand through the app_issue.view-gated authed file route. */}
        {replayCapture ? (
          <ReproReplayPanel
            captureSessionId={replayCapture.captureSessionId}
            rrwebArtifact={replayCapture.rrwebArtifact}
            reproArtifact={replayCapture.reproArtifact}
          />
        ) : null}
        {!hasServerContext ? (
          <div style={hintStyle}>
            Load the support packet to replay the deterministic statechart transitions and the in-window timeline.
          </div>
        ) : steps.length === 0 ? (
          <div style={hintStyle}>No statechart transitions or timeline events were captured for this item.</div>
        ) : (
          <>
            {divergedIndex >= 0 ? (
              <MBanner
                tone="error"
                title="Deterministic replay diverged"
                body="A pinned transition failed to replay — treat it as the prime suspect for where state broke."
              />
            ) : null}
            <div style={scrubberStyle} role="list" aria-label="Replay steps">
              {steps.map((step, index) => (
                <button
                  key={step.key}
                  type="button"
                  role="listitem"
                  aria-current={index === activeIndex}
                  onClick={() => setSelected(index)}
                  style={stepChipStyle(index === activeIndex, step.tone)}
                  title={step.title}
                >
                  <span style={stepDotStyle(step.tone)} />
                  {step.label}
                </button>
              ))}
            </div>
            {active ? <ReplayStepDetail step={active} /> : null}
          </>
        )}
      </div>
    </>
  )
}

type StepTone = 'error' | 'agent' | 'neutral'

interface AnchorStep {
  kind: 'anchor'
  key: string
  label: string
  title: string
  tone: StepTone
  anchor: ReplayAnchor
}
interface TimelineStep {
  kind: 'timeline'
  key: string
  label: string
  title: string
  tone: StepTone
  event: ReplayTimelineEvent
}
type ReplayStep = AnchorStep | TimelineStep

function buildReplaySteps(anchors: ReplayAnchor[], timeline: ReplayTimelineEvent[]): ReplayStep[] {
  // Anchors are stored most-recent first; show them oldest→newest so the
  // sequence reads as a forward replay. The diverged anchor keeps its highlight.
  const anchorSteps: AnchorStep[] = [...anchors].reverse().map((anchor, index) => {
    const transition = anchor.from_state
      ? `${anchor.from_state} → ${anchor.to_state ?? '?'}`
      : `→ ${anchor.to_state ?? '?'}`
    return {
      kind: 'anchor',
      key: `anchor-${anchor.event_ref ?? index}-${index}`,
      label: transition,
      title: `${anchor.workflow_name ?? 'workflow'} ${transition}`,
      tone: anchorDiverged(anchor) ? 'error' : 'agent',
      anchor,
    }
  })
  const timelineSteps: TimelineStep[] = timeline.map((event, index) => ({
    kind: 'timeline',
    key: `timeline-${index}-${event.at ?? ''}`,
    label: shortTime(event.at) || event.source || `event ${index + 1}`,
    title: `${event.source ?? 'event'}: ${event.line ?? ''}`,
    tone: event.is_error ? 'error' : 'neutral',
    event,
  }))
  return [...anchorSteps, ...timelineSteps]
}

function ReplayStepDetail({ step }: { step: ReplayStep }) {
  if (step.kind === 'anchor') {
    const a = step.anchor
    const transition = a.from_state ? `${a.from_state} → ${a.to_state ?? '?'}` : `→ ${a.to_state ?? '?'}`
    return (
      <div style={detailCardStyle(step.tone)}>
        <DetailRow label="Transition" value={`${a.workflow_name ?? 'workflow'}  ${transition}`} />
        <DetailRow label="Event" value={a.event_type ?? 'unknown'} />
        <DetailRow
          label="Entity"
          value={`${a.entity_type ?? 'entity'} ${a.entity_id ?? '?'}${
            a.state_version != null ? ` · v${a.state_version}` : ''
          }`}
        />
        {a.applied_at ? <DetailRow label="Applied" value={formatDateTime(a.applied_at)} /> : null}
        <DetailRow label="Replay" value={replayVerdict(a)} tone={anchorDiverged(a) ? 'error' : undefined} />
        {a.event_ref ? <DetailRow label="Anchor" value={a.event_ref} mono /> : null}
      </div>
    )
  }
  const e = step.event
  return (
    <div style={detailCardStyle(step.tone)}>
      <DetailRow label="Source" value={e.source ?? 'event'} />
      {e.line ? <DetailRow label="Detail" value={e.line} /> : null}
      {e.at ? <DetailRow label="At" value={formatDateTime(e.at)} /> : null}
      {e.is_error && e.error ? <DetailRow label="Error" value={e.error} tone="error" /> : null}
      {e.request_id ? <DetailRow label="Request" value={e.request_id} mono /> : null}
      {e.trace_id ? <DetailRow label="Trace" value={e.trace_id} mono /> : null}
    </div>
  )
}

function replayVerdict(anchor: ReplayAnchor): string {
  if (!anchor.replay_available) return 'unavailable (workflow not registered)'
  if (anchor.replay_ok === true) return 'OK — no divergence'
  if (anchor.first_divergence) {
    const d = anchor.first_divergence
    const at = d.state_version != null ? ` at v${d.state_version}` : ''
    return `DIVERGED${at}: ${d.reason ?? 'divergence'}${d.detail ? ` (${d.detail})` : ''}`
  }
  return 'status unknown'
}

function AgentOutputVsContext({
  workItem,
  supportPacket,
  callback,
  agentPrompt,
}: {
  workItem: ContextWorkItem
  supportPacket: WorkRequestSupportPacketSummary | null | undefined
  callback: ReturnType<typeof latestAgentCallback>
  agentPrompt: string | null | undefined
}) {
  return (
    <>
      <MSectionH>Agent output vs context</MSectionH>
      <div style={{ padding: '0 16px', display: 'grid', gap: 12 }}>
        <div style={columnsStyle}>
          <Column title="Agent proposed">
            {callback ? (
              <>
                <DetailRow
                  label="Reported"
                  value={`${eventLabel(callback.event_type)} · ${formatDateTime(callback.recorded_at)}`}
                />
                {(callback.callback_status ?? callback.status) ? (
                  <DetailRow
                    label="Status"
                    value={callback.callback_status ?? callback.status ?? ''}
                    tone={callback.callback_status === 'failed' ? 'error' : undefined}
                  />
                ) : null}
                {callback.actor_ref ? <DetailRow label="Agent" value={callback.actor_ref} /> : null}
                {callback.message ? <DetailRow label="Message" value={callback.message} /> : null}
                {callback.error ? <DetailRow label="Error" value={callback.error} tone="error" /> : null}
                {callback.url ? <DetailRow label="Output" value={callback.url} mono /> : null}
                {callback.completed_at ? (
                  <DetailRow label="Completed" value={formatDateTime(callback.completed_at)} />
                ) : null}
                {callback.artifacts.length ? (
                  <DetailRow
                    label="Artifacts"
                    value={callback.artifacts
                      .map((artifact) => artifact.label ?? artifact.kind ?? artifact.ref ?? 'artifact')
                      .join(', ')}
                  />
                ) : null}
              </>
            ) : (
              <div style={hintStyle}>No agent callback yet — the agent has not reported a proposed change.</div>
            )}
          </Column>
          <Column title="Captured context">
            <DetailRow label="Route" value={workItem.route ?? supportPacket?.route ?? 'unknown'} mono />
            {workItem.entity_type || workItem.entity_id ? (
              <DetailRow label={workItem.entity_type ?? 'Entity'} value={workItem.entity_id ?? 'unknown'} mono />
            ) : null}
            {supportPacket?.problem ? <DetailRow label="Problem" value={supportPacket.problem} /> : null}
            {supportPacket?.request_id ? <DetailRow label="Request" value={supportPacket.request_id} mono /> : null}
            {supportPacket?.build_sha ? <DetailRow label="Build" value={supportPacket.build_sha} mono /> : null}
            <DetailRow label="Support packet" value={supportPacket?.id ?? workItem.support_packet_id} mono />
          </Column>
        </div>
        {agentPrompt ? (
          <details style={promptDetailsStyle}>
            <summary style={promptSummaryStyle}>Agent prompt (full)</summary>
            <pre style={promptPreStyle}>{agentPrompt}</pre>
          </details>
        ) : null}
      </div>
    </>
  )
}

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={columnStyle}>
      <div style={columnTitleStyle}>{title}</div>
      <div style={{ display: 'grid', gap: 6 }}>{children}</div>
    </div>
  )
}

function DetailRow({
  label,
  value,
  mono,
  tone,
}: {
  label: string
  value: string
  mono?: boolean
  tone?: 'error' | undefined
}) {
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <span style={detailLabelStyle}>{label}</span>
      <span
        style={{ ...detailValueStyle, ...(mono ? monoStyle : {}), ...(tone === 'error' ? { color: '#b4231f' } : {}) }}
      >
        {value}
      </span>
    </div>
  )
}

const EVENT_LABELS: Record<string, string> = {
  'agent.dispatch_acknowledged': 'Agent acknowledged',
  'agent.message_received': 'Agent message',
  'agent.artifact_attached': 'Artifact attached',
  'agent.proposal_ready': 'Proposal ready',
  'agent.completed': 'Agent completed',
  'agent.failed': 'Agent failed',
  'agent.callback_missing': 'Agent callback missing',
  'agent.dispatch_expired': 'Agent claim expired',
  'human.review_requested': 'Review requested',
}

function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType
}

function shortTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const reviewHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const reviewHintStyle: CSSProperties = { fontSize: 13, color: 'var(--m-ink-2)' }
const voiceWrapStyle: CSSProperties = { display: 'grid', gap: 8 }
const voiceRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const voiceHintStyle: CSSProperties = { fontSize: 12, color: 'var(--m-ink-3)' }
const voiceHeardStyle: CSSProperties = { fontSize: 12, color: 'var(--m-ink-2)', fontStyle: 'italic' }
const voiceNoticeStyle: CSSProperties = { fontSize: 12, color: 'var(--m-ink-3)' }
const voiceConfirmStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  padding: 10,
  borderRadius: 8,
  border: '1px solid var(--m-line, rgba(0,0,0,0.12))',
  background: 'var(--m-surface-2, #fbfaf6)',
}
const voiceConfirmTextStyle: CSSProperties = { fontSize: 13, color: 'var(--m-ink)' }
const voiceConfirmButtonsStyle: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' }
const hintStyle: CSSProperties = { fontSize: 13, color: 'var(--m-ink-3)', lineHeight: 1.45 }
const scrubberStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
  alignItems: 'center',
}
const detailCardStyle = (tone: StepTone): CSSProperties => ({
  display: 'grid',
  gap: 6,
  padding: 12,
  borderRadius: 8,
  border: `1px solid ${tone === 'error' ? '#e7b7b3' : 'var(--m-line, rgba(0,0,0,0.12))'}`,
  background: tone === 'error' ? '#fdf3f2' : 'var(--m-surface-2, #fbfaf6)',
})
const columnsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 10,
}
const columnStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  padding: 12,
  borderRadius: 8,
  border: '1px solid var(--m-line, rgba(0,0,0,0.12))',
  background: 'var(--m-surface-2, #fbfaf6)',
  alignContent: 'start',
}
const columnTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--m-ink-3)',
}
const detailLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--m-ink-3)',
}
const detailValueStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--m-ink)',
  lineHeight: 1.4,
  wordBreak: 'break-word',
}
const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 12,
}
const stepChipStyle = (active: boolean, tone: StepTone): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  padding: '5px 10px',
  borderRadius: 999,
  cursor: 'pointer',
  border: `1px solid ${active ? 'var(--m-ink)' : tone === 'error' ? '#e7b7b3' : 'var(--m-line, rgba(0,0,0,0.12))'}`,
  background: active ? 'var(--m-ink)' : '#fff',
  color: active ? '#fff' : tone === 'error' ? '#b4231f' : 'var(--m-ink-2)',
})
const stepDotStyle = (tone: StepTone): CSSProperties => ({
  width: 7,
  height: 7,
  borderRadius: 999,
  background: tone === 'error' ? '#b4231f' : tone === 'agent' ? '#2d5fa6' : '#9a9082',
})
const promptDetailsStyle: CSSProperties = {
  border: '1px solid var(--m-line, rgba(0,0,0,0.12))',
  borderRadius: 8,
  padding: '8px 12px',
  background: 'var(--m-surface-2, #fbfaf6)',
}
const promptSummaryStyle: CSSProperties = { fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--m-ink-2)' }
const promptPreStyle: CSSProperties = {
  marginTop: 10,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 12,
  lineHeight: 1.45,
  color: 'var(--m-ink)',
  maxHeight: 320,
  overflow: 'auto',
}
