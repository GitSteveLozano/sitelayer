import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Daily-log workflow — foreman end-of-day submission.
 *
 * Lifts the existing POST /api/daily-logs/:id/submit flow into the
 * deterministic-workflow framework. The route already does:
 *   - update daily_logs set status='submitted', submitted_at=now()
 *   - bump version
 *   - recordMutationLedger (with idempotency key)
 *
 * Workflowization adds:
 *   - state_version optimistic-concurrency check
 *   - workflow_event_log row per transition (replay corpus)
 *   - canonical reducer shape so audit / replay tooling treats this the
 *     same as the other ten workflows
 *
 * States: draft → submitted.
 *   draft → submitted via SUBMIT event
 *   submitted is terminal — there is no UNSUBMIT today. A foreman who
 *   needs to correct a submitted log goes through admin (manual SQL
 *   today; future v2 reducer could add an UNSUBMIT transition if the
 *   product surfaces it).
 *
 * No outbox-driven side effects — submitted logs are read by the cohort
 * model and analytics endpoints in-place. There's no QBO push, no
 * notification fan-out.
 */

export type DailyLogWorkflowState = 'draft' | 'submitted'

export const DAILY_LOG_WORKFLOW_NAME = 'daily_log'
export const DAILY_LOG_WORKFLOW_SCHEMA_VERSION = 1
export const DAILY_LOG_ALL_STATES: readonly DailyLogWorkflowState[] = ['draft', 'submitted']
export const DAILY_LOG_TERMINAL_STATES: readonly DailyLogWorkflowState[] = ['submitted']
export const DAILY_LOG_EVENT_TYPES = ['SUBMIT'] as const

export type DailyLogWorkflowEvent = { type: 'SUBMIT'; submitted_at: string; submitted_by: string }

export interface DailyLogWorkflowSnapshot {
  state: DailyLogWorkflowState
  state_version: number
  submitted_at?: string | null
  submitted_by?: string | null
}

function assertDailyLogTransition(
  state: DailyLogWorkflowState,
  allowed: readonly DailyLogWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from daily log state ${state}`)
  }
}

/**
 * Pure transition reducer for daily logs. Intentionally has no
 * wall-clock reads, random ids, network calls, or DB access so the same
 * transition table can be used from an API handler, XState machine, or
 * Temporal workflow activity boundary. `submitted_at` is passed in by
 * the caller so the reducer remains deterministic.
 */
export function transitionDailyLogWorkflow(
  snapshot: DailyLogWorkflowSnapshot,
  event: DailyLogWorkflowEvent,
): DailyLogWorkflowSnapshot {
  if (event.type === 'SUBMIT') {
    assertDailyLogTransition(snapshot.state, ['draft'], event.type)
    return {
      ...snapshot,
      state: 'submitted',
      state_version: snapshot.state_version + 1,
      submitted_at: event.submitted_at,
      submitted_by: event.submitted_by,
    }
  }
  // Exhaustive: any future event must add a branch here.
  const exhaustive: never = event.type
  throw new Error(`unhandled daily log event ${exhaustive}`)
}

export type DailyLogHumanEventType = 'SUBMIT'

export function nextDailyLogEvents(state: DailyLogWorkflowState): Array<WorkflowNextEvent<DailyLogHumanEventType>> {
  switch (state) {
    case 'draft':
      return [{ type: 'SUBMIT', label: 'Submit daily log' }]
    case 'submitted':
      return []
  }
}

export function isHumanDailyLogEvent(eventType: string): eventType is DailyLogHumanEventType {
  return eventType === 'SUBMIT'
}

/**
 * Map a stored daily_logs.status value to the reducer's two-state
 * vocabulary. The DB CHECK constraint already restricts values to
 * 'draft' | 'submitted', so this is a defensive identity for type
 * narrowing rather than a normalization step.
 */
export function dailyLogStatusToWorkflowState(status: string): DailyLogWorkflowState {
  return status === 'submitted' ? 'submitted' : 'draft'
}

export const dailyLogWorkflow = registerWorkflow<
  DailyLogWorkflowState,
  DailyLogWorkflowEvent,
  DailyLogHumanEventType,
  DailyLogWorkflowSnapshot
>({
  name: DAILY_LOG_WORKFLOW_NAME,
  schemaVersion: DAILY_LOG_WORKFLOW_SCHEMA_VERSION,
  initialState: 'draft',
  terminalStates: DAILY_LOG_TERMINAL_STATES,
  allStates: DAILY_LOG_ALL_STATES,
  allEventTypes: DAILY_LOG_EVENT_TYPES,
  reduce: transitionDailyLogWorkflow,
  nextEvents: nextDailyLogEvents,
  isHumanEvent: isHumanDailyLogEvent,
  // No outbox-driven side effects — submission is purely a DB state
  // change plus an audit row.
  sideEffectTypes: [] as const,
})

export const DailyLogEventRequestSchema = z.object({
  event: z.enum(['SUBMIT']),
  state_version: z.number().int().positive(),
})

export type DailyLogEventRequest = z.infer<typeof DailyLogEventRequestSchema>
export type DailyLogEventParseResult = { ok: true; value: DailyLogEventRequest } | { ok: false; error: string }

export function parseDailyLogEventRequest(body: unknown): DailyLogEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = DailyLogEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
