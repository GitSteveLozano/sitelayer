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

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001') as string

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

// Active company slug — set by the shell when the user picks / lands on
// a company. Until Phase 1D.4 wires the picker we default to the API's
// own ACTIVE_COMPANY_SLUG fallback ('la-operations').
let activeCompanySlug: string = (import.meta.env.VITE_DEFAULT_COMPANY_SLUG ?? 'la-operations') as string

export function setActiveCompanySlug(slug: string): void {
  activeCompanySlug = slug
}

export function getActiveCompanySlug(): string {
  return activeCompanySlug
}

function nextRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `web-${crypto.randomUUID()}`
  }
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
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

  if (!options.skipAuth) {
    const slug = options.companySlug ?? activeCompanySlug
    headers.set('x-sitelayer-company-slug', slug)
    try {
      const token = await tokenProvider()
      if (token) headers.set('Authorization', `Bearer ${token}`)
    } catch (err) {
      Sentry.captureException(err, { tags: { scope: 'token_provider' } })
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
  let body: unknown = null
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
