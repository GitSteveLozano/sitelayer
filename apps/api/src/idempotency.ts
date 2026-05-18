/**
 * Per-process Idempotency-Key cache for POST routes that create entities.
 *
 * Why this exists:
 *   Naive client retries (network blip, mobile flap, "double-tap" on the
 *   foreman tablet) can double-create rows. The API computes its own internal
 *   idempotency keys for the outbox (`customer:create:<uuid>`) but the HTTP
 *   layer didn't honor an `Idempotency-Key` request header. This module fills
 *   that gap: same `(company_id, key)` within the TTL returns the cached
 *   `{ status, body }` byte-identical to the original response.
 *
 * Scope / non-goals:
 *   - In-memory only. A multi-worker deploy could re-process a request that
 *     landed on a different worker. Pilot runs a single API container so this
 *     is sufficient. When we scale out, swap the Map for Redis behind the same
 *     `IdempotencyCache` shape.
 *   - Only entity-creation POSTs are wired (customers, workers, material
 *     bills, qbo-mappings, projects, pricing-profiles, bonus-rules, service
 *     items, etc.). Workflow event POSTs (`/events`) are skipped — they're
 *     already idempotent via `state_version`. Webhooks (`/api/webhooks/*`)
 *     have their own dedup paths.
 *   - TTL is 15 minutes by default. Long enough for the typical retry window
 *     (mobile reconnects, exponential backoff queues) and short enough to
 *     bound memory on long-lived processes.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000
const MAX_KEY_LENGTH = 255

export type IdempotencyCachedResponse = {
  status: number
  body: unknown
}

type CacheEntry = {
  expiresAt: number
  response: IdempotencyCachedResponse
}

export type IdempotencyCache = {
  /** Look up a cached response. Returns null on miss or after expiry. */
  get(companyId: string, key: string): IdempotencyCachedResponse | null
  /** Cache a response under the given key. */
  set(companyId: string, key: string, response: IdempotencyCachedResponse): void
  /** Force-evict everything. Test-only helper. */
  clear(): void
  /** Current entry count. Exposed for observability/tests. */
  size(): number
}

export function createIdempotencyCache(ttlMs: number = DEFAULT_TTL_MS): IdempotencyCache {
  const entries = new Map<string, CacheEntry>()

  function compositeKey(companyId: string, key: string): string {
    return `${companyId}:${key}`
  }

  // Lazy eviction: prune on every read/write of a stale key. Avoids the
  // overhead of a setInterval timer that would keep the process alive past
  // shutdown and would need explicit unref logic in worker tests.
  function evictExpired(now: number): void {
    for (const [k, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(k)
    }
  }

  return {
    get(companyId, key) {
      const now = Date.now()
      const composite = compositeKey(companyId, key)
      const entry = entries.get(composite)
      if (!entry) return null
      if (entry.expiresAt <= now) {
        entries.delete(composite)
        return null
      }
      return entry.response
    },
    set(companyId, key, response) {
      const now = Date.now()
      // Prune opportunistically when the table is non-trivial so a long
      // session doesn't accumulate dead entries forever.
      if (entries.size > 1000) evictExpired(now)
      entries.set(compositeKey(companyId, key), {
        expiresAt: now + ttlMs,
        response,
      })
    },
    clear() {
      entries.clear()
    },
    size() {
      return entries.size
    },
  }
}

export type IdempotencyKeyValidation = { ok: true; key: string } | { ok: false; error: string }

/**
 * Validate an Idempotency-Key header value. Rejects arrays (duplicate
 * headers), non-strings, empty/whitespace-only, and >255 chars. Returns the
 * trimmed canonical form on success.
 */
export function validateIdempotencyKey(raw: string | string[] | undefined): IdempotencyKeyValidation {
  if (raw === undefined) return { ok: false, error: 'missing' }
  if (Array.isArray(raw)) {
    return { ok: false, error: 'Idempotency-Key header must not be repeated' }
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Idempotency-Key header must be a string' }
  }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'Idempotency-Key header must not be empty' }
  if (trimmed.length > MAX_KEY_LENGTH) {
    return { ok: false, error: `Idempotency-Key header must be ${MAX_KEY_LENGTH} characters or fewer` }
  }
  return { ok: true, key: trimmed }
}

/**
 * Decide whether a given POST path should participate in HTTP-layer
 * idempotency. Workflow event endpoints are skipped (they have their own
 * `state_version` gate) and webhook endpoints are skipped (provider-specific
 * dedup).
 *
 * The pilot wiring is opt-in by path so we don't inadvertently cache reads
 * or non-creation actions that callers expect to re-trigger.
 */
export function isIdempotentPostPath(pathname: string): boolean {
  // Never apply to workflow event endpoints — they're already idempotent
  // via the reducer + state_version optimistic check.
  if (/\/events$/.test(pathname)) return false
  // Never apply to webhooks. They authenticate via signature and have their
  // own provider-side dedup (svix / Intuit replay window).
  if (pathname.startsWith('/api/webhooks/')) return false

  // CREATE-style POSTs: the body-validation agent already inventoried these.
  // Exact path equality only — sub-paths like `/api/projects/:id/something`
  // are handled by the path-with-id branch below.
  const exactCreates = new Set<string>([
    '/api/companies',
    '/api/customers',
    '/api/workers',
    '/api/projects',
    '/api/pricing-profiles',
    '/api/bonus-rules',
    '/api/service-items',
    '/api/divisions',
    '/api/labor-entries',
    '/api/material-bills',
    '/api/inventory-items',
    '/api/inventory-locations',
    '/api/inventory-movements',
    '/api/rentals',
    '/api/rental-contracts',
    '/api/job-rental-lines',
    '/api/rental-billing-runs',
    '/api/scaffold-tags',
    '/api/damage-charges',
    '/api/shipments',
    '/api/notification-preferences',
    '/api/push-subscriptions',
    '/api/integrations/qbo/mappings',
    '/api/integrations/qbo/custom-fields',
    '/api/qbo-custom-fields',
    '/api/companycam/links',
    '/api/customer-portal-links',
    '/api/ai-insights',
    '/api/audit-events',
    '/api/notifications',
    '/api/assemblies',
    '/api/takeoff-tags',
    '/api/takeoff-drafts',
    '/api/blueprint-pages',
    '/api/scaffold-ops',
    '/api/companies/:id/memberships'.replace(':id', ''),
  ])
  if (exactCreates.has(pathname)) return true

  // POST /api/companies/:id/memberships
  if (/^\/api\/companies\/[^/]+\/memberships$/.test(pathname)) return true

  // POST /api/projects/:id/<subresource> creators (blueprints, takeoff
  // drafts, takeoff measurements set, rental contracts, material bills,
  // brief, daily-logs, assignments).
  if (
    /^\/api\/projects\/[^/]+\/(blueprints|takeoff-drafts|material-bills|rental-contracts|briefs?|daily-logs|assignments|takeoff\/measurements?|estimate\/share)$/.test(
      pathname,
    )
  ) {
    return true
  }

  // POST /api/blueprints/:id/versions — new blueprint revision (creates a row).
  if (/^\/api\/blueprints\/[^/]+\/versions$/.test(pathname)) return true

  return false
}
