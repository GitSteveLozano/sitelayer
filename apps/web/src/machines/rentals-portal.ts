import { useCallback, useEffect, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import { API_URL } from '@/lib/api'

/**
 * UI machine for the customer-facing rentals portal — the WHOLE
 * browse → cart → reserve → confirm journey, owned by ONE statechart
 * and rendered by three thin screens (RentalsPortal / RentalsCart /
 * RentalsConfirm) that all mount the *same* lifted instance (see the
 * RentalsPortalProvider context). Previously each screen re-read
 * localStorage and `RentalsCart` did the `/reserve` POST in a bare
 * async handler with its own useStates — three uncoordinated surfaces
 * glued only by the storage key. This machine is now the single
 * source of truth.
 *
 * Owned by the machine:
 *   - the inventory catalog snapshot
 *   - filter UI state (query string, selected category)
 *   - the cart (read from localStorage at boot, persisted on every
 *     mutation via a side-effect action) + per-line edits
 *   - the customer contact draft (name/email/phone/notes)
 *   - the `/reserve` POST (the `reserveRequest` actor) + its error
 *   - the resulting `requestId` the confirm screen renders
 *   - load error string
 *
 * NOT owned by the machine:
 *   - react-router navigation between the three screens (the screens
 *     own Link / navigate — UI nav is allowed on the React boundary).
 *
 * The localStorage mirror (`persistCart`) is now a *resume* convenience
 * (refresh / deep-link), NOT a cross-screen IPC channel: there is one
 * writer (this machine) and the three screens share its context.
 *
 * State graph:
 *
 *   loading ─onDone▶ idle (items set, error cleared)
 *           ─onError▶ idle (error set)
 *   idle ─RELOAD▶ loading
 *        ─OPEN_CART▶ cart_review
 *        ─SET_QUERY / SET_CATEGORY / ADD_TO_CART / CLEAR_CART → idle
 *   cart_review ─BACK_TO_BROWSE▶ idle
 *               ─UPDATE_LINE / REMOVE_LINE / SET_CONTACT / ADD_TO_CART / CLEAR_CART → cart_review
 *               ─RESERVE (cart non-empty)▶ reserving
 *   reserving ─onDone▶ reserved (requestId set, cart cleared+persisted)
 *             ─onError▶ cart_review (reserveError set)
 *   reserved (terminal-ish) ─OPEN_CART / RELOAD▶ re-enter the flow
 */

export interface PortalCatalogItem {
  id: string
  code: string
  description: string
  category: string
  unit: string
  default_rental_rate: string
  replacement_value: string | null
}

export interface PortalCartLine {
  inventory_item_id: string
  qty: number
  start: string
  end: string
  delivery: 'pickup' | 'delivery'
}

export const CART_STORAGE_KEY = 'sitelayer:portal:rentals:cart'

export function readCart(): PortalCartLine[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PortalCartLine[]) : []
  } catch {
    return []
  }
}

export function writeCart(cart: PortalCartLine[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart))
  } catch {
    // localStorage blocked (incognito, full disk) — silently degrade.
    // The in-memory cart on the machine context is still the
    // session-of-truth.
  }
}

export interface PortalContact {
  name: string
  email: string
  phone: string
  notes: string
}

export interface ReserveResponse {
  id: string
  status: string
  created_at: string
}

const EMPTY_CONTACT: PortalContact = { name: '', email: '', phone: '', notes: '' }

async function fetchCatalog(shareToken: string): Promise<{ items: PortalCatalogItem[] }> {
  const url = `${API_URL}/api/portal/rentals/${encodeURIComponent(shareToken)}/catalog`
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Catalog request failed (${response.status})`)
  }
  return (await response.json()) as { items: PortalCatalogItem[] }
}

/** Compute the requested date range envelope across the cart lines. */
export function cartDateRange(cart: PortalCartLine[]): { start: string | null; end: string | null } {
  if (cart.length === 0) return { start: null, end: null }
  const start = cart.reduce((min, l) => (l.start && (!min || l.start < min) ? l.start : min), '')
  const end = cart.reduce((max, l) => (l.end && (!max || l.end > max) ? l.end : max), '')
  return { start: start || null, end: end || null }
}

async function postReserve(
  shareToken: string,
  cart: PortalCartLine[],
  contact: PortalContact,
): Promise<ReserveResponse> {
  const range = cartDateRange(cart)
  const url = `${API_URL}/api/portal/rentals/${encodeURIComponent(shareToken)}/reserve`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      items: cart,
      requested_start: range.start,
      requested_end: range.end,
      contact_name: contact.name,
      contact_email: contact.email,
      contact_phone: contact.phone,
      notes: contact.notes || null,
    }),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? `Reserve failed (${response.status})`)
  }
  return (await response.json()) as ReserveResponse
}

type Context = {
  shareToken: string
  items: PortalCatalogItem[]
  error: string | null
  query: string
  category: string
  cart: PortalCartLine[]
  contact: PortalContact
  requestId: string | null
  reserveError: string | null
}

type Event =
  | { type: 'RELOAD' }
  | { type: 'SET_QUERY'; value: string }
  | { type: 'SET_CATEGORY'; value: string }
  | { type: 'ADD_TO_CART'; line: PortalCartLine }
  | { type: 'CLEAR_CART' }
  | { type: 'OPEN_CART' }
  | { type: 'BACK_TO_BROWSE' }
  | { type: 'UPDATE_LINE'; index: number; patch: Partial<PortalCartLine> }
  | { type: 'REMOVE_LINE'; index: number }
  | { type: 'SET_CONTACT'; field: keyof PortalContact; value: string }
  | { type: 'RESERVE' }

const machine = setup({
  types: {
    context: {} as Context,
    input: {} as { shareToken: string; initialCart?: PortalCartLine[] },
    events: {} as Event,
  },
  actors: {
    loadCatalog: fromPromise<{ items: PortalCatalogItem[] }, { shareToken: string }>(async ({ input }) => {
      return fetchCatalog(input.shareToken)
    }),
    reserveRequest: fromPromise<
      ReserveResponse,
      { shareToken: string; cart: PortalCartLine[]; contact: PortalContact }
    >(async ({ input }) => {
      return postReserve(input.shareToken, input.cart, input.contact)
    }),
  },
  actions: {
    persistCart: ({ context }) => {
      writeCart(context.cart)
    },
  },
  guards: {
    cartNotEmpty: ({ context }) => context.cart.length > 0,
  },
}).createMachine({
  id: 'rentalsPortal',
  initial: 'loading',
  context: ({ input }) => ({
    shareToken: input.shareToken,
    items: [],
    error: null,
    query: '',
    category: 'All',
    cart: input.initialCart ?? [],
    contact: { ...EMPTY_CONTACT },
    requestId: null,
    reserveError: null,
  }),
  on: {
    // Cart edits and filters are accepted in any non-reserving state via
    // the top-level `on` block; the FSM transitions (RESERVE / OPEN_CART /
    // BACK_TO_BROWSE) live on the per-state `on` so they are gated.
    SET_QUERY: { actions: assign({ query: ({ event }) => event.value }) },
    SET_CATEGORY: { actions: assign({ category: ({ event }) => event.value }) },
    ADD_TO_CART: {
      actions: [
        assign({
          cart: ({ context, event }) => [...context.cart, event.line],
        }),
        'persistCart',
      ],
    },
    UPDATE_LINE: {
      actions: [
        assign({
          cart: ({ context, event }) =>
            context.cart.map((line, i) => (i === event.index ? { ...line, ...event.patch } : line)),
        }),
        'persistCart',
      ],
    },
    REMOVE_LINE: {
      actions: [
        assign({
          cart: ({ context, event }) => context.cart.filter((_, i) => i !== event.index),
        }),
        'persistCart',
      ],
    },
    CLEAR_CART: {
      actions: [assign({ cart: () => [] }), 'persistCart'],
    },
    SET_CONTACT: {
      actions: assign({
        contact: ({ context, event }) => ({ ...context.contact, [event.field]: event.value }),
      }),
    },
  },
  states: {
    loading: {
      invoke: {
        src: 'loadCatalog',
        input: ({ context }) => ({ shareToken: context.shareToken }),
        onDone: {
          target: 'idle',
          actions: assign({
            items: ({ event }) => event.output.items,
            error: () => null,
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to load catalog'),
          }),
        },
      },
    },
    idle: {
      on: {
        RELOAD: 'loading',
        OPEN_CART: 'cart_review',
      },
    },
    cart_review: {
      on: {
        BACK_TO_BROWSE: 'idle',
        // Clear any prior reserve error when re-entering the flow.
        RESERVE: {
          guard: 'cartNotEmpty',
          target: 'reserving',
          actions: assign({ reserveError: () => null }),
        },
      },
    },
    reserving: {
      invoke: {
        src: 'reserveRequest',
        input: ({ context }) => ({ shareToken: context.shareToken, cart: context.cart, contact: context.contact }),
        onDone: {
          target: 'reserved',
          actions: [
            assign({
              requestId: ({ event }) => event.output.id,
              cart: () => [],
              reserveError: () => null,
            }),
            'persistCart',
          ],
        },
        onError: {
          target: 'cart_review',
          actions: assign({
            reserveError: ({ event }) => (event.error instanceof Error ? event.error.message : 'Reserve failed'),
          }),
        },
      },
    },
    reserved: {
      on: {
        // Allow the customer to start a fresh request from the confirm
        // screen without a full reload.
        OPEN_CART: 'cart_review',
        RELOAD: 'loading',
      },
    },
  },
})

export const rentalsPortalMachine = machine

export interface RentalsPortalHookResult {
  items: PortalCatalogItem[]
  error: string | null
  isLoading: boolean
  query: string
  category: string
  categories: string[]
  filtered: PortalCatalogItem[]
  cart: PortalCartLine[]
  contact: PortalContact
  /** Date range envelope derived from the cart lines. */
  range: { start: string | null; end: string | null }
  /** Reservation reference id once the `/reserve` POST has landed. */
  requestId: string | null
  reserveError: string | null
  /** True while the `/reserve` POST is in flight (button disable). */
  isReserving: boolean
  /** True once the reservation has been submitted. */
  isReserved: boolean
  setQuery: (value: string) => void
  setCategory: (value: string) => void
  addToCart: (line: PortalCartLine) => void
  updateLine: (index: number, patch: Partial<PortalCartLine>) => void
  removeLine: (index: number) => void
  setContact: (field: keyof PortalContact, value: string) => void
  clearCart: () => void
  openCart: () => void
  backToBrowse: () => void
  reserve: () => void
  reload: () => void
}

export function useRentalsPortal(shareToken: string): RentalsPortalHookResult {
  // Seed the cart from localStorage exactly once at mount. Subsequent
  // reads/writes flow through the machine.
  const input = useMemo(
    () => ({ shareToken, initialCart: readCart() }),
    // The react-hooks/exhaustive-deps rule is not enabled in this repo's
    // eslint config; intentionally omitting it. See repo eslint.config.
    [shareToken],
  )
  const [state, send] = useMachine(rentalsPortalMachine, { input })

  useEffect(() => {
    send({ type: 'RELOAD' })
  }, [shareToken, send])

  const setQuery = useCallback((value: string) => send({ type: 'SET_QUERY', value }), [send])
  const setCategory = useCallback((value: string) => send({ type: 'SET_CATEGORY', value }), [send])
  const addToCart = useCallback((line: PortalCartLine) => send({ type: 'ADD_TO_CART', line }), [send])
  const updateLine = useCallback(
    (index: number, patch: Partial<PortalCartLine>) => send({ type: 'UPDATE_LINE', index, patch }),
    [send],
  )
  const removeLine = useCallback((index: number) => send({ type: 'REMOVE_LINE', index }), [send])
  const setContact = useCallback(
    (field: keyof PortalContact, value: string) => send({ type: 'SET_CONTACT', field, value }),
    [send],
  )
  const clearCart = useCallback(() => send({ type: 'CLEAR_CART' }), [send])
  const openCart = useCallback(() => send({ type: 'OPEN_CART' }), [send])
  const backToBrowse = useCallback(() => send({ type: 'BACK_TO_BROWSE' }), [send])
  const reserve = useCallback(() => send({ type: 'RESERVE' }), [send])
  const reload = useCallback(() => send({ type: 'RELOAD' }), [send])

  const items = state.context.items
  const categories = useMemo(() => {
    const set = new Set<string>(['All'])
    for (const item of items) if (item.category) set.add(item.category)
    return Array.from(set)
  }, [items])

  const { query, category } = state.context
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (category !== 'All' && item.category !== category) return false
        if (query && !`${item.code} ${item.description}`.toLowerCase().includes(query.toLowerCase())) return false
        return true
      }),
    [items, category, query],
  )

  const cart = state.context.cart
  const range = useMemo(() => cartDateRange(cart), [cart])

  return {
    items,
    error: state.context.error,
    isLoading: state.matches('loading'),
    query,
    category,
    categories,
    filtered,
    cart,
    contact: state.context.contact,
    range,
    requestId: state.context.requestId,
    reserveError: state.context.reserveError,
    isReserving: state.matches('reserving'),
    isReserved: state.matches('reserved'),
    setQuery,
    setCategory,
    addToCart,
    updateLine,
    removeLine,
    setContact,
    clearCart,
    openCart,
    backToBrowse,
    reserve,
    reload,
  }
}
