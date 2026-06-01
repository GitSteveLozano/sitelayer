import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Project-closeout workflow — fifth deterministic workflow.
 *
 * Lifts the existing POST /api/projects/:id/closeout flow into the
 * deterministic-workflow framework. As of the canonical-route refactor
 * the reducer owns every durable closeout column:
 *   - status='completed'         (projection of `state`)
 *   - closed_at / closed_by
 *   - summary_locked_at          (now reducer-owned, see CLOSEOUT below)
 *   - post_mortem_acknowledged_at / post_mortem_acknowledged_by
 *   - state_version              (optimistic-concurrency + event-log key)
 *
 * The margin-shortfall alert (best-effort post-commit) stays in the
 * route — it's an after-effect, not part of the durable transition.
 *
 * COLUMN-OWNERSHIP CONTRACT (read alongside project-lifecycle.ts):
 *   - `project_closeout` OWNS `status` (the active/completed/post_mortem
 *     projection), `closed_at`, `closed_by`, `summary_locked_at`,
 *     `state_version`, and `post_mortem_acknowledged_{at,by}`.
 *   - `project_lifecycle` OWNS the `lifecycle_*` columns and never writes
 *     `status` (its UPDATE touches only `lifecycle_*`).
 *   - CLOSEOUT is gated route-side on the *real* `lifecycle_state` (only
 *     `in_progress`/`done` may close out) rather than the lossy `status`
 *     projection — see `projectStatusToCloseoutState` below.
 *
 * States: active → completed → post_mortem.
 *   active is the catch-all label for any non-completed project
 *   status today ('lead', or anything else PATCH might set).
 *   completed is the work-done / summary-locked state.
 *   post_mortem is terminal — the owner has reviewed the post-mortem and
 *   the record is closed.
 *
 * Future v2 could add 'archived' or 'reopened' transitions; defer
 * until the UI surfaces them.
 */

export type ProjectCloseoutWorkflowState = 'active' | 'completed' | 'post_mortem'

export const PROJECT_CLOSEOUT_WORKFLOW_NAME = 'project_closeout'
export const PROJECT_CLOSEOUT_WORKFLOW_SCHEMA_VERSION = 1
export const PROJECT_CLOSEOUT_ALL_STATES: readonly ProjectCloseoutWorkflowState[] = [
  'active',
  'completed',
  'post_mortem',
]
export const PROJECT_CLOSEOUT_TERMINAL_STATES: readonly ProjectCloseoutWorkflowState[] = ['post_mortem']
export const PROJECT_CLOSEOUT_EVENT_TYPES = ['CLOSEOUT', 'ACKNOWLEDGE_POST_MORTEM'] as const

export type ProjectCloseoutWorkflowEvent =
  | {
      type: 'CLOSEOUT'
      closed_at: string
      closed_by: string
    }
  | {
      type: 'ACKNOWLEDGE_POST_MORTEM'
      acknowledged_at: string
      acknowledged_by: string
    }

export interface ProjectCloseoutWorkflowSnapshot {
  state: ProjectCloseoutWorkflowState
  state_version: number
  closed_at?: string | null
  closed_by?: string | null
  summary_locked_at?: string | null
  post_mortem_acknowledged_at?: string | null
  post_mortem_acknowledged_by?: string | null
}

function assertProjectCloseoutTransition(
  state: ProjectCloseoutWorkflowState,
  allowed: readonly ProjectCloseoutWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from project closeout state ${state}`)
  }
}

export function transitionProjectCloseoutWorkflow(
  snapshot: ProjectCloseoutWorkflowSnapshot,
  event: ProjectCloseoutWorkflowEvent,
): ProjectCloseoutWorkflowSnapshot {
  if (event.type === 'CLOSEOUT') {
    assertProjectCloseoutTransition(snapshot.state, ['active'], event.type)
    return {
      ...snapshot,
      state: 'completed',
      state_version: snapshot.state_version + 1,
      closed_at: event.closed_at,
      closed_by: event.closed_by,
      // The reducer now owns summary_locked_at: it locks at the closeout
      // moment (idempotent — preserve an existing lock) so the transition
      // stays pure and replayable instead of the route stamping now().
      summary_locked_at: snapshot.summary_locked_at ?? event.closed_at,
    }
  }
  if (event.type === 'ACKNOWLEDGE_POST_MORTEM') {
    assertProjectCloseoutTransition(snapshot.state, ['completed'], event.type)
    return {
      ...snapshot,
      state: 'post_mortem',
      state_version: snapshot.state_version + 1,
      post_mortem_acknowledged_at: snapshot.post_mortem_acknowledged_at ?? event.acknowledged_at,
      post_mortem_acknowledged_by: snapshot.post_mortem_acknowledged_by ?? event.acknowledged_by,
    }
  }
  const exhaustive: never = event
  throw new Error(`unhandled project closeout event ${(exhaustive as { type: string }).type}`)
}

export type ProjectCloseoutHumanEventType = 'CLOSEOUT' | 'ACKNOWLEDGE_POST_MORTEM'

export function nextProjectCloseoutEvents(
  state: ProjectCloseoutWorkflowState,
): Array<WorkflowNextEvent<ProjectCloseoutHumanEventType>> {
  switch (state) {
    case 'active':
      return [{ type: 'CLOSEOUT', label: 'Mark project complete' }]
    case 'completed':
      return [{ type: 'ACKNOWLEDGE_POST_MORTEM', label: 'Open post-mortem' }]
    case 'post_mortem':
      return []
  }
}

export function isHumanProjectCloseoutEvent(eventType: string): eventType is ProjectCloseoutHumanEventType {
  return eventType === 'CLOSEOUT' || eventType === 'ACKNOWLEDGE_POST_MORTEM'
}

/**
 * Map the closeout-owned projects.status (+ the post-mortem ack timestamp)
 * to the reducer's three-state vocabulary. This is a projection over ONLY
 * the closeout-owned `status` values (`active`/`completed`/`post_mortem`),
 * not the polymorphic lifecycle state — lifecycle states never flow through
 * it (CLOSEOUT eligibility is gated route-side on `lifecycle_state`).
 *
 * `status='completed'` reads as `post_mortem` once the owner has
 * acknowledged the post-mortem (post_mortem_acknowledged_at set), else
 * `completed`. Any other status is `active`.
 */
export function projectStatusToCloseoutState(
  status: string,
  postMortemAcknowledgedAt?: string | null,
): ProjectCloseoutWorkflowState {
  if (status === 'completed') {
    return postMortemAcknowledgedAt != null ? 'post_mortem' : 'completed'
  }
  return 'active'
}

export const projectCloseoutWorkflow = registerWorkflow<
  ProjectCloseoutWorkflowState,
  ProjectCloseoutWorkflowEvent,
  ProjectCloseoutHumanEventType,
  ProjectCloseoutWorkflowSnapshot
>({
  name: PROJECT_CLOSEOUT_WORKFLOW_NAME,
  schemaVersion: PROJECT_CLOSEOUT_WORKFLOW_SCHEMA_VERSION,
  initialState: 'active',
  terminalStates: PROJECT_CLOSEOUT_TERMINAL_STATES,
  allStates: PROJECT_CLOSEOUT_ALL_STATES,
  allEventTypes: PROJECT_CLOSEOUT_EVENT_TYPES,
  reduce: transitionProjectCloseoutWorkflow,
  nextEvents: nextProjectCloseoutEvents,
  isHumanEvent: isHumanProjectCloseoutEvent,
  // Margin-shortfall alert is a best-effort post-commit notification
  // dispatched directly by the route, not via outbox.
  sideEffectTypes: [] as const,
})

export const ProjectCloseoutEventRequestSchema = z.object({
  event: z.enum(['CLOSEOUT', 'ACKNOWLEDGE_POST_MORTEM']),
  state_version: z.number().int().positive(),
})

export type ProjectCloseoutEventRequest = z.infer<typeof ProjectCloseoutEventRequestSchema>
export type ProjectCloseoutEventParseResult =
  | { ok: true; value: ProjectCloseoutEventRequest }
  | { ok: false; error: string }

export function parseProjectCloseoutEventRequest(body: unknown): ProjectCloseoutEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = ProjectCloseoutEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
