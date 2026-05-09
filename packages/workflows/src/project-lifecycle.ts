import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Project-lifecycle workflow — eighth deterministic workflow.
 *
 * Models a sales/delivery pipeline for a project, sitting alongside
 * (not replacing) the simpler project_closeout workflow that just
 * answers "is this project completed yet?". The two coexist:
 *   - lifecycle owns draft → estimating → sent → accepted → in_progress
 *     → done → archived (and a sent → declined branch).
 *   - closeout owns the active → completed flip on /closeout — kept for
 *     the existing margin-shortfall alert + summary lock plumbing.
 *
 * Once a customer accepts an estimate the lifecycle moves into
 * `accepted` and a foreman can be assigned; START_WORK then transitions
 * to `in_progress`. When the crew is done, COMPLETE moves to `done` and
 * eventually ARCHIVE shelves it. REOPEN exists for the case where a
 * post-closeout correction lands (e.g. punch-list pickup) and the
 * project needs to be active again — same pattern as time-review.
 *
 * States:
 *   draft         a fresh project before estimation begins
 *   estimating    the crew is putting together a quote
 *   sent          the quote was sent to the customer
 *   accepted      the customer accepted; ready to start work
 *   declined      the customer declined; terminal-ish (can ARCHIVE)
 *   in_progress   crew is actively working
 *   done          work is complete (closeout-ish)
 *   archived      shelved; can REOPEN if work resumes
 *
 * Events:
 *   START_ESTIMATING (draft → estimating)        {actor_user_id, occurred_at}
 *   SEND             (estimating → sent)         {actor_user_id, occurred_at}
 *   ACCEPT           (sent → accepted)           {actor_user_id, occurred_at}
 *   DECLINE          (sent → declined)           {actor_user_id, occurred_at, reason?}
 *   START_WORK       (accepted → in_progress)    {actor_user_id, occurred_at}
 *   COMPLETE         (in_progress → done)        {actor_user_id, occurred_at}
 *   ARCHIVE          (done|declined → archived)  {actor_user_id, occurred_at}
 *   REOPEN           (done|archived → in_progress) {actor_user_id, occurred_at}
 *
 * Side effects: none in this phase. The follow-up phase will wire
 * `notify_foreman_assignment` to the worker's outbox so a foreman
 * picked at ACCEPT/START_WORK time gets a push. Until then the
 * `sideEffectTypes` list is intentionally empty.
 */

export type ProjectLifecycleWorkflowState =
  | 'draft'
  | 'estimating'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'in_progress'
  | 'done'
  | 'archived'

export const PROJECT_LIFECYCLE_WORKFLOW_NAME = 'project_lifecycle'
export const PROJECT_LIFECYCLE_WORKFLOW_SCHEMA_VERSION = 1
export const PROJECT_LIFECYCLE_ALL_STATES: readonly ProjectLifecycleWorkflowState[] = [
  'draft',
  'estimating',
  'sent',
  'accepted',
  'declined',
  'in_progress',
  'done',
  'archived',
]
// REOPEN allows escape from done/archived; nothing is strictly terminal.
// declined is terminal-ish but can still be ARCHIVEd.
export const PROJECT_LIFECYCLE_TERMINAL_STATES: readonly ProjectLifecycleWorkflowState[] = []
export const PROJECT_LIFECYCLE_EVENT_TYPES = [
  'START_ESTIMATING',
  'SEND',
  'ACCEPT',
  'DECLINE',
  'START_WORK',
  'COMPLETE',
  'ARCHIVE',
  'REOPEN',
] as const

export type ProjectLifecycleWorkflowEvent =
  | { type: 'START_ESTIMATING'; actor_user_id: string; occurred_at: string }
  | { type: 'SEND'; actor_user_id: string; occurred_at: string }
  | { type: 'ACCEPT'; actor_user_id: string; occurred_at: string }
  | { type: 'DECLINE'; actor_user_id: string; occurred_at: string; reason?: string }
  | { type: 'START_WORK'; actor_user_id: string; occurred_at: string }
  | { type: 'COMPLETE'; actor_user_id: string; occurred_at: string }
  | { type: 'ARCHIVE'; actor_user_id: string; occurred_at: string }
  | { type: 'REOPEN'; actor_user_id: string; occurred_at: string }

export interface ProjectLifecycleWorkflowSnapshot {
  state: ProjectLifecycleWorkflowState
  state_version: number
  sent_at?: string | null
  accepted_at?: string | null
  declined_at?: string | null
  decline_reason?: string | null
  started_at?: string | null
  completed_at?: string | null
  archived_at?: string | null
}

function assertProjectLifecycleTransition(
  state: ProjectLifecycleWorkflowState,
  allowed: readonly ProjectLifecycleWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from project lifecycle state ${state}`)
  }
}

/**
 * Pure transition reducer for project lifecycles. No wall-clock reads,
 * no random ids, no IO — same shape as every other workflow in this
 * package so the same replay tooling applies.
 *
 * Each event payload carries `occurred_at` (ISO timestamp) instead of
 * the reducer reading the clock. Routes are responsible for stamping
 * the event with `new Date().toISOString()` at the boundary.
 */
export function transitionProjectLifecycleWorkflow(
  snapshot: ProjectLifecycleWorkflowSnapshot,
  event: ProjectLifecycleWorkflowEvent,
): ProjectLifecycleWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'START_ESTIMATING') {
    assertProjectLifecycleTransition(snapshot.state, ['draft'], event.type)
    return {
      ...snapshot,
      state: 'estimating',
      state_version: nextVersion,
    }
  }
  if (event.type === 'SEND') {
    assertProjectLifecycleTransition(snapshot.state, ['estimating'], event.type)
    return {
      ...snapshot,
      state: 'sent',
      state_version: nextVersion,
      sent_at: event.occurred_at,
    }
  }
  if (event.type === 'ACCEPT') {
    assertProjectLifecycleTransition(snapshot.state, ['sent'], event.type)
    return {
      ...snapshot,
      state: 'accepted',
      state_version: nextVersion,
      accepted_at: event.occurred_at,
      // If a previous SEND → DECLINE → (re-SEND) loop landed before, clear
      // the decline trail so the snapshot reflects the current decision.
      declined_at: null,
      decline_reason: null,
    }
  }
  if (event.type === 'DECLINE') {
    assertProjectLifecycleTransition(snapshot.state, ['sent'], event.type)
    return {
      ...snapshot,
      state: 'declined',
      state_version: nextVersion,
      declined_at: event.occurred_at,
      decline_reason: event.reason ?? null,
    }
  }
  if (event.type === 'START_WORK') {
    assertProjectLifecycleTransition(snapshot.state, ['accepted'], event.type)
    return {
      ...snapshot,
      state: 'in_progress',
      state_version: nextVersion,
      started_at: event.occurred_at,
    }
  }
  if (event.type === 'COMPLETE') {
    assertProjectLifecycleTransition(snapshot.state, ['in_progress'], event.type)
    return {
      ...snapshot,
      state: 'done',
      state_version: nextVersion,
      completed_at: event.occurred_at,
    }
  }
  if (event.type === 'ARCHIVE') {
    assertProjectLifecycleTransition(snapshot.state, ['done', 'declined'], event.type)
    return {
      ...snapshot,
      state: 'archived',
      state_version: nextVersion,
      archived_at: event.occurred_at,
    }
  }
  // REOPEN
  assertProjectLifecycleTransition(snapshot.state, ['done', 'archived'], event.type)
  return {
    ...snapshot,
    state: 'in_progress',
    state_version: nextVersion,
    // Clear the terminal-ish timestamps; the audit trail of the prior
    // COMPLETE/ARCHIVE lives in workflow_event_log keyed on
    // (entity_id, state_version).
    completed_at: null,
    archived_at: null,
  }
}

export type ProjectLifecycleHumanEventType =
  | 'START_ESTIMATING'
  | 'SEND'
  | 'ACCEPT'
  | 'DECLINE'
  | 'START_WORK'
  | 'COMPLETE'
  | 'ARCHIVE'
  | 'REOPEN'

export function nextProjectLifecycleEvents(
  state: ProjectLifecycleWorkflowState,
): Array<WorkflowNextEvent<ProjectLifecycleHumanEventType>> {
  switch (state) {
    case 'draft':
      return [{ type: 'START_ESTIMATING', label: 'Start estimating' }]
    case 'estimating':
      return [{ type: 'SEND', label: 'Send to customer' }]
    case 'sent':
      return [
        { type: 'ACCEPT', label: 'Mark accepted' },
        { type: 'DECLINE', label: 'Mark declined' },
      ]
    case 'accepted':
      return [{ type: 'START_WORK', label: 'Start work' }]
    case 'in_progress':
      return [{ type: 'COMPLETE', label: 'Mark complete' }]
    case 'done':
      return [
        { type: 'ARCHIVE', label: 'Archive project' },
        { type: 'REOPEN', label: 'Reopen project' },
      ]
    case 'declined':
      return [{ type: 'ARCHIVE', label: 'Archive project' }]
    case 'archived':
      return [{ type: 'REOPEN', label: 'Reopen project' }]
  }
}

export function isHumanProjectLifecycleEvent(eventType: string): eventType is ProjectLifecycleHumanEventType {
  return (
    eventType === 'START_ESTIMATING' ||
    eventType === 'SEND' ||
    eventType === 'ACCEPT' ||
    eventType === 'DECLINE' ||
    eventType === 'START_WORK' ||
    eventType === 'COMPLETE' ||
    eventType === 'ARCHIVE' ||
    eventType === 'REOPEN'
  )
}

export const projectLifecycleWorkflow = registerWorkflow<
  ProjectLifecycleWorkflowState,
  ProjectLifecycleWorkflowEvent,
  ProjectLifecycleHumanEventType,
  ProjectLifecycleWorkflowSnapshot
>({
  name: PROJECT_LIFECYCLE_WORKFLOW_NAME,
  schemaVersion: PROJECT_LIFECYCLE_WORKFLOW_SCHEMA_VERSION,
  initialState: 'draft',
  terminalStates: PROJECT_LIFECYCLE_TERMINAL_STATES,
  allStates: PROJECT_LIFECYCLE_ALL_STATES,
  allEventTypes: PROJECT_LIFECYCLE_EVENT_TYPES,
  reduce: transitionProjectLifecycleWorkflow,
  nextEvents: nextProjectLifecycleEvents,
  isHumanEvent: isHumanProjectLifecycleEvent,
  // Future phase: 'notify_foreman_assignment' — when ACCEPT/START_WORK
  // assigns a foreman, the worker drains an outbox row to send a push.
  // Empty for now so the route doesn't enqueue anything.
  sideEffectTypes: [] as const,
})

/**
 * Map a stored projects.lifecycle_state value to a typed reducer state.
 * Defaults to `draft` for unknown values so legacy rows that haven't
 * been backfilled flow through the workflow without throwing.
 */
export function projectStatusToLifecycleState(value: string): ProjectLifecycleWorkflowState {
  if ((PROJECT_LIFECYCLE_ALL_STATES as readonly string[]).includes(value)) {
    return value as ProjectLifecycleWorkflowState
  }
  return 'draft'
}

// Wire-format request schema for POST /api/projects/:id/lifecycle/events.
// Matches the rental-billing / time-review convention:
//   { event, state_version, reason? }
// `reason` is only consumed by DECLINE; ignored elsewhere.
export const ProjectLifecycleEventRequestSchema = z.object({
  event: z.enum(['START_ESTIMATING', 'SEND', 'ACCEPT', 'DECLINE', 'START_WORK', 'COMPLETE', 'ARCHIVE', 'REOPEN']),
  state_version: z.number().int().positive(),
  reason: z.string().min(1).max(2000).optional(),
})

export type ProjectLifecycleEventRequest = z.infer<typeof ProjectLifecycleEventRequestSchema>

export type ProjectLifecycleEventParseResult =
  | { ok: true; value: ProjectLifecycleEventRequest }
  | { ok: false; error: string }

export function parseProjectLifecycleEventRequest(body: unknown): ProjectLifecycleEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = ProjectLifecycleEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
