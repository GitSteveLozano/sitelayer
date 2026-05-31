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
import { API_URL, applyTraceHeaders, nextRequestId } from '@/lib/api/client'
import { applyCaptureSessionHeader } from '@/lib/capture-session'

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

export function buildPortalRequestHeaders(initHeaders?: HeadersInit, hasBody = false): Headers {
  const headers = new Headers(initHeaders)
  if (!headers.has('x-request-id')) headers.set('x-request-id', nextRequestId())
  applyTraceHeaders(headers)
  applyCaptureSessionHeader(headers)
  if (!headers.has('content-type') && hasBody) {
    headers.set('content-type', 'application/json; charset=utf-8')
  }
  return headers
}

async function portalRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = buildPortalRequestHeaders(init.headers, Boolean(init.body))
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

export type PortalCaptureSessionResponse = {
  capture_session: {
    id: string
    mode: string
    status: string
    started_at: string
    last_seen_at: string
  }
}

export type PortalCaptureSessionInput = {
  capture_session_id: string
  mode?: 'trace' | 'feedback' | 'desktop' | 'native' | 'manual_upload'
  consent_version?: string
  route_path?: string
  device_kind?: string
  platform?: string
  viewport?: string
  app_build_sha?: string
  metadata?: Record<string, unknown>
  consent_scope?: Record<string, unknown>
  retention_days?: number
}

export type PortalCaptureEventInput = {
  client_event_id?: string
  seq?: number
  event_type: string
  event_class?: string
  route_path?: string
  workflow_id?: string
  entity_type?: string
  entity_id?: string
  occurred_at?: string
  payload?: Record<string, unknown>
}

export function startPortalEstimateCaptureSession(
  shareToken: string,
  payload: PortalCaptureSessionInput,
): Promise<PortalCaptureSessionResponse> {
  return portalRequest<PortalCaptureSessionResponse>(
    `/api/portal/estimates/${encodeURIComponent(shareToken)}/capture-sessions`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function appendPortalEstimateCaptureEvents(
  shareToken: string,
  captureSessionId: string,
  events: PortalCaptureEventInput[],
): Promise<{ accepted: number }> {
  return portalRequest<{ accepted: number }>(
    `/api/portal/estimates/${encodeURIComponent(shareToken)}/capture-sessions/${encodeURIComponent(
      captureSessionId,
    )}/events`,
    {
      method: 'POST',
      body: JSON.stringify({ events }),
    },
  )
}

export function startPortalRentalCaptureSession(
  shareToken: string,
  payload: PortalCaptureSessionInput,
): Promise<PortalCaptureSessionResponse> {
  return portalRequest<PortalCaptureSessionResponse>(
    `/api/portal/rentals/${encodeURIComponent(shareToken)}/capture-sessions`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function appendPortalRentalCaptureEvents(
  shareToken: string,
  captureSessionId: string,
  events: PortalCaptureEventInput[],
): Promise<{ accepted: number }> {
  return portalRequest<{ accepted: number }>(
    `/api/portal/rentals/${encodeURIComponent(shareToken)}/capture-sessions/${encodeURIComponent(captureSessionId)}/events`,
    {
      method: 'POST',
      body: JSON.stringify({ events }),
    },
  )
}

export function fetchPortalEstimate(shareToken: string): Promise<PortalEstimateView> {
  return portalRequest<PortalEstimateView>(`/api/portal/estimates/${encodeURIComponent(shareToken)}`)
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
  return portalRequest<PortalAcceptResponse>(`/api/portal/estimates/${encodeURIComponent(shareToken)}/accept`, {
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
  return portalRequest<PortalDeclineResponse>(`/api/portal/estimates/${encodeURIComponent(shareToken)}/decline`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
