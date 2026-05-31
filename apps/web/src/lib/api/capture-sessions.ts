import {
  clearLocalCaptureSession,
  currentCaptureRoutePath,
  ensureLocalCaptureSession,
  startLocalCaptureSession,
  type CaptureSessionMode,
} from '@/lib/capture-session'
import { request } from './client'

export type CaptureSessionResponse = {
  capture_session: {
    id: string
    mode: string
    status: string
    started_at: string
    last_seen_at: string
  }
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

export async function stopCaptureSession(captureSessionId: string): Promise<CaptureSessionResponse> {
  const response = await request<CaptureSessionResponse>(`/api/capture-sessions/${captureSessionId}`, {
    method: 'PATCH',
    json: { status: 'stopped', route_path: currentCaptureRoutePath() },
  })
  clearLocalCaptureSession()
  return response
}

export async function discardCaptureSession(captureSessionId: string): Promise<CaptureSessionResponse> {
  const response = await request<CaptureSessionResponse>(`/api/capture-sessions/${captureSessionId}`, {
    method: 'PATCH',
    json: { status: 'discarded', route_path: currentCaptureRoutePath() },
  })
  clearLocalCaptureSession()
  return response
}
