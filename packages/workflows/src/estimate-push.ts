import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Estimate-push workflow — second deterministic workflow, mirrors the
 * rental-billing shape so the abstraction is exercised before more
 * customer-facing flows pile on.
 *
 * The flow lifts the implicit logic from POST /api/projects/:id/estimate/push-qbo
 * into an explicit state machine. Today that endpoint is a one-shot
 * "compute and push"; under this model an estimate transitions through
 * drafted → reviewed → approved → posting → posted/failed, with a
 * VOID escape hatch and RETRY_POST after a failure.
 *
 * No API route changes ship with this file. Wiring is the job of a
 * follow-up: add an `estimate_pushes` table mirroring the
 * rental_billing_runs columns (status, state_version, posted_at, etc.)
 * plus events endpoints that call transitionEstimatePushWorkflow.
 */

export type EstimatePushWorkflowState =
  | 'drafted'
  | 'reviewed'
  | 'approved'
  | 'posting'
  | 'posted'
  | 'failed'
  | 'voided'

export const ESTIMATE_PUSH_WORKFLOW_NAME = 'estimate_push'
export const ESTIMATE_PUSH_WORKFLOW_SCHEMA_VERSION = 1
export const ESTIMATE_PUSH_ALL_STATES: readonly EstimatePushWorkflowState[] = [
  'drafted',
  'reviewed',
  'approved',
  'posting',
  'posted',
  'failed',
  'voided',
]
export const ESTIMATE_PUSH_TERMINAL_STATES: readonly EstimatePushWorkflowState[] = ['posted', 'voided']
export const ESTIMATE_PUSH_EVENT_TYPES = [
  'REVIEW',
  'APPROVE',
  'POST_REQUESTED',
  'POST_SUCCEEDED',
  'POST_FAILED',
  'RETRY_POST',
  'VOID',
] as const

export type EstimatePushWorkflowEvent =
  | { type: 'REVIEW'; reviewed_at: string; reviewed_by: string }
  | { type: 'APPROVE'; approved_at: string; approved_by: string }
  | { type: 'POST_REQUESTED' }
  | { type: 'POST_SUCCEEDED'; posted_at: string; qbo_estimate_id: string }
  | { type: 'POST_FAILED'; failed_at: string; error: string }
  | { type: 'RETRY_POST' }
  | { type: 'VOID' }

export interface EstimatePushWorkflowSnapshot {
  state: EstimatePushWorkflowState
  state_version: number
  reviewed_at?: string | null
  reviewed_by?: string | null
  approved_at?: string | null
  approved_by?: string | null
  posted_at?: string | null
  failed_at?: string | null
  error?: string | null
  qbo_estimate_id?: string | null
}

function assertEstimatePushTransition(
  state: EstimatePushWorkflowState,
  allowed: readonly EstimatePushWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from estimate push state ${state}`)
  }
}

/**
 * Pure transition reducer. No clock reads, random ids, network calls,
 * or DB access. Same shape as transitionRentalBillingWorkflow.
 */
export function transitionEstimatePushWorkflow(
  snapshot: EstimatePushWorkflowSnapshot,
  event: EstimatePushWorkflowEvent,
): EstimatePushWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'REVIEW') {
    assertEstimatePushTransition(snapshot.state, ['drafted'], event.type)
    return {
      ...snapshot,
      state: 'reviewed',
      state_version: nextVersion,
      reviewed_at: event.reviewed_at,
      reviewed_by: event.reviewed_by,
    }
  }
  if (event.type === 'APPROVE') {
    assertEstimatePushTransition(snapshot.state, ['reviewed'], event.type)
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
    assertEstimatePushTransition(snapshot.state, ['approved', 'failed'], event.type)
    return {
      ...snapshot,
      state: 'posting',
      state_version: nextVersion,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'POST_SUCCEEDED') {
    assertEstimatePushTransition(snapshot.state, ['posting'], event.type)
    return {
      ...snapshot,
      state: 'posted',
      state_version: nextVersion,
      posted_at: event.posted_at,
      qbo_estimate_id: event.qbo_estimate_id,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'POST_FAILED') {
    assertEstimatePushTransition(snapshot.state, ['posting'], event.type)
    return {
      ...snapshot,
      state: 'failed',
      state_version: nextVersion,
      failed_at: event.failed_at,
      error: event.error,
    }
  }
  if (event.type === 'RETRY_POST') {
    assertEstimatePushTransition(snapshot.state, ['failed'], event.type)
    return {
      ...snapshot,
      state: 'approved',
      state_version: nextVersion,
      error: null,
      failed_at: null,
    }
  }
  // VOID
  assertEstimatePushTransition(snapshot.state, ['drafted', 'reviewed', 'approved', 'failed'], event.type)
  return {
    ...snapshot,
    state: 'voided',
    state_version: nextVersion,
  }
}

export type EstimatePushHumanEventType = 'REVIEW' | 'APPROVE' | 'POST_REQUESTED' | 'RETRY_POST' | 'VOID'

export function nextEstimatePushEvents(
  state: EstimatePushWorkflowState,
): Array<WorkflowNextEvent<EstimatePushHumanEventType>> {
  switch (state) {
    case 'drafted':
      return [
        { type: 'REVIEW', label: 'Mark reviewed' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'reviewed':
      return [
        { type: 'APPROVE', label: 'Approve estimate' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'approved':
      return [
        { type: 'POST_REQUESTED', label: 'Push estimate to QuickBooks' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'failed':
      return [
        { type: 'RETRY_POST', label: 'Retry QuickBooks push' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'posting':
    case 'posted':
    case 'voided':
      return []
  }
}

export function isHumanEstimatePushEvent(eventType: string): eventType is EstimatePushHumanEventType {
  return (
    eventType === 'REVIEW' ||
    eventType === 'APPROVE' ||
    eventType === 'POST_REQUESTED' ||
    eventType === 'RETRY_POST' ||
    eventType === 'VOID'
  )
}

export const estimatePushWorkflow = registerWorkflow<
  EstimatePushWorkflowState,
  EstimatePushWorkflowEvent,
  EstimatePushHumanEventType,
  EstimatePushWorkflowSnapshot
>({
  name: ESTIMATE_PUSH_WORKFLOW_NAME,
  schemaVersion: ESTIMATE_PUSH_WORKFLOW_SCHEMA_VERSION,
  initialState: 'drafted',
  terminalStates: ESTIMATE_PUSH_TERMINAL_STATES,
  allStates: ESTIMATE_PUSH_ALL_STATES,
  allEventTypes: ESTIMATE_PUSH_EVENT_TYPES,
  reduce: transitionEstimatePushWorkflow,
  nextEvents: nextEstimatePushEvents,
  isHumanEvent: isHumanEstimatePushEvent,
  sideEffectTypes: ['post_qbo_estimate'] as const,
})

export const EstimatePushEventRequestSchema = z.object({
  event: z.enum(['REVIEW', 'APPROVE', 'POST_REQUESTED', 'RETRY_POST', 'VOID']),
  state_version: z.number().int().positive(),
})

export type EstimatePushEventRequest = z.infer<typeof EstimatePushEventRequestSchema>
export type EstimatePushEventParseResult =
  | { ok: true; value: EstimatePushEventRequest }
  | { ok: false; error: string }

export function parseEstimatePushEventRequest(body: unknown): EstimatePushEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = EstimatePushEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
