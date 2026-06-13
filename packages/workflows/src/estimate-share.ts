import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Estimate-share workflow — the client-facing send→accept/decline
 * lifecycle for a frozen estimate. A sibling loop of `estimate_push`
 * (which pushes to QuickBooks), NOT a phase of it: disjoint states,
 * disjoint side-effects (`send_estimate_share` notification vs
 * `post_qbo_estimate`), and a different actor mix — the *client* drives
 * VIEW/ACCEPT/DECLINE through the unauthenticated portal, the estimator
 * drives REVOKE, and a sweep emits EXPIRE.
 *
 * Modeled on estimate-push.ts + field-event.ts. Following the codebase
 * precedent (estimate_push starts `drafted`, field_event starts `open`,
 * shipment starts `planned`), the row is CREATED directly in the initial
 * state `sent` by the create endpoint — the "SEND" compose step is the
 * row-creation seed (recorded by the create route + enqueues the
 * `send_estimate_share` outbox row), not a reducer transition. The
 * reducer's events are the forward transitions out of `sent`/`viewed`.
 *
 * The reducer is PURE: no clock reads, random ids, network, or DB. The
 * clock value for each transition (`viewed_at`, `accepted_at`, …) is
 * supplied as event PAYLOAD by the caller (route/sweep), so a worker
 * expiry sweep passes its own `expired_at` and the reducer never calls
 * Date.now().
 */

export type EstimateShareWorkflowState = 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'revoked'

export const ESTIMATE_SHARE_WORKFLOW_NAME = 'estimate_share'
export const ESTIMATE_SHARE_WORKFLOW_SCHEMA_VERSION = 1
export const ESTIMATE_SHARE_ALL_STATES: readonly EstimateShareWorkflowState[] = [
  'sent',
  'viewed',
  'accepted',
  'declined',
  'expired',
  'revoked',
]
export const ESTIMATE_SHARE_TERMINAL_STATES: readonly EstimateShareWorkflowState[] = [
  'accepted',
  'declined',
  'expired',
  'revoked',
]
export const ESTIMATE_SHARE_EVENT_TYPES = ['VIEW', 'ACCEPT', 'DECLINE', 'EXPIRE', 'REVOKE'] as const

export type EstimateShareWorkflowEvent =
  | { type: 'VIEW'; viewed_at: string }
  | {
      type: 'ACCEPT'
      accepted_at: string
      signer_name: string
      signature_data_url?: string | null
      signer_ip?: string | null
    }
  | { type: 'DECLINE'; declined_at: string; decline_reason?: string | null }
  | { type: 'EXPIRE'; expired_at: string }
  | { type: 'REVOKE'; revoked_at: string; revoked_by: string }

export interface EstimateShareWorkflowSnapshot {
  state: EstimateShareWorkflowState
  state_version: number
  recipient_email?: string | null
  recipient_name?: string | null
  message?: string | null
  include_signed_link?: boolean | null
  sent_at?: string | null
  expires_at?: string | null
  viewed_at?: string | null
  view_count?: number | null
  accepted_at?: string | null
  signer_name?: string | null
  declined_at?: string | null
  decline_reason?: string | null
  revoked_at?: string | null
}

function assertEstimateShareTransition(
  state: EstimateShareWorkflowState,
  allowed: readonly EstimateShareWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from estimate share state ${state}`)
  }
}

/**
 * Pure transition reducer. No clock reads, random ids, network calls, or
 * DB access. Same shape as transitionEstimatePushWorkflow.
 */
export function transitionEstimateShareWorkflow(
  snapshot: EstimateShareWorkflowSnapshot,
  event: EstimateShareWorkflowEvent,
): EstimateShareWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'VIEW') {
    // First view transitions sent→viewed and stamps viewed_at + view_count.
    // A re-VIEW from `viewed` is idempotent: bump the count, keep state,
    // preserve the first viewed_at.
    assertEstimateShareTransition(snapshot.state, ['sent', 'viewed'], event.type)
    return {
      ...snapshot,
      state: 'viewed',
      state_version: nextVersion,
      viewed_at: snapshot.viewed_at ?? event.viewed_at,
      view_count: (snapshot.view_count ?? 0) + 1,
    }
  }
  if (event.type === 'ACCEPT') {
    assertEstimateShareTransition(snapshot.state, ['sent', 'viewed'], event.type)
    return {
      ...snapshot,
      state: 'accepted',
      state_version: nextVersion,
      accepted_at: event.accepted_at,
      signer_name: event.signer_name,
    }
  }
  if (event.type === 'DECLINE') {
    assertEstimateShareTransition(snapshot.state, ['sent', 'viewed'], event.type)
    return {
      ...snapshot,
      state: 'declined',
      state_version: nextVersion,
      declined_at: event.declined_at,
      decline_reason: event.decline_reason ?? null,
    }
  }
  if (event.type === 'EXPIRE') {
    assertEstimateShareTransition(snapshot.state, ['sent', 'viewed'], event.type)
    return {
      ...snapshot,
      state: 'expired',
      state_version: nextVersion,
    }
  }
  if (event.type === 'REVOKE') {
    // REVOKE — estimator-initiated invalidation from any non-terminal state.
    assertEstimateShareTransition(snapshot.state, ['sent', 'viewed'], event.type)
    return {
      ...snapshot,
      state: 'revoked',
      state_version: nextVersion,
      revoked_at: event.revoked_at,
    }
  }
  // Exhaustiveness guard: every member of EstimateShareWorkflowEvent is handled
  // above, so `event` narrows to `never`. A new event type without a branch is a
  // compile error — it can no longer silently misroute into the old REVOKE
  // catch-all.
  const exhaustive: never = event
  throw new Error(`unhandled estimate_share event ${JSON.stringify(exhaustive)}`)
}

export type EstimateShareHumanEventType = 'REVOKE'

/**
 * Only REVOKE is surfaced to the estimator UI. VIEW/ACCEPT/DECLINE are
 * client-only (driven by the unauthenticated portal endpoints) and
 * EXPIRE is worker-only (an expiry sweep), so none of them appear in the
 * estimator-facing next_events. The portal renders ACCEPT/DECLINE from
 * its own client-facing snapshot.
 */
export function nextEstimateShareEvents(
  state: EstimateShareWorkflowState,
): Array<WorkflowNextEvent<EstimateShareHumanEventType>> {
  switch (state) {
    case 'sent':
    case 'viewed':
      return [{ type: 'REVOKE', label: 'Revoke share' }]
    case 'accepted':
    case 'declined':
    case 'expired':
    case 'revoked':
      return []
  }
}

export function isHumanEstimateShareEvent(eventType: string): eventType is EstimateShareHumanEventType {
  return eventType === 'REVOKE'
}

export const estimateShareWorkflow = registerWorkflow<
  EstimateShareWorkflowState,
  EstimateShareWorkflowEvent,
  EstimateShareHumanEventType,
  EstimateShareWorkflowSnapshot
>({
  name: ESTIMATE_SHARE_WORKFLOW_NAME,
  schemaVersion: ESTIMATE_SHARE_WORKFLOW_SCHEMA_VERSION,
  initialState: 'sent',
  terminalStates: ESTIMATE_SHARE_TERMINAL_STATES,
  allStates: ESTIMATE_SHARE_ALL_STATES,
  allEventTypes: ESTIMATE_SHARE_EVENT_TYPES,
  reduce: transitionEstimateShareWorkflow,
  nextEvents: nextEstimateShareEvents,
  isHumanEvent: isHumanEstimateShareEvent,
  sideEffectTypes: ['send_estimate_share'] as const,
})

/**
 * The authenticated `/events` endpoint only accepts REVOKE — the only
 * estimator-driven human event. VIEW/ACCEPT/DECLINE arrive through the
 * unauthenticated portal endpoints (their own request schemas); EXPIRE
 * is worker-only.
 */
export const EstimateShareEventRequestSchema = z.object({
  event: z.enum(['REVOKE']),
  state_version: z.number().int().positive(),
})

export type EstimateShareEventRequest = z.infer<typeof EstimateShareEventRequestSchema>
export type EstimateShareEventParseResult =
  | { ok: true; value: EstimateShareEventRequest }
  | { ok: false; error: string }

export function parseEstimateShareEventRequest(body: unknown): EstimateShareEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = EstimateShareEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
