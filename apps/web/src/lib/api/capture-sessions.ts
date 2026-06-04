import {
  clearLocalCaptureSession,
  currentCaptureRoutePath,
  ensureLocalCaptureSession,
  getActiveCaptureSessionId,
  startLocalCaptureSession,
  type CaptureSessionMode,
} from '@/lib/capture-session'
import { API_URL, ApiError, buildAuthHeaders, request } from './client'

export type CaptureSessionResponse = {
  capture_session: {
    id: string
    mode: string
    status: string
    started_at: string
    last_seen_at: string
  }
}

export type CaptureSessionDetailResponse = CaptureSessionResponse & {
  event_count: number
  artifact_count: number
}

export type CaptureSessionEventInput = {
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

export type CaptureSessionCreateInput = {
  capture_session_id: string
  mode?: CaptureSessionMode
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

export type CaptureArtifactInput = {
  kind: string
  storage_key?: string
  uri?: string
  content_type?: string
  byte_size?: number
  content_hash?: string
  duration_ms?: number
  pii_level?: 'low' | 'internal' | 'private' | 'restricted'
  access_policy?: 'support_only' | 'operator_only' | 'tenant_visible'
  metadata?: Record<string, unknown>
  retention_expires_at?: string
}

export type CaptureArtifactUploadInput = {
  kind: string
  file: Blob
  fileName?: string
  duration_ms?: number
  pii_level?: CaptureArtifactInput['pii_level']
  access_policy?: CaptureArtifactInput['access_policy']
  metadata?: Record<string, unknown>
}

export type CaptureArtifactUploadResponse = {
  artifact: {
    id: string | null
    kind: string
    storage_key: string
    content_type: string
    byte_size: number
    content_hash: string
    redaction_version: string
  }
}

export type CaptureFinalizeInput = {
  title?: string
  summary?: string
  problem?: string
  lane?: string
  severity?: string | null
  route_path?: string
  route?: string
  category?: string
  client_request_id?: string
}

export type CaptureFinalizeResponse = {
  work_item: {
    id: string
    title: string
    summary: string
    status: string
    lane: string
    severity: string | null
    route: string | null
    capture_session_id: string | null
  }
  support_packet: {
    id: string
    expires_at: string | null
  }
  event: unknown | null
  idempotent_replay?: true
}

export type CaptureSessionDiscardInput = {
  metadata?: Record<string, unknown>
}

function clearLocalCaptureSessionIfCurrent(captureSessionId: string): void {
  if (getActiveCaptureSessionId() === captureSessionId) clearLocalCaptureSession()
}

function fileNameForArtifact(kind: string, file: Blob, explicit?: string): string {
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

async function parseMultipartError(response: Response, path: string): Promise<ApiError> {
  const requestId = response.headers.get('x-request-id')
  let body: unknown
  try {
    const ct = response.headers.get('content-type') ?? ''
    body = ct.includes('application/json') ? await response.json() : await response.text()
  } catch {
    body = null
  }
  return new ApiError({ status: response.status, path, method: 'POST', requestId, body })
}

export async function startCaptureSession(
  args: {
    mode?: CaptureSessionMode
    consent_version?: string
    metadata?: Record<string, unknown>
  } = {},
): Promise<CaptureSessionResponse> {
  const local = startLocalCaptureSession(args)
  return request<CaptureSessionResponse>('/api/capture-sessions', {
    method: 'POST',
    json: {
      capture_session_id: local.id,
      mode: local.mode,
      consent_version: local.consent_version,
      route_path: currentCaptureRoutePath(),
      metadata: args.metadata ?? {},
    },
  })
}

export async function createCaptureSession(input: CaptureSessionCreateInput): Promise<CaptureSessionResponse> {
  return request<CaptureSessionResponse>('/api/capture-sessions', {
    method: 'POST',
    json: {
      route_path: currentCaptureRoutePath(),
      ...input,
    },
  })
}

export async function ensureCaptureSession(
  args: {
    mode?: CaptureSessionMode
    consent_version?: string
    metadata?: Record<string, unknown>
  } = {},
): Promise<CaptureSessionResponse> {
  const local = ensureLocalCaptureSession(args)
  return request<CaptureSessionResponse>('/api/capture-sessions', {
    method: 'POST',
    json: {
      capture_session_id: local.id,
      mode: local.mode,
      consent_version: local.consent_version,
      route_path: currentCaptureRoutePath(),
      metadata: args.metadata ?? {},
    },
  })
}

export async function appendCaptureSessionEvents(
  captureSessionId: string,
  events: CaptureSessionEventInput[],
): Promise<{ accepted: number }> {
  return request<{ accepted: number }>(`/api/capture-sessions/${captureSessionId}/events`, {
    method: 'POST',
    json: { events },
  })
}

export async function appendCaptureArtifacts(
  captureSessionId: string,
  artifacts: CaptureArtifactInput[],
): Promise<{ accepted: number }> {
  return request<{ accepted: number }>(`/api/capture-sessions/${captureSessionId}/artifacts`, {
    method: 'POST',
    json: { artifacts },
  })
}

export async function fetchCaptureSession(captureSessionId: string): Promise<CaptureSessionDetailResponse> {
  return request<CaptureSessionDetailResponse>(`/api/capture-sessions/${captureSessionId}`)
}

/**
 * Upload one binary capture artifact (mic audio, browser replay JSON, native
 * video, etc.) into the durable capture artifact store. The server requires
 * the `kind` field before the file part, so this appends all metadata first
 * and leaves the browser to set the multipart boundary.
 */
export async function uploadCaptureArtifact(
  captureSessionId: string,
  input: CaptureArtifactUploadInput,
): Promise<CaptureArtifactUploadResponse> {
  const form = new FormData()
  form.append('kind', input.kind)
  if (input.duration_ms !== undefined) form.append('duration_ms', String(Math.max(0, Math.trunc(input.duration_ms))))
  if (input.pii_level) form.append('pii_level', input.pii_level)
  if (input.access_policy) form.append('access_policy', input.access_policy)
  if (input.metadata) form.append('metadata', JSON.stringify(input.metadata))
  form.append('file', input.file, fileNameForArtifact(input.kind, input.file, input.fileName))

  const headers = await buildAuthHeaders()
  const path = `/api/capture-sessions/${encodeURIComponent(captureSessionId)}/artifacts/upload`
  const response = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: form })
  if (!response.ok) throw await parseMultipartError(response, path)
  return (await response.json()) as CaptureArtifactUploadResponse
}

export async function stopCaptureSession(captureSessionId: string): Promise<CaptureSessionResponse> {
  const response = await request<CaptureSessionResponse>(`/api/capture-sessions/${captureSessionId}`, {
    method: 'PATCH',
    json: { status: 'stopped', route_path: currentCaptureRoutePath() },
  })
  clearLocalCaptureSessionIfCurrent(captureSessionId)
  return response
}

export async function discardCaptureSession(
  captureSessionId: string,
  input: CaptureSessionDiscardInput = {},
): Promise<CaptureSessionResponse> {
  const response = await request<CaptureSessionResponse>(`/api/capture-sessions/${captureSessionId}`, {
    method: 'PATCH',
    json: {
      status: 'discarded',
      route_path: currentCaptureRoutePath(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  })
  clearLocalCaptureSessionIfCurrent(captureSessionId)
  return response
}

export async function finalizeCaptureSession(
  captureSessionId: string,
  input: CaptureFinalizeInput = {},
): Promise<CaptureFinalizeResponse> {
  const response = await request<CaptureFinalizeResponse>(`/api/capture-sessions/${captureSessionId}/finalize`, {
    method: 'POST',
    json: { route_path: currentCaptureRoutePath(), ...input },
  })
  clearLocalCaptureSessionIfCurrent(captureSessionId)
  return response
}
