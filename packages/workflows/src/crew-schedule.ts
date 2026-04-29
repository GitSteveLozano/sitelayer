import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Crew-schedule workflow — third deterministic workflow.
 *
 * Lifts the existing POST /api/schedules/:id/confirm flow into the
 * deterministic-workflow framework. The route already does:
 *   - update crew_schedules set status='confirmed'
 *   - insert N labor_entries for the confirmed crew
 *   - bump project version
 *   - recordMutationLedger
 *
 * Workflowization adds:
 *   - state_version optimistic-concurrency check
 *   - workflow_event_log row per transition (replay corpus)
 *   - confirmed_at + confirmed_by per row
 *
 * The labor_entries insert and project bump remain in the route as
 * after-effects of the CONFIRM event — they're not modeled as
 * outbox-driven side effects because they're synchronous database
 * writes that must succeed in the same tx.
 *
 * States: draft → confirmed.
 *   draft → confirmed via CONFIRM event
 *   confirmed is terminal for this v1 reducer
 *
 * Future: add CANCEL transition once the UI ships a cancellation
 * affordance (would require re-versioning the reducer to v2).
 */

export type CrewScheduleWorkflowState = 'draft' | 'confirmed'

export const CREW_SCHEDULE_WORKFLOW_NAME = 'crew_schedule'
export const CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION = 1
export const CREW_SCHEDULE_ALL_STATES: readonly CrewScheduleWorkflowState[] = ['draft', 'confirmed']
export const CREW_SCHEDULE_TERMINAL_STATES: readonly CrewScheduleWorkflowState[] = ['confirmed']
export const CREW_SCHEDULE_EVENT_TYPES = ['CONFIRM'] as const

export type CrewScheduleWorkflowEvent = { type: 'CONFIRM'; confirmed_at: string; confirmed_by: string }

export interface CrewScheduleWorkflowSnapshot {
  state: CrewScheduleWorkflowState
  state_version: number
  confirmed_at?: string | null
  confirmed_by?: string | null
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
  // Single event type today; this if-chain stays narrow but mirrors
  // the rental-billing/estimate-push shape so future events slot in.
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
  // Exhaustive: any future event must add a branch here. The cast
  // makes TS surface the omission as a compile error.
  const exhaustive: never = event.type
  throw new Error(`unhandled crew schedule event ${exhaustive}`)
}

export type CrewScheduleHumanEventType = 'CONFIRM'

export function nextCrewScheduleEvents(
  state: CrewScheduleWorkflowState,
): Array<WorkflowNextEvent<CrewScheduleHumanEventType>> {
  switch (state) {
    case 'draft':
      return [{ type: 'CONFIRM', label: 'Confirm crew schedule' }]
    case 'confirmed':
      return []
  }
}

export function isHumanCrewScheduleEvent(eventType: string): eventType is CrewScheduleHumanEventType {
  return eventType === 'CONFIRM'
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
  // No outbox-driven side effects — labor_entries insert and project
  // version bump happen in the same API tx, not via the worker.
  sideEffectTypes: [] as const,
})

export const CrewScheduleEventRequestSchema = z.object({
  event: z.enum(['CONFIRM']),
  state_version: z.number().int().positive(),
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
