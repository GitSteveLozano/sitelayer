import { useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { registerTokenProvider } from './api/client'

/**
 * Bridges Clerk's `useAuth().getToken()` into the API client's
 * registered token provider. Mounted once near the root (inside
 * AuthProvider) when Clerk is configured.
 *
 * The provider is async and called on every API request, so Clerk's
 * built-in caching (~60s TTL) is what keeps the network cost down.
 * On sign-out the API client falls back to no-Authorization, which
 * the API rejects with 401 — the SignIn surface in v2 takes over.
 */
export function ClerkTokenBridge() {
  const { getToken, isSignedIn } = useAuth()

  useEffect(() => {
    registerTokenProvider(async () => {
      if (!isSignedIn) return null
      try {
        return await getToken()
      } catch {
        return null
      }
    })
    return () => {
      // On unmount we revert to a null provider so the next mount can
      // re-register without a stale closure leaking.
      registerTokenProvider(async () => null)
    }
  }, [getToken, isSignedIn])

  return null
}
