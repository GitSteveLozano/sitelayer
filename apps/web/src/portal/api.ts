/**
 * Portal API client — talks to the unauthenticated /portal/estimates/*
 * routes from the public client portal. Distinct from the rest of
 * `apps/web/src/lib/api/` because:
 *
 *   - No Clerk JWT (the customer is not signed in)
 *   - No x-sitelayer-company-slug header (the share token already
 *     resolves to a tenant on the server side)
 *   - No request-level auth concerns at all — fetch is enough
 *
 * Errors are surfaced as `PortalApiError` so the screen layer can
 * render distinct copy for invalid token (401), expired (410), and
 * already-accepted/declined (409).
 */
import { API_URL } from '@/lib/api/client'

export class PortalApiError extends Error {
  readonly status: number
  readonly path: string
  readonly body: unknown
  constructor(args: { status: number; path: string; body: unknown }) {
    super(`portal ${args.path} → ${args.status}`)
    this.name = 'PortalApiError'
    this.status = args.status
    this.path = args.path
    this.body = args.body
  }
  message_for_user(): string {
    if (this.status === 401) return "This link isn't valid."
    if (this.status === 404) return 'This estimate could not be found.'
    if (this.status === 410) return 'This link has expired.'
    if (this.body && typeof this.body === 'object' && 'error' in this.body) {
      const e = (this.body as { error?: unknown }).error
      if (typeof e === 'string') return e
    }
    return 'Something went wrong. Please try again.'
  }
}

export type PortalEstimateLine = {
  service_item_code: string
  quantity: number
  unit: string
  rate: number
  amount: number
  division_code: string | null
}

export type PortalEstimateSnapshot = {
  bid_total: number
  scope_total: number
  lines: PortalEstimateLine[]
  captured_at: string
}

export type PortalEstimateView = {
  id: string
  project_name: string
  company_name: string
  recipient_email: string | null
  recipient_name: string | null
  sent_at: string
  expires_at: string
  status: 'pending' | 'accepted' | 'declined' | 'expired'
  estimate: PortalEstimateSnapshot
  accepted_at: string | null
  declined_at: string | null
  decline_reason: string | null
  signer_name: string | null
}

async function portalRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json; charset=utf-8')
  }
  const response = await fetch(`${API_URL}${path}`, { ...init, headers })
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
  if (response.status === 204) return undefined as T
  if (!response.ok) {
    throw new PortalApiError({ status: response.status, path, body })
  }
  return body as T
}

export function fetchPortalEstimate(shareToken: string): Promise<PortalEstimateView> {
  return portalRequest<PortalEstimateView>(`/portal/estimates/${encodeURIComponent(shareToken)}`)
}

export type PortalAcceptResponse = {
  ok: true
  accepted_at: string
  signer_name: string
  idempotent: boolean
}

export function postPortalAccept(
  shareToken: string,
  payload: { signer_name: string; signature_data_url: string },
): Promise<PortalAcceptResponse> {
  return portalRequest<PortalAcceptResponse>(`/portal/estimates/${encodeURIComponent(shareToken)}/accept`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type PortalDeclineResponse = {
  ok: true
  declined_at: string
  decline_reason: string
  idempotent: boolean
}

export function postPortalDecline(
  shareToken: string,
  payload: { decline_reason: string },
): Promise<PortalDeclineResponse> {
  return portalRequest<PortalDeclineResponse>(`/portal/estimates/${encodeURIComponent(shareToken)}/decline`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
