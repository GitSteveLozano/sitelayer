// Resolves a Clerk user id to its primary email address with a small
// in-process TTL cache. Used by the notifications drain so rows that were
// queued with `recipient_clerk_user_id` (and no `recipient_email`) actually
// reach a mailbox instead of silently being marked sent.
//
// Result kinds:
//   - email           → resolved address, can be used immediately
//   - not_found       → Clerk returned 404 (user deleted), DLQ as failed
//   - rate_limited    → Clerk returned 429, leave row pending, retry next tick
//   - unreachable     → network error or other transient, count attempts
//
// We deliberately do NOT export a singleton; the worker constructs one
// resolver at startup so tests can inject a fake `getUser`. The cache TTL is
// configurable to keep the surface unit-testable without sleeping.

import type { ClerkClient, User } from '@clerk/backend'
import { isClerkAPIResponseError } from '@clerk/backend/errors'

export type EmailResolution =
  | { kind: 'email'; email: string }
  | { kind: 'not_found' }
  | { kind: 'rate_limited' }
  | { kind: 'unreachable'; error: unknown }

export type ClerkUserFetcher = (clerkUserId: string) => Promise<User>

export interface ClerkResolverOptions {
  getUser: ClerkUserFetcher
  /** TTL for resolved-email cache entries. Default 5 minutes. */
  cacheTtlMs?: number
  /** Override for tests; defaults to Date.now. */
  now?: () => number
}

export interface ClerkResolver {
  resolveEmailForClerkUser(clerkUserId: string): Promise<EmailResolution>
  /** Test/observability helper. Drops every cached entry. */
  clearCache(): void
}

const DEFAULT_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  email: string
  expiresAt: number
}

function pickPrimaryEmail(user: User): string | null {
  const primaryId = user.primaryEmailAddressId
  const list = user.emailAddresses ?? []
  if (primaryId) {
    const match = list.find((entry) => entry.id === primaryId)
    if (match?.emailAddress) return match.emailAddress
  }
  // Fallback: take the first verified address, then the first address at all.
  // Better than refusing to deliver — Clerk users without a primary id are
  // rare but real (legacy imports), and the row's already opted in.
  const verified = list.find((entry) => entry.verification?.status === 'verified')
  if (verified?.emailAddress) return verified.emailAddress
  const first = list[0]
  if (first?.emailAddress) return first.emailAddress
  return null
}

/**
 * Best-effort detection of HTTP-status semantics from a Clerk SDK error. The
 * SDK throws `ClerkAPIResponseError` with a numeric `status`, but we also
 * defensively probe for status fields on the cause to survive SDK shape
 * changes.
 */
function statusFromError(err: unknown): number | null {
  if (isClerkAPIResponseError(err)) {
    const status = (err as unknown as { status?: number }).status
    if (typeof status === 'number') return status
  }
  if (err && typeof err === 'object') {
    const maybe = err as { status?: unknown; statusCode?: unknown }
    if (typeof maybe.status === 'number') return maybe.status
    if (typeof maybe.statusCode === 'number') return maybe.statusCode
  }
  return null
}

export function createClerkResolver(options: ClerkResolverOptions): ClerkResolver {
  const ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, CacheEntry>()

  return {
    async resolveEmailForClerkUser(clerkUserId: string): Promise<EmailResolution> {
      const cached = cache.get(clerkUserId)
      if (cached && cached.expiresAt > now()) {
        return { kind: 'email', email: cached.email }
      }
      // Expired / missing: drop and fall through.
      if (cached) cache.delete(clerkUserId)

      let user: User
      try {
        user = await options.getUser(clerkUserId)
      } catch (err) {
        const status = statusFromError(err)
        if (status === 404) return { kind: 'not_found' }
        if (status === 429) return { kind: 'rate_limited' }
        return { kind: 'unreachable', error: err }
      }

      const email = pickPrimaryEmail(user)
      if (!email) {
        // User exists but has no email at all. Treat as not_found so the
        // notification goes to the DLQ rather than looping forever.
        return { kind: 'not_found' }
      }

      cache.set(clerkUserId, { email, expiresAt: now() + ttl })
      return { kind: 'email', email }
    },
    clearCache(): void {
      cache.clear()
    },
  }
}

/** Adapter so worker.ts can wire a real `ClerkClient` without leaking SDK
 * types into the resolver's call sites. */
export function clerkUserFetcherFromClient(client: ClerkClient): ClerkUserFetcher {
  return (clerkUserId) => client.users.getUser(clerkUserId)
}
