import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Project-closeout workflow — fifth deterministic workflow.
 *
 * Lifts the existing POST /api/projects/:id/closeout flow into the
 * deterministic-workflow framework. The route already sets
 *   - status='completed'
 *   - closed_at = coalesce(closed_at, now())
 *   - summary_locked_at = coalesce(summary_locked_at, now())
 *   - version = version + 1
 *
 * Workflowization adds:
 *   - state_version optimistic-concurrency check
 *   - workflow_event_log row per transition
 *   - closed_by audit field
 *
 * The margin-shortfall alert (best-effort post-commit) stays in the
 * route — it's an after-effect, not part of the durable transition.
 *
 * States: active → completed.
 *   active is the catch-all label for any non-completed project
 *   status today ('lead', or anything else PATCH might set).
 *   completed is terminal for v1.
 *
 * Future v2 could add 'archived' or 'reopened' transitions; defer
 * until the UI surfaces them.
 */

export type ProjectCloseoutWorkflowState = 'active' | 'completed'

export const PROJECT_CLOSEOUT_WORKFLOW_NAME = 'project_closeout'
export const PROJECT_CLOSEOUT_WORKFLOW_SCHEMA_VERSION = 1
export const PROJECT_CLOSEOUT_ALL_STATES: readonly ProjectCloseoutWorkflowState[] = ['active', 'completed']
export const PROJECT_CLOSEOUT_TERMINAL_STATES: readonly ProjectCloseoutWorkflowState[] = ['completed']
export const PROJECT_CLOSEOUT_EVENT_TYPES = ['CLOSEOUT'] as const

export type ProjectCloseoutWorkflowEvent = {
  type: 'CLOSEOUT'
  closed_at: string
  closed_by: string
}

export interface ProjectCloseoutWorkflowSnapshot {
  state: ProjectCloseoutWorkflowState
  state_version: number
  closed_at?: string | null
  closed_by?: string | null
  summary_locked_at?: string | null
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
      // summary_locked_at is set by the route layer alongside the
      // closed_at write — not modeled in the reducer because it's
      // identical to closed_at for every legal transition.
    }
  }
  const exhaustive: never = event.type
  throw new Error(`unhandled project closeout event ${exhaustive}`)
}

export type ProjectCloseoutHumanEventType = 'CLOSEOUT'

export function nextProjectCloseoutEvents(
  state: ProjectCloseoutWorkflowState,
): Array<WorkflowNextEvent<ProjectCloseoutHumanEventType>> {
  switch (state) {
    case 'active':
      return [{ type: 'CLOSEOUT', label: 'Mark project complete' }]
    case 'completed':
      return []
  }
}

export function isHumanProjectCloseoutEvent(eventType: string): eventType is ProjectCloseoutHumanEventType {
  return eventType === 'CLOSEOUT'
}

/**
 * Map a stored projects.status value to the reducer's two-state vocabulary.
 * Any value other than 'completed' is treated as 'active' so existing
 * 'lead' or PATCH-set values flow through the workflow.
 */
export function projectStatusToCloseoutState(status: string): ProjectCloseoutWorkflowState {
  return status === 'completed' ? 'completed' : 'active'
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
  event: z.enum(['CLOSEOUT']),
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
