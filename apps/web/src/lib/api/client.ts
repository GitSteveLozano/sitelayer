// Base API client.
//
// Mirrors the v1 (`apps/web/src/api.ts`) wire conventions so the same API
// surface answers both clients during the rebuild:
//   - x-sitelayer-company-slug header on every authenticated call
//   - Authorization: Bearer <clerk-token> when a token provider is wired
//   - x-request-id (UUID) per request for correlation with API + Sentry
// Sentry breadcrumbs are layered on so the request lifecycle shows up in
// session-replay timelines without having to dig through DevTools.
//
// Resource modules (clock.ts, daily-logs.ts, …) wrap `request<T>()` with
// typed function signatures so screens never assemble paths or parse
// payloads directly.

import { Sentry } from '@/instrument'
import { isClerkConfigured } from '@/lib/auth'

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001') as string

/**
 * localStorage key the dev-only RoleSwitcher panel writes to. When this
 * is set AND Clerk is not configured, every outbound request gets a
 * matching `x-sitelayer-act-as` header so the API resolves the user id
 * to the chosen role. The API rejects this header in prod regardless of
 * what's stored locally — see `apps/api/src/auth.ts:resolveActAsOverride`.
 */
export const ACT_AS_STORAGE_KEY = 'sitelayer.act-as'

/**
 * Cached `x-sitelayer-build-sha` header value. The API stamps this on
 * every response (see `apps/api/src/server.ts`); we latch the first
 * value we see and reuse it for the page lifetime so consumers (the
 * estimate-push Probe, future Sentry release tagging, etc.) don't need
 * an extra `/api/version` round-trip. The API guarantees the value
 * doesn't change mid-deploy because the container is restarted on every
 * deploy; if a stale tab sees a different sha after a deploy, the SPA's
 * stale-chunk error boundary will reload before the cached value can
 * mislead a downstream report.
 */
let cachedBuildSha: string | null = null

/**
 * Read the latched build sha. Returns `null` until the first API
 * response has been observed. Probes / Sentry tagging code should fall
 * back to `null` gracefully rather than block on this.
 */
export function getBuildSha(): string | null {
  return cachedBuildSha
}

/**
 * Capture the build sha header off a Response. No-op when the header
 * is missing (CORS misconfig, old API server) or when we already have
 * a cached value. Exposed for tests; production callers go through
 * `request<T>()` which invokes this automatically.
 */
export function captureBuildShaHeader(response: Response): void {
  if (cachedBuildSha) return
  const value = response.headers.get('x-sitelayer-build-sha')
  if (value && value.trim()) cachedBuildSha = value.trim()
}

/** Test-only — reset the latched build sha so each test starts clean. */
export function __resetBuildShaCacheForTests(): void {
  cachedBuildSha = null
}

/**
 * Read the dev act-as override from localStorage. Returns null when:
 *   - we're SSR / not in a browser
 *   - the key isn't set
 *   - the value is an empty string
 *   - localStorage access throws (sandboxed iframes, private mode)
 *
 * The header is only emitted on the wire when `isClerkConfigured()`
 * is false — once a real Clerk publishable key is wired the SPA is
 * meant to use real tokens, and the dev override loses authority.
 */
export function getActAsUserId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(ACT_AS_STORAGE_KEY)
    return value && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly path: string
  readonly method: string
  readonly requestId: string | null
  /** Parsed JSON body when the server returned one; raw string otherwise. */
  readonly body: unknown

  constructor(args: { status: number; path: string; method: string; requestId: string | null; body: unknown }) {
    super(`${args.method} ${args.path} → ${args.status}`)
    this.name = 'ApiError'
    this.status = args.status
    this.path = args.path
    this.method = args.method
    this.requestId = args.requestId
    this.body = args.body
  }

  /** Best-effort human-readable error string. */
  message_for_user(): string {
    if (this.body && typeof this.body === 'object' && 'error' in this.body) {
      const error = (this.body as { error?: unknown }).error
      if (typeof error === 'string') return error
    }
    return `Request failed (${this.status})`
  }
}

export class NetworkError extends Error {
  readonly path: string
  readonly method: string
  constructor(args: { path: string; method: string; cause: unknown }) {
    super(`${args.method} ${args.path} network error`)
    this.name = 'NetworkError'
    this.path = args.path
    this.method = args.method
    if (args.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = args.cause
    }
  }
}

// Token provider — wired once at boot from <App> via useAuth().getToken
// (Phase 1D.4). Returning null means "no signed-in user"; the API rejects
// with 401 when AUTH_ALLOW_HEADER_FALLBACK=0 in prod.
export type TokenProvider = () => Promise<string | null>
let tokenProvider: TokenProvider = async () => null

export function registerTokenProvider(fn: TokenProvider): void {
  tokenProvider = fn
}

/**
 * localStorage key the multi-company switcher writes to. When a user is
 * a member of more than one company they pick which is active via
 * `<CompanySwitcher />`; the selection is persisted here so a full
 * reload (the cheap re-bootstrap the switcher triggers) lands on the
 * chosen tenant. Reads fall back to `VITE_DEFAULT_COMPANY_SLUG` and
 * then to `'la-operations'` so single-company users and ungated dev
 * builds keep working without any storage value.
 */
export const ACTIVE_COMPANY_STORAGE_KEY = 'sitelayer.active-company-slug'

function readStoredActiveCompanySlug(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(ACTIVE_COMPANY_STORAGE_KEY)
    return value && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

const DEFAULT_ACTIVE_COMPANY_SLUG = (import.meta.env.VITE_DEFAULT_COMPANY_SLUG ?? 'la-operations') as string

// Active company slug — set by the shell when the user picks / lands on
// a company, or written via `<CompanySwitcher />` to localStorage. The
// module-state cache is initialised from localStorage (when available)
// so refreshes immediately land on the chosen tenant; the env default
// remains the fallback for single-company users and dev builds.
let activeCompanySlug: string = readStoredActiveCompanySlug() ?? DEFAULT_ACTIVE_COMPANY_SLUG

export function setActiveCompanySlug(slug: string): void {
  activeCompanySlug = slug
}

export function getActiveCompanySlug(): string {
  // Prefer localStorage on every read so a write from the switcher
  // (which calls `window.location.reload()` anyway) is visible to any
  // call that fires before the reload completes. Falls back to the
  // module state, then the env default.
  const stored = readStoredActiveCompanySlug()
  if (stored) return stored
  return activeCompanySlug
}

export function nextRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `web-${crypto.randomUUID()}`
  }
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * Pull the active W3C Sentry trace headers (`sentry-trace` + `baggage`)
 * so every authenticated request to the API joins the SPA's current
 * trace tree. The API mirrors these into `request_context`, the worker
 * lifts them off the outbox row, and the workflow_event_log row keeps
 * the same trace id — meaning a single Sentry trace can be followed
 * from the React button click all the way to the QBO push.
 *
 * Sentry's web SDK is loaded eagerly via `instrument.ts`, but
 * `getTraceData()` legitimately returns an empty object before a trace
 * has been started (early app boot, network calls fired in error
 * boundaries, etc.). In that case we just don't set the headers and
 * the API will start a fresh server-side trace as before. Failures
 * (Sentry not initialized at all when the env DSN is missing) fall
 * through to the empty-object branch via the try/catch.
 */
function readTraceHeaders(): { sentryTrace: string | null; baggage: string | null } {
  try {
    const data = Sentry.getTraceData?.()
    if (!data) return { sentryTrace: null, baggage: null }
    return {
      sentryTrace: data['sentry-trace'] ?? null,
      baggage: data.baggage ?? null,
    }
  } catch {
    return { sentryTrace: null, baggage: null }
  }
}

/**
 * Set `sentry-trace` / `baggage` on `headers` if Sentry has live trace
 * data. Exposed so multipart blueprint uploads (which build their own
 * Headers via `buildAuthHeaders`) share the same propagation path.
 */
export function applyTraceHeaders(headers: Headers): void {
  if (headers.has('sentry-trace')) return
  const { sentryTrace, baggage } = readTraceHeaders()
  if (sentryTrace) headers.set('sentry-trace', sentryTrace)
  if (baggage) headers.set('baggage', baggage)
}

/**
 * Build the auth headers (company slug + Bearer token + request id)
 * that every authenticated call needs. Exposed so the multipart upload
 * helpers can reuse the same plumbing without going through `request()`.
 */
export async function buildAuthHeaders(opts: { companySlug?: string; requestId?: string } = {}): Promise<Headers> {
  const headers = new Headers()
  const slug = opts.companySlug ?? getActiveCompanySlug()
  headers.set('x-sitelayer-company-slug', slug)
  headers.set('x-request-id', opts.requestId ?? nextRequestId())
  // W3C trace context — forwarded on every request so the API +
  // worker + workflow_event_log all share the SPA's trace id.
  applyTraceHeaders(headers)
  try {
    const token = await tokenProvider()
    if (token) headers.set('Authorization', `Bearer ${token}`)
  } catch {
    // The same swallow-and-log behaviour as request() — the API will
    // 401 if it actually needed the token; the registered provider
    // surface in clerk-token-bridge.tsx already reports to Sentry.
  }
  // Dev-only act-as header. Only emitted when Clerk is not configured —
  // once a real publishable key is wired the SPA uses real tokens and
  // this override loses authority on the API side too (auth.ts).
  if (!isClerkConfigured()) {
    const actAs = getActAsUserId()
    if (actAs) headers.set('x-sitelayer-act-as', actAs)
  }
  return headers
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** JSON body — automatically stringified + content-type set. */
  json?: unknown
  /** Skip Authorization header; for the unauth /api/push/vapid-public-key etc. */
  skipAuth?: boolean
  /** Override the company slug for this call. */
  companySlug?: string
  /** Caller-supplied request id, for tying offline-replay traces. */
  requestId?: string
}

/**
 * Type-safe JSON request. Resource modules call this with the parsed
 * response type. Throws ApiError (HTTP failure) or NetworkError (no
 * response) so TanStack Query's error path catches both uniformly.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = String(options.method ?? 'GET').toUpperCase()
  const headers = new Headers(options.headers)
  if (!headers.has('x-request-id')) {
    headers.set('x-request-id', options.requestId ?? nextRequestId())
  }
  const requestId = headers.get('x-request-id')

  // Forward sentry-trace + baggage even on skipAuth public endpoints —
  // the trace context is independent of authentication and the API's
  // root span continues whatever the SPA started.
  applyTraceHeaders(headers)

  if (!options.skipAuth) {
    const slug = options.companySlug ?? getActiveCompanySlug()
    headers.set('x-sitelayer-company-slug', slug)
    try {
      const token = await tokenProvider()
      if (token) headers.set('Authorization', `Bearer ${token}`)
    } catch (err) {
      Sentry.captureException(err, { tags: { scope: 'token_provider' } })
    }
    // See `buildAuthHeaders` — the dev act-as override only travels on
    // the wire when Clerk isn't configured. Setting both a real Bearer
    // token AND the act-as header would be confusing on the API side,
    // and `auth.ts` already prefers Clerk in that path.
    if (!isClerkConfigured()) {
      const actAs = getActAsUserId()
      if (actAs) headers.set('x-sitelayer-act-as', actAs)
    }
  }

  const init: RequestInit = { ...options, method, headers }
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json; charset=utf-8')
    init.body = JSON.stringify(options.json)
  }

  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, init)
  } catch (err) {
    Sentry.addBreadcrumb({
      category: 'api',
      type: 'http',
      level: 'error',
      message: `${method} ${path} network error`,
      data: { method, path, request_id: requestId },
    })
    throw new NetworkError({ path, method, cause: err })
  }

  // Latch the build sha header off the very first response we see. The
  // helper is a no-op once cached so this is cheap on every subsequent
  // request. Done unconditionally (even on 4xx/5xx) because the header
  // travels with error responses too — the SPA wants the sha for
  // diagnostics regardless of status code.
  captureBuildShaHeader(response)

  const responseRequestId = response.headers.get('x-request-id') ?? requestId
  Sentry.addBreadcrumb({
    category: 'api',
    type: 'http',
    level: response.ok ? 'info' : 'warning',
    message: `${method} ${path} ${response.status}`,
    data: { method, path, status: response.status, request_id: responseRequestId },
  })

  // 204 No Content: don't try to parse JSON.
  if (response.status === 204) {
    return undefined as T
  }

  const contentType = response.headers.get('content-type') ?? ''
  let body: unknown
  if (contentType.includes('application/json')) {
    try {
      body = await response.json()
    } catch {
      body = null
    }
  } else {
    try {
      body = await response.text()
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      path,
      method,
      requestId: responseRequestId,
      body,
    })
  }

  return body as T
}

/**
 * Authenticated binary request for image/PDF assets that cannot be loaded
 * directly by <img> / WebGL because those requests cannot attach the
 * Sitelayer company and Clerk/act-as headers. Callers own any object URL
 * lifecycle created from the returned Blob.
 */
export async function requestBlob(path: string, options: Omit<RequestOptions, 'json'> = {}): Promise<Blob> {
  const method = String(options.method ?? 'GET').toUpperCase()
  const headers = new Headers(options.headers)
  if (!headers.has('x-request-id')) {
    headers.set('x-request-id', options.requestId ?? nextRequestId())
  }
  const requestId = headers.get('x-request-id')

  applyTraceHeaders(headers)

  if (!options.skipAuth) {
    const slug = options.companySlug ?? getActiveCompanySlug()
    headers.set('x-sitelayer-company-slug', slug)
    try {
      const token = await tokenProvider()
      if (token) headers.set('Authorization', `Bearer ${token}`)
    } catch (err) {
      Sentry.captureException(err, { tags: { scope: 'token_provider' } })
    }
    if (!isClerkConfigured()) {
      const actAs = getActAsUserId()
      if (actAs) headers.set('x-sitelayer-act-as', actAs)
    }
  }

  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, method, headers })
  } catch (err) {
    Sentry.addBreadcrumb({
      category: 'api',
      type: 'http',
      level: 'error',
      message: `${method} ${path} network error`,
      data: { method, path, request_id: requestId },
    })
    throw new NetworkError({ path, method, cause: err })
  }

  captureBuildShaHeader(response)

  const responseRequestId = response.headers.get('x-request-id') ?? requestId
  Sentry.addBreadcrumb({
    category: 'api',
    type: 'http',
    level: response.ok ? 'info' : 'warning',
    message: `${method} ${path} ${response.status}`,
    data: { method, path, status: response.status, request_id: responseRequestId },
  })

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? ''
    let body: unknown
    if (contentType.includes('application/json')) {
      try {
        body = await response.json()
      } catch {
        body = null
      }
    } else {
      try {
        body = await response.text()
      } catch {
        body = null
      }
    }
    throw new ApiError({
      status: response.status,
      path,
      method,
      requestId: responseRequestId,
      body,
    })
  }

  return response.blob()
}

/**
 * Verb-bound shorthand for `request<T>`. Used by imperative call sites
 * (XState actor invocations, one-off fetches inside event handlers)
 * that can't go through TanStack hooks. The optional `companySlug`
 * pins a non-active company; omit it to use the active slug.
 */
export function apiGet<T>(path: string, companySlug?: string): Promise<T> {
  return request<T>(path, companySlug !== undefined ? { method: 'GET', companySlug } : { method: 'GET' })
}

export function apiPost<T>(path: string, body: unknown, companySlug?: string): Promise<T> {
  return request<T>(
    path,
    companySlug !== undefined ? { method: 'POST', json: body, companySlug } : { method: 'POST', json: body },
  )
}

export function apiPatch<T>(path: string, body: unknown, companySlug?: string): Promise<T> {
  return request<T>(
    path,
    companySlug !== undefined ? { method: 'PATCH', json: body, companySlug } : { method: 'PATCH', json: body },
  )
}

export function apiDelete<T>(path: string, companySlug?: string): Promise<T> {
  return request<T>(path, companySlug !== undefined ? { method: 'DELETE', companySlug } : { method: 'DELETE' })
}
