import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  RENTAL_ALL_STATES,
  rentalWorkflow,
  isHumanRentalEvent,
  nextRentalEvents,
  parseRentalEventRequest,
  transitionRentalWorkflow,
  type RentalWorkflowEvent,
  type RentalWorkflowSnapshot,
  type RentalWorkflowState,
} from './rental.js'

describe('transitionRentalWorkflow — happy path', () => {
  it('walks active → returned → invoiced_pending → returned (cycle)', () => {
    const active: RentalWorkflowSnapshot = { state: 'active', state_version: 1 }
    const returned = transitionRentalWorkflow(active, {
      type: 'RETURN',
      returned_at: '2026-04-29T12:00:00.000Z',
      returned_by: 'foreman-user',
    })
    expect(returned).toMatchObject({ state: 'returned', state_version: 2, returned_by: 'foreman-user' })

    const invoicing = transitionRentalWorkflow(returned, { type: 'INVOICE_QUEUED' })
    expect(invoicing).toMatchObject({ state: 'invoiced_pending', state_version: 3 })

    const cycled = transitionRentalWorkflow(invoicing, { type: 'INVOICE_POSTED' })
    // Cadence cycle: invoiced_pending → returned for the next billing window.
    expect(cycled).toMatchObject({ state: 'returned', state_version: 4 })
  })

  it('CLOSE is reachable from active, returned, and invoiced_pending', () => {
    for (const state of ['active', 'returned', 'invoiced_pending'] as RentalWorkflowState[]) {
      const closed = transitionRentalWorkflow(
        { state, state_version: 1 },
        { type: 'CLOSE', closed_at: '2026-04-29T12:00:00.000Z', closed_by: 'admin' },
      )
      expect(closed.state).toBe('closed')
      expect(closed.closed_by).toBe('admin')
    }
  })

  it('rejects illegal transitions', () => {
    expect(() => transitionRentalWorkflow({ state: 'active', state_version: 1 }, { type: 'INVOICE_QUEUED' })).toThrow(
      /not allowed/,
    )
    expect(() =>
      transitionRentalWorkflow(
        { state: 'closed', state_version: 4 },
        { type: 'RETURN', returned_at: 'x', returned_by: 'x' },
      ),
    ).toThrow(/not allowed/)
  })
})

describe('rental reducer — property invariants', () => {
  const STATE_GEN: fc.Arbitrary<RentalWorkflowState> = fc.constantFrom(...RENTAL_ALL_STATES)
  const EVENT_GEN: fc.Arbitrary<RentalWorkflowEvent> = fc.oneof(
    fc.record({
      type: fc.constant('RETURN' as const),
      returned_at: fc.constant('2026-04-29T12:00:00.000Z'),
      returned_by: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    fc.constant<RentalWorkflowEvent>({ type: 'INVOICE_QUEUED' }),
    fc.constant<RentalWorkflowEvent>({ type: 'INVOICE_POSTED' }),
    fc.record({
      type: fc.constant('CLOSE' as const),
      closed_at: fc.constant('2026-04-29T12:00:00.000Z'),
      closed_by: fc.string({ minLength: 1, maxLength: 32 }),
    }),
  )

  it('state_version increments by 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), EVENT_GEN, (state, version, event) => {
        const snap: RentalWorkflowSnapshot = { state, state_version: version }
        try {
          const next = transitionRentalWorkflow(snap, event)
          expect(next.state_version).toBe(version + 1)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('terminal state rejects every event', () => {
    fc.assert(
      fc.property(EVENT_GEN, (event) => {
        expect(() => transitionRentalWorkflow({ state: 'closed', state_version: 4 }, event)).toThrow(/not allowed/)
      }),
    )
  })

  it('output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, EVENT_GEN, (state, event) => {
        try {
          const next = transitionRentalWorkflow({ state, state_version: 1 }, event)
          expect(RENTAL_ALL_STATES).toContain(next.state)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('nextEvents returns only events the reducer accepts', () => {
    for (const state of RENTAL_ALL_STATES) {
      const events = nextRentalEvents(state)
      for (const next of events) {
        const event: RentalWorkflowEvent =
          next.type === 'RETURN'
            ? { type: 'RETURN', returned_at: '2026-04-29T12:00:00.000Z', returned_by: 't' }
            : { type: 'CLOSE', closed_at: '2026-04-29T12:00:00.000Z', closed_by: 't' }
        expect(() => transitionRentalWorkflow({ state, state_version: 1 }, event)).not.toThrow()
      }
    }
  })
})

describe('isHumanRentalEvent', () => {
  it('partitions human and worker events', () => {
    expect(isHumanRentalEvent('RETURN')).toBe(true)
    expect(isHumanRentalEvent('CLOSE')).toBe(true)
    expect(isHumanRentalEvent('INVOICE_QUEUED')).toBe(false)
    expect(isHumanRentalEvent('INVOICE_POSTED')).toBe(false)
  })
})

describe('parseRentalEventRequest', () => {
  it('accepts well-formed events', () => {
    expect(parseRentalEventRequest({ event: 'RETURN', state_version: 1 }).ok).toBe(true)
    expect(parseRentalEventRequest({ event: 'CLOSE', state_version: 1 }).ok).toBe(true)
  })
  it('rejects worker-only events', () => {
    expect(parseRentalEventRequest({ event: 'INVOICE_QUEUED', state_version: 1 }).ok).toBe(false)
    expect(parseRentalEventRequest({ event: 'INVOICE_POSTED', state_version: 1 }).ok).toBe(false)
  })
})

describe('rentalWorkflow registry', () => {
  it('exposes reducer + metadata', () => {
    expect(rentalWorkflow.name).toBe('rental')
    expect(rentalWorkflow.initialState).toBe('active')
    expect(rentalWorkflow.terminalStates).toEqual(['closed'])
  })
})
