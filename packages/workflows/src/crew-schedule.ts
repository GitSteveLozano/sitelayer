import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Crew-schedule workflow — third deterministic workflow.
 *
 * Lifts the POST /api/schedules/:id/confirm flow into the
 * deterministic-workflow framework and now models the full assignment
 * lifecycle: creation, confirmation, decline, and re-assignment.
 *
 * Workflowization adds:
 *   - state_version optimistic-concurrency check
 *   - workflow_event_log row per transition (replay corpus)
 *   - confirmed_at + confirmed_by per row
 *
 * The CONFIRM after-effects (labor_entries insert + project version
 * bump) are modeled as a declared outbox-driven side effect
 * (`materialize_labor_entries`), exactly like rental-billing's
 * `post_qbo_invoice`. The reducer stays pure — it never inserts rows;
 * the route enqueues one stable-keyed mutation_outbox row on a non-noop
 * CONFIRM and a dedicated worker runner drains it. This makes the
 * legacy /confirm and headless /events paths behaviorally equivalent.
 *
 * States: draft → confirmed | declined; declined → draft (REASSIGN).
 *   draft → confirmed via CONFIRM
 *   draft → declined  via DECLINE
 *   declined → draft  via REASSIGN (clears decline_* audit fields)
 *   confirmed is terminal.
 *
 * CREATE is the synthetic genesis event: it is applied exactly once at
 * row creation against a {state:'draft', state_version:0} pre-seed origin
 * and ADVANCES to draft@1, so the very first workflow_event_log row is the
 * creation. Logging it at the pre-transition version (0) keeps it distinct
 * from the first human transition (dispatched against version 1) under the
 * (entity_id, workflow_name, state_version) unique key — otherwise a
 * non-advancing CREATE@1 would collide with CONFIRM@1. CREATE is never
 * offered by nextEvents.
 *
 * Future: add CANCEL transition once the UI ships a cancellation
 * affordance (would require re-versioning the reducer to v2).
 */

export type CrewScheduleWorkflowState = 'draft' | 'confirmed' | 'declined'

export const CREW_SCHEDULE_WORKFLOW_NAME = 'crew_schedule'
export const CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION = 1
export const CREW_SCHEDULE_ALL_STATES: readonly CrewScheduleWorkflowState[] = ['draft', 'confirmed', 'declined']
export const CREW_SCHEDULE_TERMINAL_STATES: readonly CrewScheduleWorkflowState[] = ['confirmed']
export const CREW_SCHEDULE_EVENT_TYPES = ['CREATE', 'CONFIRM', 'DECLINE', 'REASSIGN'] as const

export type CrewScheduleWorkflowEvent =
  | { type: 'CREATE'; created_by?: string | null }
  | { type: 'CONFIRM'; confirmed_at: string; confirmed_by: string }
  | { type: 'DECLINE'; declined_at: string; declined_by: string; reason: string }
  | { type: 'REASSIGN' }

export interface CrewScheduleWorkflowSnapshot {
  state: CrewScheduleWorkflowState
  state_version: number
  confirmed_at?: string | null
  confirmed_by?: string | null
  created_by?: string | null
  declined_at?: string | null
  declined_by?: string | null
  decline_reason?: string | null
}

function assertCrewScheduleTransition(
  state: CrewScheduleWorkflowState,
  allowed: readonly CrewScheduleWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from crew schedule state ${state}`)
  }
}

export function transitionCrewScheduleWorkflow(
  snapshot: CrewScheduleWorkflowSnapshot,
  event: CrewScheduleWorkflowEvent,
): CrewScheduleWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  // CREATE is the synthetic genesis event. It stamps create metadata and
  // ADVANCES the {state:'draft', state_version:0} pre-seed origin to
  // draft@1 at row-creation time, giving the replay corpus a true first
  // row. Advancing (rather than the old non-advancing CREATE@1) keeps the
  // genesis event's recorded state_version (0) distinct from the first
  // human transition's (1), so the (entity_id, workflow_name,
  // state_version) unique key never collides.
  if (event.type === 'CREATE') {
    if (snapshot.state !== 'draft' || snapshot.state_version !== 0) {
      throw new Error(`event CREATE is only legal on a genesis snapshot (draft @ state_version 0)`)
    }
    return {
      ...snapshot,
      state: 'draft',
      state_version: nextVersion,
      created_by: event.created_by ?? null,
    }
  }
  if (event.type === 'CONFIRM') {
    assertCrewScheduleTransition(snapshot.state, ['draft'], event.type)
    return {
      ...snapshot,
      state: 'confirmed',
      state_version: nextVersion,
      confirmed_at: event.confirmed_at,
      confirmed_by: event.confirmed_by,
    }
  }
  if (event.type === 'DECLINE') {
    assertCrewScheduleTransition(snapshot.state, ['draft'], event.type)
    return {
      ...snapshot,
      state: 'declined',
      state_version: nextVersion,
      declined_at: event.declined_at,
      declined_by: event.declined_by,
      decline_reason: event.reason,
    }
  }
  if (event.type === 'REASSIGN') {
    assertCrewScheduleTransition(snapshot.state, ['declined'], event.type)
    return {
      ...snapshot,
      state: 'draft',
      state_version: nextVersion,
      declined_at: null,
      declined_by: null,
      decline_reason: null,
    }
  }
  // Exhaustive: any future event must add a branch here. The cast
  // makes TS surface the omission as a compile error.
  const exhaustive: never = event
  throw new Error(`unhandled crew schedule event ${JSON.stringify(exhaustive)}`)
}

// CREATE is dispatched only at row creation (never offered post-hoc),
// so the human-event type the snapshot/event API surfaces excludes it.
export type CrewScheduleHumanEventType = 'CONFIRM' | 'DECLINE' | 'REASSIGN'

export function nextCrewScheduleEvents(
  state: CrewScheduleWorkflowState,
): Array<WorkflowNextEvent<CrewScheduleHumanEventType>> {
  switch (state) {
    case 'draft':
      return [
        { type: 'CONFIRM', label: 'Confirm crew schedule' },
        { type: 'DECLINE', label: 'Decline assignment' },
      ]
    case 'declined':
      return [{ type: 'REASSIGN', label: 'Re-assign' }]
    case 'confirmed':
      return []
  }
}

export function isHumanCrewScheduleEvent(eventType: string): eventType is CrewScheduleHumanEventType {
  return eventType === 'CONFIRM' || eventType === 'DECLINE' || eventType === 'REASSIGN'
}

export const crewScheduleWorkflow = registerWorkflow<
  CrewScheduleWorkflowState,
  CrewScheduleWorkflowEvent,
  CrewScheduleHumanEventType,
  CrewScheduleWorkflowSnapshot
>({
  name: CREW_SCHEDULE_WORKFLOW_NAME,
  schemaVersion: CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
  initialState: 'draft',
  terminalStates: CREW_SCHEDULE_TERMINAL_STATES,
  allStates: CREW_SCHEDULE_ALL_STATES,
  allEventTypes: CREW_SCHEDULE_EVENT_TYPES,
  reduce: transitionCrewScheduleWorkflow,
  nextEvents: nextCrewScheduleEvents,
  isHumanEvent: isHumanCrewScheduleEvent,
  // Outbox-driven side effects:
  //  - materialize_labor_entries: enqueued on a non-noop CONFIRM; the
  //    worker inserts confirmed labor_entries + bumps projects.version.
  //  - notify_foreman_decline: enqueued on DECLINE; the worker fans a
  //    notifications row out to the project foreman (in-band, replacing
  //    the old worker-issues note).
  sideEffectTypes: ['materialize_labor_entries', 'notify_foreman_decline'] as const,
})

/** One per-worker confirmed labor entry to materialize on CONFIRM. Side-effect
 * data carried on the CONFIRM request body (not reducer state). */
export const CrewScheduleLaborEntryInputSchema = z.object({
  worker_id: z.string().nullish(),
  service_item_code: z.string(),
  hours: z.number(),
  sqft_done: z.number().nullish(),
  occurred_on: z.string(),
})
export type CrewScheduleLaborEntryInput = z.infer<typeof CrewScheduleLaborEntryInputSchema>

export const CrewScheduleEventRequestSchema = z.object({
  event: z.enum(['CONFIRM', 'DECLINE', 'REASSIGN']),
  state_version: z.number().int().positive(),
  /** CONFIRM only — per-worker labor entries to materialize via the outbox. */
  entries: z.array(CrewScheduleLaborEntryInputSchema).optional(),
  /** DECLINE only — the worker's decline reason. */
  reason: z.string().optional(),
})

export type CrewScheduleEventRequest = z.infer<typeof CrewScheduleEventRequestSchema>
export type CrewScheduleEventParseResult = { ok: true; value: CrewScheduleEventRequest } | { ok: false; error: string }

export function parseCrewScheduleEventRequest(body: unknown): CrewScheduleEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = CrewScheduleEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
