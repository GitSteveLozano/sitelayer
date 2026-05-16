import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Shipment workflow — pure reducer.
 *
 * Outbound: planned → picking → shipped → delivered → closed
 * Returns: shipping back is modeled by direction='return' on the same
 * row; status goes planned → picking → shipped → delivered → closed for
 * a return as well, with the lines accumulating returned/damaged/lost
 * quantities at delivery.
 *
 * VOID is allowed at any non-terminal state. POST_DELIVERED is the
 * mobile-driven "confirm delivery" event; the worker emits no async
 * events here today (cf. damage/loss billing which enqueues outbox rows
 * separately).
 */

export type ShipmentWorkflowState =
  | 'planned'
  | 'picking'
  | 'shipped'
  | 'delivered'
  | 'returning'
  | 'closed'
  | 'voided'

export const SHIPMENT_WORKFLOW_NAME = 'shipment'
export const SHIPMENT_WORKFLOW_SCHEMA_VERSION = 1
export const SHIPMENT_ALL_STATES: readonly ShipmentWorkflowState[] = [
  'planned',
  'picking',
  'shipped',
  'delivered',
  'returning',
  'closed',
  'voided',
]
export const SHIPMENT_TERMINAL_STATES: readonly ShipmentWorkflowState[] = ['closed', 'voided']

export const SHIPMENT_EVENT_TYPES = [
  'START_PICKING',
  'SHIP',
  'CONFIRM_DELIVERY',
  'OPEN_RETURN',
  'CLOSE',
  'VOID',
] as const

export type ShipmentHumanEventType = (typeof SHIPMENT_EVENT_TYPES)[number]

export type ShipmentWorkflowEvent =
  | { type: 'START_PICKING' }
  | { type: 'SHIP'; shipped_at: string; driver?: string; ticket_number?: string }
  | { type: 'CONFIRM_DELIVERY'; delivered_at: string; confirmed_by: string }
  | { type: 'OPEN_RETURN' }
  | { type: 'CLOSE'; confirmed_by: string }
  | { type: 'VOID' }

export interface ShipmentWorkflowSnapshot {
  state: ShipmentWorkflowState
  state_version: number
  scheduled_for?: string | null
  shipped_at?: string | null
  delivered_at?: string | null
  confirmed_by?: string | null
  driver?: string | null
  ticket_number?: string | null
}

function assertTransition(
  state: ShipmentWorkflowState,
  allowed: readonly ShipmentWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`shipment: illegal transition from ${state} on ${eventType}`)
  }
}

export function transitionShipmentWorkflow(
  snapshot: ShipmentWorkflowSnapshot,
  event: ShipmentWorkflowEvent,
): ShipmentWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  switch (event.type) {
    case 'START_PICKING':
      assertTransition(snapshot.state, ['planned'], event.type)
      return { ...snapshot, state: 'picking', state_version: nextVersion }
    case 'SHIP':
      assertTransition(snapshot.state, ['picking', 'planned'], event.type)
      return {
        ...snapshot,
        state: 'shipped',
        state_version: nextVersion,
        shipped_at: event.shipped_at,
        driver: event.driver ?? snapshot.driver ?? null,
        ticket_number: event.ticket_number ?? snapshot.ticket_number ?? null,
      }
    case 'CONFIRM_DELIVERY':
      assertTransition(snapshot.state, ['shipped'], event.type)
      return {
        ...snapshot,
        state: 'delivered',
        state_version: nextVersion,
        delivered_at: event.delivered_at,
        confirmed_by: event.confirmed_by,
      }
    case 'OPEN_RETURN':
      assertTransition(snapshot.state, ['delivered'], event.type)
      return { ...snapshot, state: 'returning', state_version: nextVersion }
    case 'CLOSE':
      assertTransition(snapshot.state, ['delivered', 'returning'], event.type)
      return {
        ...snapshot,
        state: 'closed',
        state_version: nextVersion,
        confirmed_by: event.confirmed_by ?? snapshot.confirmed_by ?? null,
      }
    case 'VOID':
      assertTransition(
        snapshot.state,
        ['planned', 'picking', 'shipped', 'delivered', 'returning'],
        event.type,
      )
      return { ...snapshot, state: 'voided', state_version: nextVersion }
  }
}

export function nextShipmentEvents(
  state: ShipmentWorkflowState,
): Array<WorkflowNextEvent<ShipmentHumanEventType>> {
  switch (state) {
    case 'planned':
      return [
        { type: 'START_PICKING', label: 'Start picking' },
        { type: 'SHIP', label: 'Mark shipped' },
        { type: 'VOID', label: 'Void shipment' },
      ]
    case 'picking':
      return [
        { type: 'SHIP', label: 'Mark shipped' },
        { type: 'VOID', label: 'Void shipment' },
      ]
    case 'shipped':
      return [
        { type: 'CONFIRM_DELIVERY', label: 'Confirm delivery' },
        { type: 'VOID', label: 'Void shipment' },
      ]
    case 'delivered':
      return [
        { type: 'OPEN_RETURN', label: 'Open return' },
        { type: 'CLOSE', label: 'Close shipment' },
        { type: 'VOID', label: 'Void shipment' },
      ]
    case 'returning':
      return [
        { type: 'CLOSE', label: 'Close shipment' },
        { type: 'VOID', label: 'Void shipment' },
      ]
    case 'closed':
    case 'voided':
      return []
  }
}

export function isHumanShipmentEvent(eventType: string): eventType is ShipmentHumanEventType {
  return (SHIPMENT_EVENT_TYPES as readonly string[]).includes(eventType)
}

export const ShipmentEventRequestSchema = z.object({
  event: z.enum(SHIPMENT_EVENT_TYPES),
  state_version: z.number().int().positive(),
})

export type ShipmentEventRequest = z.infer<typeof ShipmentEventRequestSchema>

export const shipmentWorkflow = registerWorkflow<
  ShipmentWorkflowState,
  ShipmentWorkflowEvent,
  ShipmentHumanEventType,
  ShipmentWorkflowSnapshot
>({
  name: SHIPMENT_WORKFLOW_NAME,
  schemaVersion: SHIPMENT_WORKFLOW_SCHEMA_VERSION,
  initialState: 'planned',
  terminalStates: SHIPMENT_TERMINAL_STATES,
  allStates: SHIPMENT_ALL_STATES,
  allEventTypes: SHIPMENT_EVENT_TYPES,
  reduce: transitionShipmentWorkflow,
  nextEvents: nextShipmentEvents,
  isHumanEvent: isHumanShipmentEvent,
  sideEffectTypes: [] as const,
})

export function parseShipmentEventRequest(
  body: unknown,
): { ok: true; value: ShipmentEventRequest } | { ok: false; error: string } {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) }
      : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) normalized.state_version = numeric
  }
  const result = ShipmentEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
