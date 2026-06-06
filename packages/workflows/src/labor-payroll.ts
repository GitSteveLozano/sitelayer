import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Labor payroll workflow — QBO TimeActivity export.
 *
 * Pairs with time-review: after a time_review_run is APPROVED, the
 * `lock_labor_entries` worker handler stamps review_locked_at on every
 * covered labor_entry and ALSO enqueues a `generate_labor_payroll_run`
 * side-effect that materialises a labor_payroll_run row in the
 * 'generated' state. The payroll run then walks the same
 * generated → approved → posting → posted | failed → voided pipeline
 * the rental-billing workflow uses, except the QBO push translates
 * each covered labor_entry into a TimeActivity record and the success
 * payload carries the array of QBO TimeActivity ids.
 *
 * Mirrors rental-billing.ts shape EXACTLY — same state machine, same
 * event vocabulary, same parser. Only the success event payload
 * differs (an array of ids instead of a single invoice id) so the QBO
 * batch can be reconciled later.
 *
 * States: generated → approved → posting → posted | failed → voided.
 *
 * Events:
 *   APPROVE        (generated → approved)         {approved_at, approved_by}
 *   POST_REQUESTED (approved | failed → posting)
 *   POST_SUCCEEDED (posting → posted)             {posted_at, qbo_timeactivity_ids[]}
 *   POST_FAILED    (posting → failed)             {failed_at, error}
 *   RETRY_POST     (failed → approved)
 *   VOID           (generated | approved | failed → voided)
 *
 * Side effect type: `post_qbo_time_activities`. Idempotency key is
 * `labor_payroll_run:post:<run_id>` (per-run, NOT per-state_version)
 * so a RETRY_POST → POST_REQUESTED replay lands on the same outbox
 * row and the worker's `on conflict do update` resets it to pending
 * without creating duplicate work.
 */

export type LaborPayrollWorkflowState = 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'

export const LABOR_PAYROLL_WORKFLOW_NAME = 'labor_payroll_run'
export const LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION = 1
export const LABOR_PAYROLL_ALL_STATES: readonly LaborPayrollWorkflowState[] = [
  'generated',
  'approved',
  'posting',
  'posted',
  'failed',
  'voided',
]
export const LABOR_PAYROLL_TERMINAL_STATES: readonly LaborPayrollWorkflowState[] = ['posted', 'voided']
export const LABOR_PAYROLL_EVENT_TYPES = [
  'APPROVE',
  'POST_REQUESTED',
  'POST_SUCCEEDED',
  'POST_FAILED',
  'RETRY_POST',
  'VOID',
  // Worker-only auto-advance events (NOT acceptable at POST /events).
  // They walk the same edges as APPROVE / POST_REQUESTED, but the worker
  // auto-post tick is the actor instead of a human. Kept distinct from the
  // human events so the event log + isHumanLaborPayrollEvent split can tell
  // an operator action from an automated one (audit + UI badge).
  'AUTO_APPROVE',
  'AUTO_POST_REQUESTED',
] as const

export type LaborPayrollWorkflowEvent =
  | { type: 'APPROVE'; approved_at: string; approved_by: string }
  | { type: 'POST_REQUESTED' }
  | { type: 'POST_SUCCEEDED'; posted_at: string; qbo_timeactivity_ids: string[] }
  | { type: 'POST_FAILED'; failed_at: string; error: string }
  | { type: 'RETRY_POST' }
  | { type: 'VOID' }
  // Worker auto-post events. The worker reads the clock/policy and supplies
  // approved_at / approved_by in the payload — the reducer stays pure.
  | { type: 'AUTO_APPROVE'; approved_at: string; approved_by: string }
  | { type: 'AUTO_POST_REQUESTED' }

export interface LaborPayrollWorkflowSnapshot {
  state: LaborPayrollWorkflowState
  state_version: number
  approved_at?: string | null
  approved_by?: string | null
  posted_at?: string | null
  failed_at?: string | null
  error?: string | null
  qbo_timeactivity_ids?: string[] | null
  /** True when an AUTO_APPROVE or AUTO_POST_REQUESTED advanced this run, so
   * the trail/UI can label it "Auto-posted". Set by the auto events only. */
  auto_posted?: boolean | null
}

function assertLaborPayrollTransition(
  state: LaborPayrollWorkflowState,
  allowed: readonly LaborPayrollWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from labor payroll state ${state}`)
  }
}

/**
 * Pure transition reducer for labor payroll runs. Intentionally has no
 * wall-clock reads, random ids, network calls, or DB access so the
 * same transition table can be used from an API handler, XState
 * machine, or Temporal workflow activity boundary.
 */
export function transitionLaborPayrollWorkflow(
  snapshot: LaborPayrollWorkflowSnapshot,
  event: LaborPayrollWorkflowEvent,
): LaborPayrollWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'APPROVE') {
    assertLaborPayrollTransition(snapshot.state, ['generated'], event.type)
    return {
      ...snapshot,
      state: 'approved',
      state_version: nextVersion,
      approved_at: event.approved_at,
      approved_by: event.approved_by,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'POST_REQUESTED') {
    assertLaborPayrollTransition(snapshot.state, ['approved', 'failed'], event.type)
    return {
      ...snapshot,
      state: 'posting',
      state_version: nextVersion,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'POST_SUCCEEDED') {
    assertLaborPayrollTransition(snapshot.state, ['posting'], event.type)
    return {
      ...snapshot,
      state: 'posted',
      state_version: nextVersion,
      posted_at: event.posted_at,
      qbo_timeactivity_ids: event.qbo_timeactivity_ids,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'POST_FAILED') {
    assertLaborPayrollTransition(snapshot.state, ['posting'], event.type)
    return {
      ...snapshot,
      state: 'failed',
      state_version: nextVersion,
      failed_at: event.failed_at,
      error: event.error,
    }
  }
  if (event.type === 'RETRY_POST') {
    assertLaborPayrollTransition(snapshot.state, ['failed'], event.type)
    return {
      ...snapshot,
      state: 'approved',
      state_version: nextVersion,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'AUTO_APPROVE') {
    // Worker auto-advance — same edge as APPROVE (generated → approved),
    // but flags auto_posted so the trail/UI can label it. A stale auto-tick
    // that races a human VOID is rejected here because the run already left
    // `generated`.
    assertLaborPayrollTransition(snapshot.state, ['generated'], event.type)
    return {
      ...snapshot,
      state: 'approved',
      state_version: nextVersion,
      approved_at: event.approved_at,
      approved_by: event.approved_by,
      auto_posted: true,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'AUTO_POST_REQUESTED') {
    // Worker auto-advance — same edge as POST_REQUESTED (approved → posting),
    // enqueues the same post_qbo_time_activities outbox row. Only from
    // `approved` (NOT `failed`): auto-post never re-pushes a failed run.
    assertLaborPayrollTransition(snapshot.state, ['approved'], event.type)
    return {
      ...snapshot,
      state: 'posting',
      state_version: nextVersion,
      auto_posted: true,
      error: null,
      failed_at: null,
    }
  }
  assertLaborPayrollTransition(snapshot.state, ['generated', 'approved', 'failed'], event.type)
  return {
    ...snapshot,
    state: 'voided',
    state_version: nextVersion,
  }
}

export type LaborPayrollHumanEventType = 'APPROVE' | 'POST_REQUESTED' | 'RETRY_POST' | 'VOID'

export function nextLaborPayrollEvents(
  state: LaborPayrollWorkflowState,
): Array<WorkflowNextEvent<LaborPayrollHumanEventType>> {
  switch (state) {
    case 'generated':
      return [
        { type: 'APPROVE', label: 'Approve payroll run' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'approved':
      return [
        { type: 'POST_REQUESTED', label: 'Post time activities to QuickBooks' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'failed':
      return [
        { type: 'RETRY_POST', label: 'Retry QuickBooks post' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'posting':
    case 'posted':
    case 'voided':
      return []
  }
}

export function isHumanLaborPayrollEvent(eventType: string): eventType is LaborPayrollHumanEventType {
  return eventType === 'APPROVE' || eventType === 'POST_REQUESTED' || eventType === 'RETRY_POST' || eventType === 'VOID'
}

export const laborPayrollWorkflow = registerWorkflow<
  LaborPayrollWorkflowState,
  LaborPayrollWorkflowEvent,
  LaborPayrollHumanEventType,
  LaborPayrollWorkflowSnapshot
>({
  name: LABOR_PAYROLL_WORKFLOW_NAME,
  schemaVersion: LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION,
  initialState: 'generated',
  terminalStates: LABOR_PAYROLL_TERMINAL_STATES,
  allStates: LABOR_PAYROLL_ALL_STATES,
  allEventTypes: LABOR_PAYROLL_EVENT_TYPES,
  reduce: transitionLaborPayrollWorkflow,
  nextEvents: nextLaborPayrollEvents,
  isHumanEvent: isHumanLaborPayrollEvent,
  sideEffectTypes: ['post_qbo_time_activities'] as const,
})

// Wire-format request schema for POST /api/labor-payroll-runs/:id/events.
// Matches the rental-billing convention: { event, state_version }.
export const LaborPayrollEventRequestSchema = z.object({
  event: z.enum(['APPROVE', 'POST_REQUESTED', 'RETRY_POST', 'VOID']),
  state_version: z.number().int().positive(),
})

export type LaborPayrollEventRequest = z.infer<typeof LaborPayrollEventRequestSchema>

export type LaborPayrollEventParseResult = { ok: true; value: LaborPayrollEventRequest } | { ok: false; error: string }

/**
 * Parse a JSON-body Record<string, unknown> as a labor-payroll event
 * request. Returns a discriminated result so route handlers can render
 * a 400 with the human-readable error without throwing.
 */
export function parseLaborPayrollEventRequest(body: unknown): LaborPayrollEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = LaborPayrollEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
