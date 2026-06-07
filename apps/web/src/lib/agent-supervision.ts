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
  'agent.callback_missing',
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
