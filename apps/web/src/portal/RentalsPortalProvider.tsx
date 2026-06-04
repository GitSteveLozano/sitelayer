import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { Outlet, useParams } from 'react-router-dom'
import { useRentalsPortal, type RentalsPortalHookResult } from '@/machines/rentals-portal'
import { registerCaptureStateProvider } from '@/lib/capture-state-providers'
import { IssueReporter } from './IssueReporter'

/**
 * Lifts the single `rentalsPortal` XState instance to a parent route so
 * all three customer screens (browse / cart / confirm) render+dispatch
 * against the SAME machine context instead of each re-reading
 * localStorage. This is the headless-first fix for the cart split-brain:
 * one machine, three thin renderers.
 *
 * Mounted in App.tsx as the element of the `/portal/rentals/:shareToken`
 * route with the three screens as nested `<Route>`s; `<Outlet />` renders
 * the active child. The machine reads the share token from the URL and
 * seeds the cart from localStorage exactly once (resume convenience).
 */

const RentalsPortalContext = createContext<RentalsPortalHookResult | null>(null)

export function RentalsPortalProvider({ children }: { children?: ReactNode }) {
  const params = useParams<{ shareToken: string }>()
  const shareToken = params.shareToken ?? ''
  const portal = useRentalsPortal(shareToken)
  useRentalsPortalCaptureStateProvider(shareToken, portal)

  if (!shareToken) {
    return <div style={{ padding: 32 }}>Missing share token.</div>
  }

  return (
    <RentalsPortalContext.Provider value={portal}>
      {children ?? <Outlet />}
      <IssueReporter surface="rental_portal" shareToken={shareToken} />
    </RentalsPortalContext.Provider>
  )
}

export function useRentalsPortalContext(): RentalsPortalHookResult {
  const ctx = useContext(RentalsPortalContext)
  if (!ctx) {
    throw new Error('useRentalsPortalContext must be used within a <RentalsPortalProvider>')
  }
  return ctx
}

function useRentalsPortalCaptureStateProvider(shareToken: string, portal: RentalsPortalHookResult): void {
  const portalRef = useRef(portal)
  portalRef.current = portal

  useEffect(() => {
    if (!shareToken) return undefined
    return registerCaptureStateProvider('portal:rentals', ({ reason }) => {
      const state = portalRef.current
      const itemsById = new Map(state.items.map((item) => [item.id, item]))
      return {
        schema: 'sitelayer.portal.rentals-state.v1',
        payload: {
          surface: 'rental_portal',
          route_template: '/portal/rentals/:shareToken',
          share_token_present: true,
          reason,
          is_loading: state.isLoading,
          has_error: Boolean(state.error),
          error_message: state.error ? truncateForCapture(state.error) : null,
          query: truncateForCapture(state.query),
          category: state.category,
          catalog: {
            item_count: state.items.length,
            filtered_count: state.filtered.length,
            category_count: state.categories.length,
          },
          cart: {
            line_count: state.cart.length,
            range: state.range,
            truncated: state.cart.length > 20,
            lines: state.cart.slice(0, 20).map((line, index) => {
              const item = itemsById.get(line.inventory_item_id)
              return {
                index,
                inventory_item_id: line.inventory_item_id,
                item_code: item?.code ?? null,
                item_category: item?.category ?? null,
                unit: item?.unit ?? null,
                qty: Number.isFinite(line.qty) ? line.qty : null,
                start: line.start || null,
                end: line.end || null,
                delivery: line.delivery,
              }
            }),
          },
          reservation: {
            request_id: state.requestId,
            is_reserving: state.isReserving,
            is_reserved: state.isReserved,
            has_error: Boolean(state.reserveError),
            error_message: state.reserveError ? truncateForCapture(state.reserveError) : null,
          },
        },
        piiLevel: 'internal' as const,
        metadata: {
          portal_surface: 'rental_portal',
          route_template: '/portal/rentals/:shareToken',
        },
      }
    })
  }, [shareToken])
}

function truncateForCapture(value: string): string {
  return value.length > 500 ? value.slice(0, 500) : value
}
