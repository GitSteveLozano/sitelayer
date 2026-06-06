import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActor, type Actor } from 'xstate'
import fc from 'fast-check'
import {
  CART_STORAGE_KEY,
  cartDateRange,
  readCart,
  rentalsPortalMachine,
  type PortalCartLine,
} from './rentals-portal.js'

/**
 * Three-net test harness for the `rentalsPortal` machine, the frontend
 * analog of the backend reducer harness (golden nextEvents + fast-check
 * property + replay). This machine has no backend reducer of its own, so
 * the "snapshot" it owns is XState context.
 *
 * 1. Golden affordance map — Record<stateValue, sortedAcceptedEvents[]>.
 *    A UI affordance regression (a button silently stops working) shows
 *    up as a snapshot diff.
 * 2. Property — cart/localStorage parity: after ANY sequence of
 *    ADD_TO_CART/UPDATE_LINE/REMOVE_LINE/CLEAR_CART, context.cart equals
 *    readCart() (the persisted mirror never diverges from context).
 * 3. Reserve flow — RESERVE gated by non-empty cart; onDone clears cart +
 *    sets requestId; a double RESERVE during `reserving` is a no-op.
 */

// jsdom provides localStorage; clear it between tests.
function line(id: string): PortalCartLine {
  return { inventory_item_id: id, qty: 1, start: '2026-06-01', end: '2026-06-08', delivery: 'pickup' }
}

/** Every event-name the machine declares (the affordance universe). */
const ALL_EVENT_TYPES = [
  'RELOAD',
  'SET_QUERY',
  'SET_CATEGORY',
  'ADD_TO_CART',
  'CLEAR_CART',
  'OPEN_CART',
  'BACK_TO_BROWSE',
  'UPDATE_LINE',
  'REMOVE_LINE',
  'SET_CONTACT',
  'RESERVE',
] as const

const DECLARED_STATES = ['loading', 'idle', 'cart_review', 'reserving', 'reserved']

let originalFetch: typeof globalThis.fetch

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const body = handler(url, init)
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }) as unknown as typeof globalThis.fetch
}

function startActor(initialCart: PortalCartLine[] = []): Actor<typeof rentalsPortalMachine> {
  const actor = createActor(rentalsPortalMachine, {
    input: { shareToken: 'tok-1', initialCart },
  })
  actor.start()
  return actor
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  window.localStorage.clear()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('rentalsPortalMachine — affordance golden map', () => {
  it('exposes a stable accepted-event set per reachable state', async () => {
    mockFetch(() => ({ items: [] }))

    // Build the map by driving the actor to each reachable state and
    // probing snapshot.can() over the full event union. Cart events that
    // are always-on (top-level `on`) appear in every non-loading state.
    const map: Record<string, string[]> = {}
    function record(stateValue: string, snapshot: ReturnType<Actor<typeof rentalsPortalMachine>['getSnapshot']>) {
      const accepted = ALL_EVENT_TYPES.filter((type) => {
        // Synthesize a minimal valid event for can()
        switch (type) {
          case 'SET_QUERY':
          case 'SET_CATEGORY':
            return snapshot.can({ type, value: 'x' })
          case 'ADD_TO_CART':
            return snapshot.can({ type, line: line('a') })
          case 'UPDATE_LINE':
            return snapshot.can({ type, index: 0, patch: {} })
          case 'REMOVE_LINE':
            return snapshot.can({ type, index: 0 })
          case 'SET_CONTACT':
            return snapshot.can({ type, field: 'name', value: 'x' })
          default:
            return snapshot.can({ type })
        }
      })
      map[stateValue] = accepted.slice().sort()
    }

    // loading (initial, before settle)
    const a = startActor()
    record('loading', a.getSnapshot())
    await settle()
    // idle (catalog loaded)
    record('idle', a.getSnapshot())
    // cart_review
    a.send({ type: 'ADD_TO_CART', line: line('a') })
    a.send({ type: 'OPEN_CART' })
    expect(a.getSnapshot().value).toBe('cart_review')
    record('cart_review', a.getSnapshot())

    expect(map).toMatchInlineSnapshot(`
      {
        "cart_review": [
          "ADD_TO_CART",
          "BACK_TO_BROWSE",
          "CLEAR_CART",
          "REMOVE_LINE",
          "RESERVE",
          "SET_CATEGORY",
          "SET_CONTACT",
          "SET_QUERY",
          "UPDATE_LINE",
        ],
        "idle": [
          "ADD_TO_CART",
          "CLEAR_CART",
          "OPEN_CART",
          "RELOAD",
          "REMOVE_LINE",
          "SET_CATEGORY",
          "SET_CONTACT",
          "SET_QUERY",
          "UPDATE_LINE",
        ],
        "loading": [
          "ADD_TO_CART",
          "CLEAR_CART",
          "REMOVE_LINE",
          "SET_CATEGORY",
          "SET_CONTACT",
          "SET_QUERY",
          "UPDATE_LINE",
        ],
      }
    `)
  })
})

describe('rentalsPortalMachine — cart/localStorage parity property', () => {
  it('context.cart always equals readCart() after any mutation sequence', async () => {
    mockFetch(() => ({ items: [] }))
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant('add' as const), id: fc.string({ minLength: 1, maxLength: 4 }) }),
            fc.record({ kind: fc.constant('remove' as const), index: fc.integer({ min: 0, max: 5 }) }),
            fc.record({
              kind: fc.constant('update' as const),
              index: fc.integer({ min: 0, max: 5 }),
              qty: fc.integer({ min: 1, max: 9 }),
            }),
            fc.constant({ kind: 'clear' as const }),
          ),
          { maxLength: 30 },
        ),
        async (ops) => {
          window.localStorage.clear()
          const actor = startActor()
          await settle()
          for (const op of ops) {
            switch (op.kind) {
              case 'add':
                actor.send({ type: 'ADD_TO_CART', line: line(op.id) })
                break
              case 'remove':
                actor.send({ type: 'REMOVE_LINE', index: op.index })
                break
              case 'update':
                actor.send({ type: 'UPDATE_LINE', index: op.index, patch: { qty: op.qty } })
                break
              case 'clear':
                actor.send({ type: 'CLEAR_CART' })
                break
            }
          }
          const ctxCart = actor.getSnapshot().context.cart
          expect(readCart()).toEqual(ctxCart)
          actor.stop()
        },
      ),
      { numRuns: 120 },
    )
  })

  it('machine value is always a declared state across random event sequences', async () => {
    mockFetch(() => ({ items: [] }))
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.constant({ type: 'OPEN_CART' as const }),
            fc.constant({ type: 'BACK_TO_BROWSE' as const }),
            fc.constant({ type: 'CLEAR_CART' as const }),
            fc.record({ kind: fc.constant('add' as const), id: fc.string({ minLength: 1, maxLength: 3 }) }),
            fc.constant({ type: 'SET_QUERY' as const, value: 'x' }),
          ),
          { maxLength: 20 },
        ),
        async (events) => {
          const actor = startActor()
          await settle()
          for (const e of events) {
            if ('kind' in e) actor.send({ type: 'ADD_TO_CART', line: line(e.id) })
            else actor.send(e)
            expect(DECLARED_STATES).toContain(String(actor.getSnapshot().value))
          }
          actor.stop()
        },
      ),
      { numRuns: 80 },
    )
  })
})

describe('rentalsPortalMachine — reserve flow', () => {
  it('RESERVE is gated by a non-empty cart', async () => {
    mockFetch(() => ({ items: [] }))
    const actor = startActor()
    await settle()
    actor.send({ type: 'OPEN_CART' })
    expect(actor.getSnapshot().value).toBe('cart_review')
    // empty cart → RESERVE is a no-op (guard fails)
    actor.send({ type: 'RESERVE' })
    expect(actor.getSnapshot().value).toBe('cart_review')
  })

  it('reserve onDone clears the cart, sets requestId, persists empty cart', async () => {
    mockFetch((url) => {
      if (url.includes('/reserve')) return { id: 'req-99', status: 'pending', created_at: '2026-06-01T00:00:00Z' }
      return { items: [] }
    })
    const actor = startActor()
    await settle()
    actor.send({ type: 'ADD_TO_CART', line: line('a') })
    actor.send({ type: 'OPEN_CART' })
    actor.send({ type: 'RESERVE' })
    expect(actor.getSnapshot().value).toBe('reserving')
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('reserved')
    expect(snap.context.requestId).toBe('req-99')
    expect(snap.context.cart).toEqual([])
    expect(readCart()).toEqual([])
  })

  it('reserve onError returns to cart_review with reserveError and keeps the cart', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/reserve')) {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response
    }) as unknown as typeof globalThis.fetch

    const actor = startActor()
    await settle()
    actor.send({ type: 'ADD_TO_CART', line: line('a') })
    actor.send({ type: 'OPEN_CART' })
    actor.send({ type: 'RESERVE' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('cart_review')
    expect(snap.context.reserveError).toBe('boom')
    expect(snap.context.cart).toHaveLength(1)
  })

  it('a double RESERVE during reserving is a no-op (single-shot)', async () => {
    let reserveCalls = 0
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/reserve')) {
        reserveCalls += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'req-1', status: 'pending', created_at: 'x' }),
        } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response
    }) as unknown as typeof globalThis.fetch

    const actor = startActor()
    await settle()
    actor.send({ type: 'ADD_TO_CART', line: line('a') })
    actor.send({ type: 'OPEN_CART' })
    actor.send({ type: 'RESERVE' })
    // second RESERVE while in `reserving` — no RESERVE handler there
    actor.send({ type: 'RESERVE' })
    await settle()
    expect(reserveCalls).toBe(1)
  })
})

describe('cartDateRange', () => {
  it('returns null/null for an empty cart', () => {
    expect(cartDateRange([])).toEqual({ start: null, end: null })
  })
  it('computes the min start and max end across lines', () => {
    const cart: PortalCartLine[] = [
      { inventory_item_id: 'a', qty: 1, start: '2026-06-05', end: '2026-06-10', delivery: 'pickup' },
      { inventory_item_id: 'b', qty: 1, start: '2026-06-01', end: '2026-06-20', delivery: 'delivery' },
    ]
    expect(cartDateRange(cart)).toEqual({ start: '2026-06-01', end: '2026-06-20' })
  })
})

describe('readCart', () => {
  it('round-trips through the storage key', () => {
    const cart = [line('z')]
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart))
    expect(readCart()).toEqual(cart)
  })
})
