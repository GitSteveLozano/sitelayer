import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Damage / loss / late-return / cleanup charge settlement workflow.
 *
 * Lifts the implicit state machine in `damage_charges.status`
 * (open → invoiced | waived) into a registered deterministic workflow
 * so the replay sweep covers it and the audit trail flows through
 * workflow_event_log alongside the other workflows in the package.
 *
 * The existing damage-charge-push worker continues to drive the QBO
 * invoice creation in parallel — this reducer doesn't enqueue
 * mutation_outbox rows for the QBO push itself. The route layer (which
 * already enqueues a `damage_charge_invoice_push` outbox row with a
 * stable idempotency key) is the side-effect channel; the reducer
 * provides only the state-change discipline and the workflow_event_log
 * trail.
 *
 * States:
 *   open       — charge created, awaiting decision
 *   invoiced   — operator invoiced the customer (terminal)
 *   waived     — operator wrote the charge off (terminal)
 *
 * Events:
 *   INVOICE  { invoiced_at, invoiced_by }
 *            open → invoiced. Stamps invoiced_at / invoiced_by.
 *   WAIVE    { waived_at, waived_by, waive_reason? }
 *            open → waived. Stamps waived_at / waived_by / waive_reason.
 *
 * Side effects: none. The route enqueues the existing
 * `damage_charge_invoice_push` outbox row separately on INVOICE.
 */

export type DamageChargeSettlementWorkflowState = 'open' | 'invoiced' | 'waived'

export const DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_NAME = 'damage_charge_settlement'
export const DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_SCHEMA_VERSION = 1
export const DAMAGE_CHARGE_SETTLEMENT_ALL_STATES: readonly DamageChargeSettlementWorkflowState[] = [
  'open',
  'invoiced',
  'waived',
]
export const DAMAGE_CHARGE_SETTLEMENT_TERMINAL_STATES: readonly DamageChargeSettlementWorkflowState[] = [
  'invoiced',
  'waived',
]
export const DAMAGE_CHARGE_SETTLEMENT_EVENT_TYPES = ['INVOICE', 'WAIVE'] as const

export type DamageChargeSettlementHumanEventType = (typeof DAMAGE_CHARGE_SETTLEMENT_EVENT_TYPES)[number]

export type DamageChargeSettlementWorkflowEvent =
  | { type: 'INVOICE'; invoiced_at: string; invoiced_by: string }
  | { type: 'WAIVE'; waived_at: string; waived_by: string; waive_reason?: string | null }

export interface DamageChargeSettlementWorkflowSnapshot {
  state: DamageChargeSettlementWorkflowState
  state_version: number
  invoiced_at?: string | null
  invoiced_by?: string | null
  waived_at?: string | null
  waived_by?: string | null
  waive_reason?: string | null
}

function assertTransition(
  state: DamageChargeSettlementWorkflowState,
  allowed: readonly DamageChargeSettlementWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`damage_charge_settlement: illegal transition from ${state} on ${eventType}`)
  }
}

export function transitionDamageChargeSettlementWorkflow(
  snapshot: DamageChargeSettlementWorkflowSnapshot,
  event: DamageChargeSettlementWorkflowEvent,
): DamageChargeSettlementWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'INVOICE') {
    assertTransition(snapshot.state, ['open'], event.type)
    return {
      ...snapshot,
      state: 'invoiced',
      state_version: nextVersion,
      invoiced_at: event.invoiced_at,
      invoiced_by: event.invoiced_by,
    }
  }
  if (event.type === 'WAIVE') {
    assertTransition(snapshot.state, ['open'], event.type)
    return {
      ...snapshot,
      state: 'waived',
      state_version: nextVersion,
      waived_at: event.waived_at,
      waived_by: event.waived_by,
      waive_reason: event.waive_reason ?? null,
    }
  }
  // Exhaustive — TS will surface omissions here.
  const exhaustive: never = event
  throw new Error(`unhandled damage_charge_settlement event ${JSON.stringify(exhaustive)}`)
}

export function nextDamageChargeSettlementEvents(
  state: DamageChargeSettlementWorkflowState,
): Array<WorkflowNextEvent<DamageChargeSettlementHumanEventType>> {
  switch (state) {
    case 'open':
      return [
        { type: 'INVOICE', label: 'Invoice charge' },
        { type: 'WAIVE', label: 'Waive charge' },
      ]
    case 'invoiced':
    case 'waived':
      return []
  }
}

export function isHumanDamageChargeSettlementEvent(
  eventType: string,
): eventType is DamageChargeSettlementHumanEventType {
  return eventType === 'INVOICE' || eventType === 'WAIVE'
}

export const damageChargeSettlementWorkflow = registerWorkflow<
  DamageChargeSettlementWorkflowState,
  DamageChargeSettlementWorkflowEvent,
  DamageChargeSettlementHumanEventType,
  DamageChargeSettlementWorkflowSnapshot
>({
  name: DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_NAME,
  schemaVersion: DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_SCHEMA_VERSION,
  initialState: 'open',
  terminalStates: DAMAGE_CHARGE_SETTLEMENT_TERMINAL_STATES,
  allStates: DAMAGE_CHARGE_SETTLEMENT_ALL_STATES,
  allEventTypes: DAMAGE_CHARGE_SETTLEMENT_EVENT_TYPES,
  reduce: transitionDamageChargeSettlementWorkflow,
  nextEvents: nextDamageChargeSettlementEvents,
  isHumanEvent: isHumanDamageChargeSettlementEvent,
  sideEffectTypes: [] as const,
})

export const DamageChargeSettlementEventRequestSchema = z.object({
  event: z.enum(DAMAGE_CHARGE_SETTLEMENT_EVENT_TYPES),
  state_version: z.number().int().positive(),
  waive_reason: z.string().max(2000).optional().nullable(),
})

export type DamageChargeSettlementEventRequest = z.infer<typeof DamageChargeSettlementEventRequestSchema>
export type DamageChargeSettlementEventParseResult =
  | { ok: true; value: DamageChargeSettlementEventRequest }
  | { ok: false; error: string }

export function parseDamageChargeSettlementEventRequest(body: unknown): DamageChargeSettlementEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = DamageChargeSettlementEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
