// Pure projection helpers for the AGENT SUPERVISION console (the approval /
// replay / exception review surface). These take data the detail screens ALREADY
// load — the work-item, its handoff events, and (admin-only) the full support
// packet's `server_context` — and project them into the shapes the supervision
// panel renders. No network here; the screens own fetching + capability gating.
//
// The replay/timeline shapes mirror what the API's finalize path wove into
// server_context (apps/api/src/anchor-resolve.ts buildCaptureSessionAnchors +
// apps/api/src/incident-timeline.ts) and what GET /api/anchors returns. Keeping
// the parsing here means the panel is a thin renderer and the logic is unit
// tested in isolation.

import type { ContextHandoffEvent, WorkItemStatus } from './api/work-requests'
import { readCaptureArtifactsFromServerContext, type CaptureArtifactSummary } from './api/capture-sessions'

/** One deterministic statechart transition pinned at capture finalize. Mirrors
 * the API's `CaptureSessionAnchor` persisted into `server_context.anchors`. */
export interface ReplayAnchor {
  event_ref: string | null
  workflow_name: string | null
  entity_type: string | null
  entity_id: string | null
  state_version: number | null
  event_type: string | null
  from_state: string | null
  to_state: string | null
  applied_at: string | null
  /** null = workflow not registered in the API process; true/false = replay verdict. */
  replay_ok: boolean | null
  replay_available: boolean
  /** First per-step divergence the deterministic replay surfaced, if any. */
  first_divergence: ReplayDivergence | null
}

export interface ReplayDivergence {
  reason: string | null
  detail: string | null
  state_version: number | null
}

/** One chronological incident-timeline event (server_context.timeline.events). */
export interface ReplayTimelineEvent {
  at: string | null
  source: string | null
  line: string | null
  is_error: boolean
  error: string | null
  request_id: string | null
  trace_id: string | null
}

/** The latest agent-callback result projected from the handoff event log. */
export interface AgentCallbackResult {
  event_type: string
  recorded_at: string
  actor_ref: string | null
  status: string | null
  message: string | null
  url: string | null
  /** Token-free @operator/projectkit Callback snapshot stamped on the return leg. */
  callback_status: string | null
  error: string | null
  completed_at: string | null
  artifacts: Array<{ kind: string | null; ref: string | null; label: string | null }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseDivergence(value: unknown): ReplayDivergence | null {
  if (!isRecord(value)) return null
  return {
    reason: asString(value.reason),
    detail: asString(value.detail),
    state_version: asNumber(value.state_version),
  }
}

/**
 * Extract the deterministic statechart anchors the finalize path pinned into
 * `server_context.anchors` (most-recent first, capped). Returns [] when the
 * packet carried no workflow marks (e.g. a plain feedback packet) or when the
 * full packet wasn't loaded. The replay verdict + first divergence are already
 * baked into each anchor, so the panel never has to call /api/anchors itself.
 */
export function extractReplayAnchors(serverContext: Record<string, unknown> | null | undefined): ReplayAnchor[] {
  if (!serverContext) return []
  const raw = serverContext.anchors
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isRecord)
    .slice(0, 10)
    .map((entry) => ({
      event_ref: asString(entry.event_ref),
      workflow_name: asString(entry.workflow_name),
      entity_type: asString(entry.entity_type),
      entity_id: asString(entry.entity_id),
      state_version: asNumber(entry.state_version),
      event_type: asString(entry.event_type),
      from_state: asString(entry.from_state),
      to_state: asString(entry.to_state),
      applied_at: asString(entry.applied_at),
      replay_ok: typeof entry.replay_ok === 'boolean' ? entry.replay_ok : null,
      replay_available: entry.replay_available !== false,
      first_divergence: parseDivergence(entry.first_divergence),
    }))
}

/**
 * Extract the chronological "events leading up to the issue" the finalize path
 * wove into `server_context.timeline.events` (oldest first), capped. Returns []
 * when no timeline was captured.
 */
export function extractReplayTimeline(
  serverContext: Record<string, unknown> | null | undefined,
): ReplayTimelineEvent[] {
  if (!serverContext) return []
  const timeline = serverContext.timeline
  if (!isRecord(timeline)) return []
  const raw = timeline.events
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isRecord)
    .slice(0, 80)
    .map((event) => ({
      at: asString(event.at),
      source: asString(event.source),
      line: asString(event.line),
      is_error: event.is_error === true,
      error: asString(event.error),
      request_id: asString(event.request_id),
      trace_id: asString(event.trace_id),
    }))
}

/** True when the replay flagged a divergence on this anchor (the prime suspect). */
export function anchorDiverged(anchor: ReplayAnchor): boolean {
  return anchor.replay_available && anchor.replay_ok === false
}

const AGENT_CALLBACK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.dispatch_acknowledged',
  'agent.message_received',
  'agent.artifact_attached',
  'agent.proposal_ready',
  'agent.completed',
  'agent.failed',
  'agent.callback_missing',
  'agent.dispatch_expired',
  'human.review_requested',
])

function parseArtifacts(value: unknown): AgentCallbackResult['artifacts'] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((artifact) => ({
    kind: asString(artifact.kind) ?? asString(artifact.type),
    ref: asString(artifact.ref) ?? asString(artifact.url) ?? asString(artifact.id),
    label: asString(artifact.label) ?? asString(artifact.name) ?? asString(artifact.title),
  }))
}

/**
 * Project the LATEST agent-side callback result from the handoff event log — the
 * "what the agent proposed / reported" half of the side-by-side. Walks newest to
 * oldest, returns the first agent-authored callback event (acknowledge, message,
 * proposal, completed, ...). Returns null when the agent hasn't reported yet.
 */
export function latestAgentCallback(events: ContextHandoffEvent[]): AgentCallbackResult | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event) continue
    if (event.actor_kind !== 'agent' && !AGENT_CALLBACK_EVENT_TYPES.has(event.event_type)) continue
    if (!AGENT_CALLBACK_EVENT_TYPES.has(event.event_type)) continue
    const payload = event.payload ?? {}
    const callback = isRecord(payload.projectkit_callback) ? payload.projectkit_callback : null
    return {
      event_type: event.event_type,
      recorded_at: event.recorded_at,
      actor_ref: event.actor_ref,
      status: asString(payload.status),
      message: asString(payload.message) ?? asString(payload.body),
      url: asString(payload.url),
      callback_status: callback ? asString(callback.status) : null,
      error: callback ? asString(callback.error) : null,
      completed_at: callback ? asString(callback.completed_at) : null,
      artifacts: parseArtifacts(payload.artifacts ?? (callback ? callback.artifacts : null)),
    }
  }
  return null
}

/**
 * Statuses where the operator is the next actor and the fast review action row
 * (Approve / Reject / Reopen / Reverse) should be prominent. A review_ready /
 * review_stale item is the agent-finished-needs-judgment case the console exists
 * for; proposal_expired still wants a human decision.
 */
export function isAwaitingReview(status: WorkItemStatus): boolean {
  return status === 'review_ready' || status === 'review_stale' || status === 'proposal_expired'
}

/**
 * The capture artifacts the supervision REPLAY view needs to play the actual
 * rrweb session recording (in addition to the deterministic statechart replay).
 *
 * Both pieces are already snapshotted into the support packet's
 * `server_context.capture_session` at finalize — the session id and the artifact
 * list. We read them straight off the already-loaded server_context (no extra
 * SPA fetch to LIST artifacts); the bytes are pulled on demand by ReproReplayPanel
 * through the app_issue.view-gated authed file route. We never touch the
 * DEBUG_TRACE_TOKEN-gated /api/anchors path from the SPA.
 */
export interface ReplayCaptureSelection {
  captureSessionId: string
  /** The rrweb DOM-replay artifact (kind === 'rrweb'), if one was captured. */
  rrwebArtifact: CaptureArtifactSummary | null
  /** The repro-bracket summary artifact (kind === 'repro_bracket'), if present. */
  reproArtifact: CaptureArtifactSummary | null
}

function readCaptureSessionId(serverContext: Record<string, unknown> | null | undefined): string | null {
  if (!serverContext) return null
  // Prefer the nested session summary id, then the flat capture_session_id mirror.
  const session = serverContext.capture_session
  if (isRecord(session)) {
    const summary = session.summary
    if (isRecord(summary) && typeof summary.id === 'string' && summary.id.length > 0) return summary.id
    if (typeof session.id === 'string' && session.id.length > 0) return session.id
  }
  return asString(serverContext.capture_session_id)
}

/**
 * Project the rrweb + repro-bracket artifacts (and the session id) from a loaded
 * support packet's server_context. Returns null when there is no capture session
 * or no playable replay media — so the panel only mounts the rrweb player when
 * there is actually something to watch.
 */
export function selectReplayCapture(
  serverContext: Record<string, unknown> | null | undefined,
): ReplayCaptureSelection | null {
  const captureSessionId = readCaptureSessionId(serverContext)
  if (!captureSessionId) return null
  const artifacts = readCaptureArtifactsFromServerContext(serverContext)
  const rrwebArtifact = artifacts.find((a) => a.kind === 'rrweb') ?? null
  const reproArtifact = artifacts.find((a) => a.kind === 'repro_bracket') ?? null
  if (!rrwebArtifact && !reproArtifact) return null
  return { captureSessionId, rrwebArtifact, reproArtifact }
}

/**
 * Map a raw spoken utterance to a review action, for the optional hands-free
 * voice control on the fast-review row. VOICE PROPOSES — the panel still gates
 * every match behind a one-tap visual confirm before it commits, so a raw
 * utterance can never auto-fire a destructive/irreversible action.
 *
 * Matching is keyword-based and tolerant of natural phrasing ("let's approve
 * this", "reject it") but deliberately conservative: an utterance that contains
 * NO action keyword — or contains TWO conflicting ones — returns null so the
 * operator is never surprised by an ambiguous command.
 */
const VOICE_ACTION_KEYWORDS: ReadonlyArray<{ action: ReviewAction; words: readonly string[] }> = [
  { action: 'approve', words: ['approve', 'approved', 'accept', 'accepted', 'looks good', 'ship it'] },
  { action: 'reject', words: ['reject', 'rejected', 'decline', 'declined', 'deny', 'wont do', "won't do"] },
  { action: 'reopen', words: ['reopen', 're-open', 'open again', 'send it back', 'send back'] },
  { action: 'reverse', words: ['reverse', 'revert', 'undo', 'roll back', 'rollback'] },
]

export function mapUtteranceToReviewAction(utterance: string): ReviewAction | null {
  const text = utterance.toLowerCase()
  const matched = new Set<ReviewAction>()
  for (const { action, words } of VOICE_ACTION_KEYWORDS) {
    if (words.some((word) => text.includes(word))) matched.add(action)
  }
  if (matched.size !== 1) return null
  return [...matched][0] ?? null
}

/** The four review actions, mirrored from the panel's ReviewAction union so the
 * voice mapper can live here (pure, unit-testable) without importing the panel. */
export type ReviewAction = 'approve' | 'reject' | 'reopen' | 'reverse'

const REVIEW_ACTION_LABELS: Record<ReviewAction, string> = {
  approve: 'Approve',
  reject: 'Reject',
  reopen: 'Reopen',
  reverse: 'Reverse',
}

export function reviewActionLabel(action: ReviewAction): string {
  return REVIEW_ACTION_LABELS[action]
}
