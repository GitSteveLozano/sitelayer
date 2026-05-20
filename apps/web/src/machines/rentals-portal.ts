import { useCallback, useEffect, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import { API_URL } from '@/lib/api'

/**
 * UI machine for the customer-facing rentals catalog browse view
 * (`portal/RentalsPortal.tsx`). The original screen had 6 useStates
 * (items / loading / error / query / category / cart) plus 2
 * useEffects (catalog fetch, cart write-through). That's the
 * canonical multi-mode-long-lived-state pattern — replace with an
 * XState machine.
 *
 * Owned by the machine:
 *   - the inventory catalog snapshot
 *   - filter UI state (query string, selected category)
 *   - the cart (read from localStorage at boot, persisted on every
 *     mutation via a side-effect action)
 *   - load error string
 *
 * NOT owned by the machine:
 *   - react-router navigation to /cart (the screen owns Link)
 *   - the cart's *consumer* in RentalsCart.tsx (which still reads
 *     localStorage itself — the storage key is the contract between
 *     the two screens).
 *
 * State graph:
 *
 *   loading ─onDone▶ idle (items set, error cleared)
 *           ─onError▶ idle (error set)
 *   idle ─RELOAD▶ loading
 *        ─SET_QUERY / SET_CATEGORY / ADD_TO_CART / CLEAR_CART → idle
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

async function fetchCatalog(shareToken: string): Promise<{ items: PortalCatalogItem[] }> {
  const url = `${API_URL}/api/portal/rentals/${encodeURIComponent(shareToken)}/catalog`
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Catalog request failed (${response.status})`)
  }
  return (await response.json()) as { items: PortalCatalogItem[] }
}

type Context = {
  shareToken: string
  items: PortalCatalogItem[]
  error: string | null
  query: string
  category: string
  cart: PortalCartLine[]
}

type Event =
  | { type: 'RELOAD' }
  | { type: 'SET_QUERY'; value: string }
  | { type: 'SET_CATEGORY'; value: string }
  | { type: 'ADD_TO_CART'; line: PortalCartLine }
  | { type: 'CLEAR_CART' }

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
  },
  actions: {
    persistCart: ({ context }) => {
      writeCart(context.cart)
    },
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
  }),
  on: {
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
    CLEAR_CART: {
      actions: [assign({ cart: () => [] }), 'persistCart'],
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
  setQuery: (value: string) => void
  setCategory: (value: string) => void
  addToCart: (line: PortalCartLine) => void
  clearCart: () => void
  reload: () => void
}

export function useRentalsPortal(shareToken: string): RentalsPortalHookResult {
  // Seed the cart from localStorage exactly once at mount. Subsequent
  // reads/writes flow through the machine.
  const input = useMemo(
    () => ({ shareToken, initialCart: readCart() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shareToken],
  )
  const [state, send] = useMachine(rentalsPortalMachine, { input })

  useEffect(() => {
    send({ type: 'RELOAD' })
  }, [shareToken, send])

  const setQuery = useCallback((value: string) => send({ type: 'SET_QUERY', value }), [send])
  const setCategory = useCallback((value: string) => send({ type: 'SET_CATEGORY', value }), [send])
  const addToCart = useCallback((line: PortalCartLine) => send({ type: 'ADD_TO_CART', line }), [send])
  const clearCart = useCallback(() => send({ type: 'CLEAR_CART' }), [send])
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

  return {
    items,
    error: state.context.error,
    isLoading: state.matches('loading'),
    query,
    category,
    categories,
    filtered,
    cart: state.context.cart,
    setQuery,
    setCategory,
    addToCart,
    clearCart,
    reload,
  }
}
