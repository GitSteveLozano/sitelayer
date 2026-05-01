import { ClerkProvider } from '@clerk/clerk-react'
import type { ReactNode } from 'react'
import { ClerkTokenBridge } from './clerk-token-bridge'

/**
 * Clerk wiring. If `VITE_CLERK_PUBLISHABLE_KEY` is set we mount the
 * provider AND bridge `useAuth().getToken()` into the API client's
 * token provider so every authenticated request carries a Bearer
 * token. Without the env var we render children directly so the
 * substrate boots in dev without a Clerk app configured (the API
 * accepts the header-fallback path until AUTH_ALLOW_HEADER_FALLBACK=0
 * in prod).
 *
 * Phase 1D.4 hardens by registering the token provider at mount; full
 * sign-in redirect + org switcher land alongside the pilot rollout.
 */
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim()

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!PUBLISHABLE_KEY) {
    return <>{children}</>
  }
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
      <ClerkTokenBridge />
      {children}
    </ClerkProvider>
  )
}

export function isClerkConfigured(): boolean {
  return Boolean(PUBLISHABLE_KEY)
}
