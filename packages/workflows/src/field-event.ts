import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Field-event escalation workflow — seventh deterministic workflow.
 *
 * Backs the worker "Flag a problem" → foreman triage → estimator
 * escalation flow from Sitemap §11. A `worker_issues` row enters as
 * `open`; the foreman either resolves it (with an action + a message
 * back to the worker), escalates it to the estimator queue, or
 * dismisses it. A resolved/escalated/dismissed ticket can be reopened
 * if the worker pings again about the same root cause.
 *
 * States:
 *   open        — worker filed it; foreman hasn't acted yet
 *   resolved    — foreman cleared it with an action and a reply
 *   escalated   — foreman bumped it to the estimator queue
 *   dismissed   — foreman flagged it as not actionable (duplicate,
 *                 false alarm). Distinct from resolved because no
 *                 action was taken and no message was sent back.
 *
 * Events:
 *   RESOLVE   { resolved_at, resolved_by_user_id, action, message_to_worker }
 *             open → resolved. Captures the foreman's chosen action
 *             ('order_more' | 'bring_from_site' | 'use_what_we_have' |
 *             'park' | 'change_order') and the reply text the worker
 *             will see. Emits `notify_worker_resolution` side effect.
 *   ESCALATE  { escalated_at, escalator_user_id, reason }
 *             open → escalated. Bumps to the estimator queue and
 *             emits `notify_estimator_escalation` side effect. Reason
 *             is required so the estimator has context.
 *   DISMISS   { dismissed_at, dismissed_by_user_id }
 *             open → dismissed. No worker notification, no estimator
 *             notification — the row stays as the audit trail.
 *   REOPEN    { reopened_at, reopener_user_id }
 *             resolved | escalated | dismissed → open. Audit trail
 *             survives in workflow_event_log; the row's
 *             resolved_action / resolution_message / escalation_*
 *             fields are cleared so the constraint shape on `open`
 *             stays consistent with a freshly-filed ticket.
 *
 * REOPEN keeps the workflow non-terminal. A repeated ping about the
 * same materials shortage doesn't need a new ticket — the foreman can
 * reopen the prior one and the conversation thread stays intact.
 *
 * Side effects:
 *   notify_worker_resolution    — RESOLVE only. Worker drains the
 *                                 outbox and inserts a `notifications`
 *                                 row addressed to the worker's clerk
 *                                 user id with the message_to_worker
 *                                 body.
 *   notify_estimator_escalation — ESCALATE only. Worker drains and
 *                                 fans out to estimator-role members
 *                                 of the company.
 *
 * AUTO-ESCALATION TODO (integration point):
 * When `severity='stopped'` and the ticket is older than 15 minutes
 * without a RESOLVE landing, an automated ESCALATE should fire so the
 * estimator queue is the safety net for crews that are blocked.
 *
 * Implementation plan (follow-up slice, not this one):
 *   1. A periodic task `field_event_escalation_check` claims open
 *      worker_issues rows where severity='stopped' AND
 *      created_at < now() - interval '15 minutes' AND
 *      escalated_to_estimator_at is null.
 *   2. For each row, the worker constructs an ESCALATE event with
 *      reason='auto_15min_stopped' and the system actor id, runs it
 *      through `transitionFieldEventWorkflow`, and persists the
 *      transition through the same PATCH path the foreman uses (so
 *      the workflow_event_log row carries the full trail).
 *   3. The route guard already enforces state_version, so a foreman
 *      RESOLVE that races the auto-escalator wins or loses cleanly
 *      via the usual 409 path — no special-casing in the reducer.
 *
 * The reducer is intentionally identical for human and automated
 * ESCALATE events; the only difference is the actor id on the event
 * payload. That keeps replay deterministic regardless of trigger.
 */

export type FieldEventWorkflowState = 'open' | 'resolved' | 'escalated' | 'dismissed'

export const FIELD_EVENT_WORKFLOW_NAME = 'field_event'
export const FIELD_EVENT_WORKFLOW_SCHEMA_VERSION = 1
export const FIELD_EVENT_ALL_STATES: readonly FieldEventWorkflowState[] = [
  'open',
  'resolved',
  'escalated',
  'dismissed',
]
// REOPEN escapes any non-open state, so nothing is truly terminal.
export const FIELD_EVENT_TERMINAL_STATES: readonly FieldEventWorkflowState[] = []
export const FIELD_EVENT_EVENT_TYPES = ['RESOLVE', 'ESCALATE', 'DISMISS', 'REOPEN'] as const

export const FIELD_EVENT_RESOLUTION_ACTIONS = [
  'order_more',
  'bring_from_site',
  'use_what_we_have',
  'park',
  'change_order',
] as const
export type FieldEventResolutionAction = (typeof FIELD_EVENT_RESOLUTION_ACTIONS)[number]

export type FieldEventWorkflowEvent =
  | {
      type: 'RESOLVE'
      resolved_at: string
      resolved_by_user_id: string
      action: FieldEventResolutionAction
      message_to_worker: string
    }
  | { type: 'ESCALATE'; escalated_at: string; escalator_user_id: string; reason: string }
  | { type: 'DISMISS'; dismissed_at: string; dismissed_by_user_id: string }
  | { type: 'REOPEN'; reopened_at: string; reopener_user_id: string }

export interface FieldEventWorkflowSnapshot {
  state: FieldEventWorkflowState
  state_version: number
  /** RESOLVE / ESCALATE / DISMISS all stamp this so the audit trail
   *  shows who last acted on the ticket regardless of outcome. */
  last_actor_user_id?: string | null
  resolved_at?: string | null
  resolved_by_user_id?: string | null
  resolved_action?: FieldEventResolutionAction | null
  resolution_message?: string | null
  escalated_to_estimator_at?: string | null
  escalation_reason?: string | null
  dismissed_at?: string | null
  dismissed_by_user_id?: string | null
  reopened_at?: string | null
}

function assertFieldEventTransition(
  state: FieldEventWorkflowState,
  allowed: readonly FieldEventWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from field event state ${state}`)
  }
}

/**
 * Pure transition reducer for field-event escalation. No wall-clock
 * reads, no random ids, no IO — same contract as every other reducer
 * in this package. The same transition table services the API
 * handler, the XState machine, and the future Temporal worker.
 *
 * Field-clear semantics on REOPEN: every per-state column written by
 * RESOLVE / ESCALATE / DISMISS is set back to null so a re-opened row
 * looks identical to a freshly-filed one. Migration 049 doesn't add a
 * CHECK constraint that would force this (it's all nullable), but
 * keeping the reducer disciplined means the row's audit shape stays
 * predictable when it's re-resolved against a different action.
 */
export function transitionFieldEventWorkflow(
  snapshot: FieldEventWorkflowSnapshot,
  event: FieldEventWorkflowEvent,
): FieldEventWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'RESOLVE') {
    assertFieldEventTransition(snapshot.state, ['open'], event.type)
    return {
      ...snapshot,
      state: 'resolved',
      state_version: nextVersion,
      last_actor_user_id: event.resolved_by_user_id,
      resolved_at: event.resolved_at,
      resolved_by_user_id: event.resolved_by_user_id,
      resolved_action: event.action,
      resolution_message: event.message_to_worker,
      // Clear any prior escalation/dismiss trail in case this row was
      // reopened from one of those states and is now landing as a
      // proper resolution. Without these clears the persisted UPDATE
      // would leave stale escalation_to_estimator_at on a row whose
      // state is 'resolved', which would mis-display in the inbox.
      escalated_to_estimator_at: null,
      escalation_reason: null,
      dismissed_at: null,
      dismissed_by_user_id: null,
    }
  }
  if (event.type === 'ESCALATE') {
    assertFieldEventTransition(snapshot.state, ['open'], event.type)
    return {
      ...snapshot,
      state: 'escalated',
      state_version: nextVersion,
      last_actor_user_id: event.escalator_user_id,
      escalated_to_estimator_at: event.escalated_at,
      escalation_reason: event.reason,
      // Mirror the RESOLVE clears: a row that was previously resolved
      // and got reopened shouldn't carry its prior resolved_action /
      // resolution_message into an escalation surface where they'd be
      // confusing.
      resolved_at: null,
      resolved_by_user_id: null,
      resolved_action: null,
      resolution_message: null,
      dismissed_at: null,
      dismissed_by_user_id: null,
    }
  }
  if (event.type === 'DISMISS') {
    assertFieldEventTransition(snapshot.state, ['open'], event.type)
    return {
      ...snapshot,
      state: 'dismissed',
      state_version: nextVersion,
      last_actor_user_id: event.dismissed_by_user_id,
      dismissed_at: event.dismissed_at,
      dismissed_by_user_id: event.dismissed_by_user_id,
      // Same housekeeping as ESCALATE/RESOLVE.
      resolved_at: null,
      resolved_by_user_id: null,
      resolved_action: null,
      resolution_message: null,
      escalated_to_estimator_at: null,
      escalation_reason: null,
    }
  }
  // REOPEN: any non-open state can re-enter `open`. Clear every per-
  // state column so the row's shape matches a freshly-filed ticket.
  assertFieldEventTransition(snapshot.state, ['resolved', 'escalated', 'dismissed'], event.type)
  return {
    ...snapshot,
    state: 'open',
    state_version: nextVersion,
    last_actor_user_id: event.reopener_user_id,
    reopened_at: event.reopened_at,
    resolved_at: null,
    resolved_by_user_id: null,
    resolved_action: null,
    resolution_message: null,
    escalated_to_estimator_at: null,
    escalation_reason: null,
    dismissed_at: null,
    dismissed_by_user_id: null,
  }
}

export type FieldEventHumanEventType = 'RESOLVE' | 'ESCALATE' | 'DISMISS' | 'REOPEN'

export function nextFieldEventEvents(
  state: FieldEventWorkflowState,
): Array<WorkflowNextEvent<FieldEventHumanEventType>> {
  switch (state) {
    case 'open':
      return [
        { type: 'RESOLVE', label: 'Resolve and reply to worker' },
        { type: 'ESCALATE', label: 'Escalate to estimator' },
        { type: 'DISMISS', label: 'Dismiss' },
      ]
    case 'resolved':
    case 'escalated':
    case 'dismissed':
      return [{ type: 'REOPEN', label: 'Reopen' }]
  }
}

export function isHumanFieldEventEvent(eventType: string): eventType is FieldEventHumanEventType {
  return (
    eventType === 'RESOLVE' || eventType === 'ESCALATE' || eventType === 'DISMISS' || eventType === 'REOPEN'
  )
}

export const fieldEventWorkflow = registerWorkflow<
  FieldEventWorkflowState,
  FieldEventWorkflowEvent,
  FieldEventHumanEventType,
  FieldEventWorkflowSnapshot
>({
  name: FIELD_EVENT_WORKFLOW_NAME,
  schemaVersion: FIELD_EVENT_WORKFLOW_SCHEMA_VERSION,
  initialState: 'open',
  terminalStates: FIELD_EVENT_TERMINAL_STATES,
  allStates: FIELD_EVENT_ALL_STATES,
  allEventTypes: FIELD_EVENT_EVENT_TYPES,
  reduce: transitionFieldEventWorkflow,
  nextEvents: nextFieldEventEvents,
  isHumanEvent: isHumanFieldEventEvent,
  // Worker drains these mutation_types from mutation_outbox. RESOLVE
  // emits notify_worker_resolution; ESCALATE emits
  // notify_estimator_escalation. DISMISS and REOPEN emit nothing.
  sideEffectTypes: ['notify_worker_resolution', 'notify_estimator_escalation'] as const,
})

// Wire-format request schema for PATCH /api/worker-issues/:id.
//
// Mirrors the rental-billing / time-review convention:
//   { event, state_version, ... }
// Per-event fields are required:
//   RESOLVE  → action + message_to_worker
//   ESCALATE → reason
//   DISMISS  → no extra fields
//   REOPEN   → no extra fields
//
// All event payloads are validated through this single discriminated
// union so the route handler never sees an under-validated body.

const ResolveBodySchema = z.object({
  event: z.literal('RESOLVE'),
  state_version: z.number().int().positive(),
  action: z.enum(FIELD_EVENT_RESOLUTION_ACTIONS),
  message_to_worker: z.string().min(1).max(4000),
})

const EscalateBodySchema = z.object({
  event: z.literal('ESCALATE'),
  state_version: z.number().int().positive(),
  reason: z.string().min(1).max(2000),
})

const DismissBodySchema = z.object({
  event: z.literal('DISMISS'),
  state_version: z.number().int().positive(),
})

const ReopenBodySchema = z.object({
  event: z.literal('REOPEN'),
  state_version: z.number().int().positive(),
})

export const FieldEventEventRequestSchema = z.discriminatedUnion('event', [
  ResolveBodySchema,
  EscalateBodySchema,
  DismissBodySchema,
  ReopenBodySchema,
])

export type FieldEventEventRequest = z.infer<typeof FieldEventEventRequestSchema>

export type FieldEventEventParseResult =
  | { ok: true; value: FieldEventEventRequest }
  | { ok: false; error: string }

export function parseFieldEventEventRequest(body: unknown): FieldEventEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = FieldEventEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
