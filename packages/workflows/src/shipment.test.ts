import { describe, it, expect } from 'vitest'
import {
  SHIPMENT_ALL_STATES,
  SHIPMENT_EVENT_TYPES,
  SHIPMENT_TERMINAL_STATES,
  SHIPMENT_WORKFLOW_NAME,
  SHIPMENT_WORKFLOW_SCHEMA_VERSION,
  isHumanShipmentEvent,
  nextShipmentEvents,
  parseShipmentEventRequest,
  shipmentWorkflow,
  transitionShipmentWorkflow,
  type ShipmentWorkflowSnapshot,
} from './shipment.js'

describe('transitionShipmentWorkflow — happy path', () => {
  it('walks planned → picking → shipped → delivered → closed', () => {
    const planned: ShipmentWorkflowSnapshot = { state: 'planned', state_version: 1 }
    const picking = transitionShipmentWorkflow(planned, { type: 'START_PICKING' })
    expect(picking).toMatchObject({ state: 'picking', state_version: 2 })

    const shipped = transitionShipmentWorkflow(picking, {
      type: 'SHIP',
      shipped_at: '2026-05-01T09:00:00.000Z',
      driver: 'driver-1',
      ticket_number: 'T-1234',
    })
    expect(shipped).toMatchObject({
      state: 'shipped',
      state_version: 3,
      shipped_at: '2026-05-01T09:00:00.000Z',
      driver: 'driver-1',
      ticket_number: 'T-1234',
    })

    const delivered = transitionShipmentWorkflow(shipped, {
      type: 'CONFIRM_DELIVERY',
      delivered_at: '2026-05-01T11:00:00.000Z',
      confirmed_by: 'crew-1',
    })
    expect(delivered).toMatchObject({
      state: 'delivered',
      state_version: 4,
      delivered_at: '2026-05-01T11:00:00.000Z',
      confirmed_by: 'crew-1',
    })

    const closed = transitionShipmentWorkflow(delivered, {
      type: 'CLOSE',
      confirmed_by: 'office-user',
    })
    expect(closed).toMatchObject({ state: 'closed', state_version: 5 })
  })

  it('supports a returns branch: delivered → returning → closed', () => {
    const delivered: ShipmentWorkflowSnapshot = {
      state: 'delivered',
      state_version: 4,
      confirmed_by: 'crew-1',
    }
    const returning = transitionShipmentWorkflow(delivered, { type: 'OPEN_RETURN' })
    expect(returning).toMatchObject({ state: 'returning', state_version: 5 })

    const closed = transitionShipmentWorkflow(returning, {
      type: 'CLOSE',
      confirmed_by: 'office-user',
    })
    expect(closed).toMatchObject({ state: 'closed', state_version: 6, confirmed_by: 'office-user' })
  })

  it('allows SHIP to skip from planned (no separate START_PICKING)', () => {
    const planned: ShipmentWorkflowSnapshot = { state: 'planned', state_version: 1 }
    const shipped = transitionShipmentWorkflow(planned, {
      type: 'SHIP',
      shipped_at: '2026-05-01T09:00:00.000Z',
    })
    expect(shipped).toMatchObject({ state: 'shipped', state_version: 2 })
  })
})

describe('transitionShipmentWorkflow — illegal transitions', () => {
  it('rejects CONFIRM_DELIVERY from planned (must be shipped)', () => {
    expect(() =>
      transitionShipmentWorkflow(
        { state: 'planned', state_version: 1 },
        { type: 'CONFIRM_DELIVERY', delivered_at: 'x', confirmed_by: 'x' },
      ),
    ).toThrow(/illegal transition/)
  })

  it('rejects START_PICKING from shipped', () => {
    expect(() => transitionShipmentWorkflow({ state: 'shipped', state_version: 3 }, { type: 'START_PICKING' })).toThrow(
      /illegal transition/,
    )
  })

  it('rejects any event from terminal closed state', () => {
    expect(() => transitionShipmentWorkflow({ state: 'closed', state_version: 5 }, { type: 'START_PICKING' })).toThrow(
      /illegal transition/,
    )
    expect(() => transitionShipmentWorkflow({ state: 'closed', state_version: 5 }, { type: 'VOID' })).toThrow(
      /illegal transition/,
    )
  })

  it('rejects any event from terminal voided state', () => {
    expect(() =>
      transitionShipmentWorkflow({ state: 'voided', state_version: 5 }, { type: 'SHIP', shipped_at: 'x' }),
    ).toThrow(/illegal transition/)
  })

  it('rejects OPEN_RETURN from shipped (must be delivered first)', () => {
    expect(() => transitionShipmentWorkflow({ state: 'shipped', state_version: 3 }, { type: 'OPEN_RETURN' })).toThrow(
      /illegal transition/,
    )
  })
})

describe('nextShipmentEvents', () => {
  it('exposes the canonical UI affordance for each non-terminal state', () => {
    expect(
      nextShipmentEvents('planned')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['SHIP', 'START_PICKING', 'VOID'].sort())
    expect(
      nextShipmentEvents('picking')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['SHIP', 'VOID'])
    expect(
      nextShipmentEvents('shipped')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['CONFIRM_DELIVERY', 'VOID'])
    expect(
      nextShipmentEvents('delivered')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['CLOSE', 'OPEN_RETURN', 'VOID'].sort())
    expect(
      nextShipmentEvents('returning')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['CLOSE', 'VOID'])
    expect(nextShipmentEvents('closed')).toEqual([])
    expect(nextShipmentEvents('voided')).toEqual([])
  })
})

describe('isHumanShipmentEvent', () => {
  it('accepts every declared event type', () => {
    for (const t of SHIPMENT_EVENT_TYPES) {
      expect(isHumanShipmentEvent(t)).toBe(true)
    }
  })
  it('rejects garbage', () => {
    expect(isHumanShipmentEvent('BOGUS')).toBe(false)
    expect(isHumanShipmentEvent('')).toBe(false)
  })
})

describe('parseShipmentEventRequest', () => {
  it('accepts a well-formed request', () => {
    const r = parseShipmentEventRequest({ event: 'SHIP', state_version: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.event).toBe('SHIP')
  })
  it('coerces stringy state_version', () => {
    const r = parseShipmentEventRequest({ event: 'CONFIRM_DELIVERY', state_version: '7' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.state_version).toBe(7)
  })
  it('rejects unknown event types', () => {
    expect(parseShipmentEventRequest({ event: 'BOGUS', state_version: 1 }).ok).toBe(false)
  })
  it('rejects malformed bodies', () => {
    expect(parseShipmentEventRequest({}).ok).toBe(false)
    expect(parseShipmentEventRequest(null).ok).toBe(false)
    expect(parseShipmentEventRequest('nope').ok).toBe(false)
    expect(parseShipmentEventRequest({ event: 'SHIP', state_version: 0 }).ok).toBe(false)
    expect(parseShipmentEventRequest({ event: 'SHIP', state_version: -1 }).ok).toBe(false)
    expect(parseShipmentEventRequest({ event: 'SHIP', state_version: 1.5 }).ok).toBe(false)
  })
})

describe('shipmentWorkflow registry registration', () => {
  it('exposes reducer + metadata via the registry definition', () => {
    expect(shipmentWorkflow.name).toBe(SHIPMENT_WORKFLOW_NAME)
    expect(shipmentWorkflow.schemaVersion).toBe(SHIPMENT_WORKFLOW_SCHEMA_VERSION)
    expect(shipmentWorkflow.initialState).toBe('planned')
    expect(shipmentWorkflow.terminalStates).toEqual(SHIPMENT_TERMINAL_STATES)
    expect(shipmentWorkflow.allStates).toEqual(SHIPMENT_ALL_STATES)
    expect(shipmentWorkflow.sideEffectTypes).toEqual([])
  })
})
