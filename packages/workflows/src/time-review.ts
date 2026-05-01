import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Time review workflow — sixth deterministic workflow.
 *
 * Backs the foreman/office "approval queue" surface from
 * `Sitemap.html` § t-approve. A run gathers a window of labor_entries
 * (a pay period, a single day for one project) and walks them through
 * a tiny state machine. The run as a whole is approved or rejected;
 * per-entry edits stay on PATCH /api/labor-entries/:id so the workflow
 * doesn't fragment the existing write path.
 *
 * States:
 *   pending    a queued run waiting for a reviewer
 *   approved   reviewer signed off; locks every covered_entry_id
 *   rejected   reviewer pushed back; foreman/office must re-collect
 *
 * Events:
 *   APPROVE (pending → approved)    {approved_at, reviewer_user_id}
 *   REJECT  (pending → rejected)    {rejected_at, reviewer_user_id, reason}
 *   REOPEN  (approved|rejected → pending)  {reopened_at, reviewer_user_id, reason}
 *
 * REOPEN is the path back to pending after corrections — it preserves
 * the audit trail in workflow_event_log instead of mutating the
 * approval timestamp. There's no terminal state; even an approved run
 * can be reopened if a paycheck dispute surfaces a missed correction.
 *
 * Side effect: `lock_labor_entries` is emitted on APPROVE. The worker
 * (Phase 1B) drains the outbox and sets review_locked_at +
 * review_run_id on every uuid in covered_entry_ids. Idempotent: the
 * outbox key is `time_review:lock:<run_id>:<state_version>`.
 */

export type TimeReviewWorkflowState = 'pending' | 'approved' | 'rejected'

export const TIME_REVIEW_WORKFLOW_NAME = 'time_review_run'
export const TIME_REVIEW_WORKFLOW_SCHEMA_VERSION = 1
export const TIME_REVIEW_ALL_STATES: readonly TimeReviewWorkflowState[] = ['pending', 'approved', 'rejected']
// REOPEN allows escaping any state, so nothing is truly terminal.
export const TIME_REVIEW_TERMINAL_STATES: readonly TimeReviewWorkflowState[] = []
export const TIME_REVIEW_EVENT_TYPES = ['APPROVE', 'REJECT', 'REOPEN'] as const

export type TimeReviewWorkflowEvent =
  | { type: 'APPROVE'; approved_at: string; reviewer_user_id: string }
  | { type: 'REJECT'; rejected_at: string; reviewer_user_id: string; reason: string }
  | { type: 'REOPEN'; reopened_at: string; reviewer_user_id: string; reason: string }

export interface TimeReviewWorkflowSnapshot {
  state: TimeReviewWorkflowState
  state_version: number
  reviewer_user_id?: string | null
  approved_at?: string | null
  rejected_at?: string | null
  rejection_reason?: string | null
  reopened_at?: string | null
}

function assertTimeReviewTransition(
  state: TimeReviewWorkflowState,
  allowed: readonly TimeReviewWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from time review state ${state}`)
  }
}

/**
 * Pure transition reducer for time review runs. No wall-clock reads,
 * no random ids, no IO — same as every other workflow in this package
 * so the same replay tooling applies.
 */
export function transitionTimeReviewWorkflow(
  snapshot: TimeReviewWorkflowSnapshot,
  event: TimeReviewWorkflowEvent,
): TimeReviewWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'APPROVE') {
    assertTimeReviewTransition(snapshot.state, ['pending'], event.type)
    return {
      ...snapshot,
      state: 'approved',
      state_version: nextVersion,
      approved_at: event.approved_at,
      reviewer_user_id: event.reviewer_user_id,
      // Clear any prior rejection trail on successful approval.
      rejected_at: null,
      rejection_reason: null,
    }
  }
  if (event.type === 'REJECT') {
    assertTimeReviewTransition(snapshot.state, ['pending'], event.type)
    return {
      ...snapshot,
      state: 'rejected',
      state_version: nextVersion,
      rejected_at: event.rejected_at,
      rejection_reason: event.reason,
      reviewer_user_id: event.reviewer_user_id,
      // Clear any prior approval trail.
      approved_at: null,
    }
  }
  // REOPEN
  assertTimeReviewTransition(snapshot.state, ['approved', 'rejected'], event.type)
  return {
    ...snapshot,
    state: 'pending',
    state_version: nextVersion,
    reopened_at: event.reopened_at,
    reviewer_user_id: event.reviewer_user_id,
    // Clear the prior decision fields. Migration 027's
    // time_review_runs_decision_chk requires approved_at, rejected_at,
    // and rejection_reason all be NULL when state='pending'; without
    // this clear the persisted UPDATE would violate the constraint.
    // The full audit trail of the prior approval/rejection lives in
    // workflow_event_log keyed on (entity_id, state_version).
    approved_at: null,
    rejected_at: null,
    rejection_reason: null,
  }
}

export type TimeReviewHumanEventType = 'APPROVE' | 'REJECT' | 'REOPEN'

export function nextTimeReviewEvents(
  state: TimeReviewWorkflowState,
): Array<WorkflowNextEvent<TimeReviewHumanEventType>> {
  switch (state) {
    case 'pending':
      return [
        { type: 'APPROVE', label: 'Approve run' },
        { type: 'REJECT', label: 'Reject — needs corrections' },
      ]
    case 'approved':
      return [{ type: 'REOPEN', label: 'Reopen for correction' }]
    case 'rejected':
      return [{ type: 'REOPEN', label: 'Reopen' }]
  }
}

export function isHumanTimeReviewEvent(eventType: string): eventType is TimeReviewHumanEventType {
  return eventType === 'APPROVE' || eventType === 'REJECT' || eventType === 'REOPEN'
}

export const timeReviewWorkflow = registerWorkflow<
  TimeReviewWorkflowState,
  TimeReviewWorkflowEvent,
  TimeReviewHumanEventType,
  TimeReviewWorkflowSnapshot
>({
  name: TIME_REVIEW_WORKFLOW_NAME,
  schemaVersion: TIME_REVIEW_WORKFLOW_SCHEMA_VERSION,
  initialState: 'pending',
  terminalStates: TIME_REVIEW_TERMINAL_STATES,
  allStates: TIME_REVIEW_ALL_STATES,
  allEventTypes: TIME_REVIEW_EVENT_TYPES,
  reduce: transitionTimeReviewWorkflow,
  nextEvents: nextTimeReviewEvents,
  isHumanEvent: isHumanTimeReviewEvent,
  // Phase 1B's worker drains 'lock_labor_entries' from mutation_outbox
  // when an APPROVE transition lands. Idempotency key is per-run +
  // per-state_version so RETRY replays land on the same outbox row.
  sideEffectTypes: ['lock_labor_entries'] as const,
})

// Wire-format request schema for POST /api/time-review-runs/:id/events.
// Matches the rental-billing convention: { event, state_version, ... }.
// `reason` is required for REJECT and REOPEN; optional (and ignored) for
// APPROVE.
export const TimeReviewEventRequestSchema = z
  .object({
    event: z.enum(['APPROVE', 'REJECT', 'REOPEN']),
    state_version: z.number().int().positive(),
    reason: z.string().min(1).max(2000).optional(),
  })
  .refine((v) => v.event === 'APPROVE' || (typeof v.reason === 'string' && v.reason.trim().length > 0), {
    message: 'reason is required for REJECT and REOPEN',
    path: ['reason'],
  })

export type TimeReviewEventRequest = z.infer<typeof TimeReviewEventRequestSchema>

export type TimeReviewEventParseResult =
  | { ok: true; value: TimeReviewEventRequest }
  | { ok: false; error: string }

export function parseTimeReviewEventRequest(body: unknown): TimeReviewEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = TimeReviewEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
