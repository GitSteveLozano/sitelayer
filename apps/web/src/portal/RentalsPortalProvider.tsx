import { createContext, useContext, type ReactNode } from 'react'
import { Outlet, useParams } from 'react-router-dom'
import { useRentalsPortal, type RentalsPortalHookResult } from '@/machines/rentals-portal'
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
