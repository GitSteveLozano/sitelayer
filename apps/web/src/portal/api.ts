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
import type {
  CaptureArtifactUploadInput,
  CaptureArtifactUploadResponse,
  CaptureFinalizeInput,
  CaptureFinalizeResponse,
} from '@/lib/api/capture-sessions'

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

export type FeedbackInviteView = {
  id: string
  company_slug: string
  company_name: string
  reviewer_ref: string
  source: string
  target_route: string | null
  allowed_capture_modes: Array<'text' | 'audio' | 'screen' | 'trace' | 'state'>
  expires_at: string
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

function fileNameForPortalArtifact(kind: string, file: Blob, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim()
  if (typeof File !== 'undefined' && file instanceof File && file.name.trim()) return file.name.trim()
  switch (kind) {
    case 'audio':
      return 'audio.webm'
    case 'video':
      return 'screen-video.webm'
    case 'rrweb':
      return 'replay.json'
    case 'canvas_geometry':
      return 'canvas-geometry.json'
    case 'transcript':
      return 'transcript.txt'
    default:
      return 'capture-artifact.bin'
  }
}

async function portalCaptureArtifactUploadRequest(
  path: string,
  input: CaptureArtifactUploadInput,
  initHeaders?: HeadersInit,
): Promise<CaptureArtifactUploadResponse> {
  const form = new FormData()
  form.append('kind', input.kind)
  if (input.duration_ms !== undefined) form.append('duration_ms', String(Math.max(0, Math.trunc(input.duration_ms))))
  if (input.pii_level) form.append('pii_level', input.pii_level)
  if (input.access_policy) form.append('access_policy', input.access_policy)
  if (input.metadata) form.append('metadata', JSON.stringify(input.metadata))
  form.append('file', input.file, fileNameForPortalArtifact(input.kind, input.file, input.fileName))

  const headers = buildPortalRequestHeaders(initHeaders, false)
  const response = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: form })
  const contentType = response.headers.get('content-type') ?? ''
  let body: unknown
  try {
    body = contentType.includes('application/json') ? await response.json() : await response.text()
  } catch {
    body = null
  }
  if (!response.ok) {
    throw new PortalApiError({ status: response.status, path, body })
  }
  return body as CaptureArtifactUploadResponse
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

export function resolveFeedbackInvite(token: string): Promise<{ invite: FeedbackInviteView }> {
  return portalRequest<{ invite: FeedbackInviteView }>('/api/portal/feedback-invites/resolve', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

export function startFeedbackInviteCaptureSession(
  token: string,
  payload: PortalCaptureSessionInput,
): Promise<PortalCaptureSessionResponse> {
  return portalRequest<PortalCaptureSessionResponse>('/api/portal/feedback-invites/capture-sessions', {
    method: 'POST',
    body: JSON.stringify({ ...payload, token }),
  })
}

export function appendFeedbackInviteCaptureEvents(
  token: string,
  captureSessionId: string,
  events: PortalCaptureEventInput[],
): Promise<{ accepted: number }> {
  return portalRequest<{ accepted: number }>(
    `/api/portal/feedback-invites/capture-sessions/${encodeURIComponent(captureSessionId)}/events`,
    {
      method: 'POST',
      body: JSON.stringify({ token, events }),
    },
  )
}

export function finalizeFeedbackInviteCaptureSession(
  token: string,
  captureSessionId: string,
  input: CaptureFinalizeInput,
): Promise<CaptureFinalizeResponse> {
  return portalRequest<CaptureFinalizeResponse>(
    `/api/portal/feedback-invites/capture-sessions/${encodeURIComponent(captureSessionId)}/finalize`,
    {
      method: 'POST',
      body: JSON.stringify({ ...input, token }),
    },
  )
}

export function discardFeedbackInviteCaptureSession(token: string, captureSessionId: string): Promise<{ ok: true }> {
  return portalRequest<{ ok: true }>(
    `/api/portal/feedback-invites/capture-sessions/${encodeURIComponent(captureSessionId)}/discard`,
    {
      method: 'POST',
      body: JSON.stringify({ token }),
    },
  )
}

export function uploadFeedbackInviteCaptureArtifact(
  token: string,
  captureSessionId: string,
  input: CaptureArtifactUploadInput,
): Promise<CaptureArtifactUploadResponse> {
  return portalCaptureArtifactUploadRequest(
    `/api/portal/feedback-invites/capture-sessions/${encodeURIComponent(captureSessionId)}/artifacts/upload`,
    input,
    { 'x-sitelayer-feedback-invite': token },
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

export function uploadPortalEstimateCaptureArtifact(
  shareToken: string,
  captureSessionId: string,
  input: CaptureArtifactUploadInput,
): Promise<CaptureArtifactUploadResponse> {
  return portalCaptureArtifactUploadRequest(
    `/api/portal/estimates/${encodeURIComponent(shareToken)}/capture-sessions/${encodeURIComponent(
      captureSessionId,
    )}/artifacts/upload`,
    input,
  )
}

export function finalizePortalEstimateCaptureSession(
  shareToken: string,
  captureSessionId: string,
  input: CaptureFinalizeInput = {},
): Promise<CaptureFinalizeResponse> {
  return portalRequest<CaptureFinalizeResponse>(
    `/api/portal/estimates/${encodeURIComponent(shareToken)}/capture-sessions/${encodeURIComponent(
      captureSessionId,
    )}/finalize`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
}

export function discardPortalEstimateCaptureSession(
  shareToken: string,
  captureSessionId: string,
): Promise<PortalCaptureSessionResponse> {
  return portalRequest<PortalCaptureSessionResponse>(
    `/api/portal/estimates/${encodeURIComponent(shareToken)}/capture-sessions/${encodeURIComponent(
      captureSessionId,
    )}/discard`,
    {
      method: 'POST',
      body: JSON.stringify({}),
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

export function uploadPortalRentalCaptureArtifact(
  shareToken: string,
  captureSessionId: string,
  input: CaptureArtifactUploadInput,
): Promise<CaptureArtifactUploadResponse> {
  return portalCaptureArtifactUploadRequest(
    `/api/portal/rentals/${encodeURIComponent(shareToken)}/capture-sessions/${encodeURIComponent(
      captureSessionId,
    )}/artifacts/upload`,
    input,
  )
}

export function finalizePortalRentalCaptureSession(
  shareToken: string,
  captureSessionId: string,
  input: CaptureFinalizeInput = {},
): Promise<CaptureFinalizeResponse> {
  return portalRequest<CaptureFinalizeResponse>(
    `/api/portal/rentals/${encodeURIComponent(shareToken)}/capture-sessions/${encodeURIComponent(captureSessionId)}/finalize`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
}

export function discardPortalRentalCaptureSession(
  shareToken: string,
  captureSessionId: string,
): Promise<PortalCaptureSessionResponse> {
  return portalRequest<PortalCaptureSessionResponse>(
    `/api/portal/rentals/${encodeURIComponent(shareToken)}/capture-sessions/${encodeURIComponent(captureSessionId)}/discard`,
    {
      method: 'POST',
      body: JSON.stringify({}),
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
