import { ClerkProvider } from '@clerk/clerk-react'
import type { ReactNode } from 'react'

/**
 * Clerk wiring. Phase 0 keeps it loose: if `VITE_CLERK_PUBLISHABLE_KEY`
 * is set we mount the provider; otherwise we render children directly so
 * the substrate boots in dev without a Clerk app configured.
 *
 * Phase 1 hardens this — sign-in redirect, role-gated routes, and
 * Clerk org switcher. Don't add those here; Phase 0 is substrate.
 */
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim()

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!PUBLISHABLE_KEY) {
    return <>{children}</>
  }
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
      {children}
    </ClerkProvider>
  )
}

export function isClerkConfigured(): boolean {
  return Boolean(PUBLISHABLE_KEY)
}
