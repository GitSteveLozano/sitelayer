import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Change-order workflow — a post-contract scope addendum (097_change_orders.sql).
 *
 * Surfaced by Steve's v2 design (workflow 07 · Project Lifecycle → CHANGE
 * ORDER · NEW/SENT/ACCEPTED). A CO is authored as a `draft`, SENT to the
 * client, and then ACCEPTED (client signs) or REJECTED. VOID discards a draft
 * or an un-signed sent CO. Accepted COs are what the project's effective value
 * rollup sums (bid_total + Σ accepted value_delta) — the reducer does NOT touch
 * the project; the route reads accepted COs when computing effective value.
 *
 * States:
 *   draft     authored, not yet sent to the client
 *   sent      awaiting the client's signature
 *   accepted  client signed — terminal
 *   rejected  client declined — terminal
 *   voided    withdrawn before signature — terminal
 *
 * Events (all human — there are no worker-only transitions):
 *   SEND    draft → sent          {actor_user_id, occurred_at}
 *   ACCEPT  sent → accepted       {actor_user_id, occurred_at}
 *   REJECT  sent → rejected       {actor_user_id, occurred_at, reason?}
 *   VOID    draft|sent → voided   {actor_user_id, occurred_at}
 */

export type ChangeOrderWorkflowState = 'draft' | 'sent' | 'accepted' | 'rejected' | 'voided'

export const CHANGE_ORDER_WORKFLOW_NAME = 'change_order'
export const CHANGE_ORDER_WORKFLOW_SCHEMA_VERSION = 1
export const CHANGE_ORDER_ALL_STATES: readonly ChangeOrderWorkflowState[] = [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'voided',
]
export const CHANGE_ORDER_TERMINAL_STATES: readonly ChangeOrderWorkflowState[] = ['accepted', 'rejected', 'voided']
export const CHANGE_ORDER_EVENT_TYPES = ['SEND', 'ACCEPT', 'REJECT', 'VOID'] as const

export type ChangeOrderHumanEventType = 'SEND' | 'ACCEPT' | 'REJECT' | 'VOID'

export type ChangeOrderWorkflowEvent =
  | { type: 'SEND'; occurred_at: string; actor_user_id?: string | null }
  | { type: 'ACCEPT'; occurred_at: string; actor_user_id?: string | null }
  | { type: 'REJECT'; occurred_at: string; actor_user_id?: string | null; reason?: string | null }
  | { type: 'VOID'; occurred_at: string; actor_user_id?: string | null }

export interface ChangeOrderWorkflowSnapshot {
  state: ChangeOrderWorkflowState
  state_version: number
  sent_at?: string | null
  accepted_at?: string | null
  rejected_at?: string | null
  voided_at?: string | null
  reject_reason?: string | null
  approved_by?: string | null
}

function assertTransition(
  state: ChangeOrderWorkflowState,
  allowed: readonly ChangeOrderWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`change_order: illegal transition from ${state} on ${eventType}`)
  }
}

export function transitionChangeOrderWorkflow(
  snapshot: ChangeOrderWorkflowSnapshot,
  event: ChangeOrderWorkflowEvent,
): ChangeOrderWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'SEND') {
    assertTransition(snapshot.state, ['draft'], event.type)
    return { ...snapshot, state: 'sent', state_version: nextVersion, sent_at: event.occurred_at }
  }
  if (event.type === 'ACCEPT') {
    assertTransition(snapshot.state, ['sent'], event.type)
    return {
      ...snapshot,
      state: 'accepted',
      state_version: nextVersion,
      accepted_at: event.occurred_at,
      approved_by: event.actor_user_id ?? snapshot.approved_by ?? null,
    }
  }
  if (event.type === 'REJECT') {
    assertTransition(snapshot.state, ['sent'], event.type)
    return {
      ...snapshot,
      state: 'rejected',
      state_version: nextVersion,
      rejected_at: event.occurred_at,
      reject_reason: event.reason ?? snapshot.reject_reason ?? null,
    }
  }
  if (event.type === 'VOID') {
    assertTransition(snapshot.state, ['draft', 'sent'], event.type)
    return { ...snapshot, state: 'voided', state_version: nextVersion, voided_at: event.occurred_at }
  }
  const exhaustive: never = event
  throw new Error(`unhandled change_order event ${JSON.stringify(exhaustive)}`)
}

export function nextChangeOrderEvents(
  state: ChangeOrderWorkflowState,
): Array<WorkflowNextEvent<ChangeOrderHumanEventType>> {
  switch (state) {
    case 'draft':
      return [
        { type: 'SEND', label: 'Send to client' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'sent':
      return [
        { type: 'ACCEPT', label: 'Mark accepted' },
        { type: 'REJECT', label: 'Mark rejected' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'accepted':
    case 'rejected':
    case 'voided':
      return []
  }
}

export function isHumanChangeOrderEvent(eventType: string): eventType is ChangeOrderHumanEventType {
  return eventType === 'SEND' || eventType === 'ACCEPT' || eventType === 'REJECT' || eventType === 'VOID'
}

export const changeOrderWorkflow = registerWorkflow<
  ChangeOrderWorkflowState,
  ChangeOrderWorkflowEvent,
  ChangeOrderHumanEventType,
  ChangeOrderWorkflowSnapshot
>({
  name: CHANGE_ORDER_WORKFLOW_NAME,
  schemaVersion: CHANGE_ORDER_WORKFLOW_SCHEMA_VERSION,
  initialState: 'draft',
  terminalStates: CHANGE_ORDER_TERMINAL_STATES,
  allStates: CHANGE_ORDER_ALL_STATES,
  allEventTypes: CHANGE_ORDER_EVENT_TYPES,
  reduce: transitionChangeOrderWorkflow,
  nextEvents: nextChangeOrderEvents,
  isHumanEvent: isHumanChangeOrderEvent,
  // No external side effects: a CO never pushes to QBO directly. Its accepted
  // value rolls into the project's effective contract value at read time.
  sideEffectTypes: [] as const,
})

// Human-facing event endpoint. All four events are human; the schema exists
// for parity with the other workflows and to validate the request body.
export const ChangeOrderEventRequestSchema = z.object({
  event: z.enum(['SEND', 'ACCEPT', 'REJECT', 'VOID']),
  state_version: z.number().int().positive(),
  reason: z.string().max(2000).optional(),
})

export type ChangeOrderEventRequest = z.infer<typeof ChangeOrderEventRequestSchema>
export type ChangeOrderEventParseResult =
  | { ok: true; value: ChangeOrderEventRequest }
  | { ok: false; error: string }

export function parseChangeOrderEventRequest(body: unknown): ChangeOrderEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = ChangeOrderEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
