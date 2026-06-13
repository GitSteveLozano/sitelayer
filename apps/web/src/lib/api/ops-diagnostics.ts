import { apiGet, apiPost } from './client'

export type OpsDiagnosticStatus = 'ok' | 'degraded' | 'unavailable' | 'error' | 'unauthorized'

export type OpsDiagnosticComponent = {
  key: string
  label: string
  status: OpsDiagnosticStatus
  detail: string
  latency_ms: number | null
  facts: Record<string, string | number | boolean | null>
}

export type OpsOnsiteDiagnosticActionKey =
  | 'capture_field_context'
  | 'capture_desktop_context'
  | 'route_support_packet'
  | 'dispatch_agent_review'
export type OpsOnsiteDiagnosticSessionState = 'active' | 'cancelled'
export type OpsOnsiteDiagnosticControlAction = 'extend' | 'cancel' | 'revoke' | 'transfer' | 'redeem'

export type OpsOnsiteDiagnosticAction = {
  key: OpsOnsiteDiagnosticActionKey
  label: string
  enabled: boolean
  reason: string
}

export type OpsOnsiteDiagnosticSessionPlan = {
  status: 'ready' | 'limited' | 'blocked'
  control_level: 'observe' | 'capture' | 'route'
  recommended_entry: OpsOnsiteDiagnosticActionKey
  can_capture_desktop: boolean
  can_route_work: boolean
  can_dispatch_agent_review: boolean
  blockers: string[]
  actions: OpsOnsiteDiagnosticAction[]
}

export type OpsOnsiteDiagnosticAuditEvent = {
  id: string
  at: string
  actor_user_id: string | null
  type: 'session.started' | 'action.requested'
  action_key?: OpsOnsiteDiagnosticActionKey
  client_action_id?: string | null
  effect: 'audit_only'
  summary: string
  action_result?: Record<string, unknown> | null
}

export type OpsOnsiteDiagnosticAgentFeedDelivery = {
  id?: string
  action_key: OpsOnsiteDiagnosticActionKey
  audience: string
  concern_ref: string
  status: 'pending' | 'claimed' | 'succeeded' | 'failed' | 'cancelled'
  queued_at: string
  claimed_at: string | null
  completed_at: string | null
  callback_status: string | null
  callback_error: string | null
  stale: boolean
}

export type OpsOnsiteDiagnosticManifest = {
  schema: 'sitelayer.ops_diagnostic_manifest.v1'
  generated_at: string
  ops_diagnostic_session_id: string
  worker_issue_id: string | null
  capture_session_id: string | null
  support_packet_id: string | null
  context_work_item_id: string | null
  operator_next_step: string
  needs_attention: boolean
  readiness: {
    plan: OpsOnsiteDiagnosticSessionPlan['status']
    control_level: OpsOnsiteDiagnosticSessionPlan['control_level']
    desktop_evidence: 'attached' | 'failed' | 'not_configured' | 'not_captured'
    work_evidence: 'work_item_attached' | 'capture_artifact_only' | 'audit_only'
    agent_handoff: 'not_requested' | 'queued' | 'claimed' | 'succeeded' | 'failed' | 'stale'
  }
  evidence: {
    refs: Array<{ type: string; id: string; path?: string }>
    audit_events_total: number
    latest_action: OpsOnsiteDiagnosticActionKey | null
    desktop_evidence: OpsOnsiteDiagnosticDesktopEvidenceResult | null
  }
  agent_handoff: {
    audiences: string[]
    deliveries: OpsOnsiteDiagnosticAgentFeedDelivery[]
    callback_expected: boolean
    stale: boolean
  }
  consent_receipts: Array<Record<string, unknown>>
  gaps: string[]
}

export type OpsOnsiteDiagnosticSessionRecord = {
  id: string
  state: OpsOnsiteDiagnosticSessionState
  created_at: string
  expires_at: string
  operator_user_id: string | null
  label: string | null
  intent: OpsOnsiteDiagnosticActionKey | null
  worker_issue_id?: string | null
  support_packet_id?: string | null
  context_work_item_id?: string | null
  plan: OpsOnsiteDiagnosticSessionPlan
  audit_events: OpsOnsiteDiagnosticAuditEvent[]
  agent_feed_deliveries?: OpsOnsiteDiagnosticAgentFeedDelivery[]
  desktop_evidence?: OpsOnsiteDiagnosticDesktopEvidenceResult | null
  diagnostic_manifest?: OpsOnsiteDiagnosticManifest
}

export type OpsOnsiteDiagnosticSessionCreateInput = {
  label?: string
  intent?: OpsOnsiteDiagnosticActionKey
}

export type OpsOnsiteDiagnosticSessionCreateResponse = {
  schema: 'sitelayer.ops_diagnostic_session.v1'
  session: OpsOnsiteDiagnosticSessionRecord
  control_token: string
}

export type OpsOnsiteDiagnosticSessionsResponse = {
  schema: 'sitelayer.ops_diagnostic_sessions.v1'
  sessions: OpsOnsiteDiagnosticSessionRecord[]
}

export type OpsOnsiteDiagnosticAgentFeedResult = {
  audience: string
  concern_ref: string
  queued: boolean
  id: string | null
  support_packet_id: string | null
  context_work_item_id: string | null
}

export type OpsOnsiteDiagnosticCaptureRouteResult = {
  request_ref: string
  delivery_id: string
  status: 'accepted' | 'failed' | 'not_configured'
  http_status: number | null
  routed: boolean | null
  accepted: number | null
  error: string | null
}

export type OpsOnsiteDiagnosticDesktopEvidenceResult = {
  capture_session_id: string | null
  artifact_id: string | null
  storage_key: string | null
  file_path: string | null
  status: 'attached' | 'failed' | 'not_configured'
  content_type: string | null
  byte_size: number | null
  error: string | null
}

export type OpsOnsiteDiagnosticActionRequestInput = {
  action_key: OpsOnsiteDiagnosticActionKey
  control_token: string
  client_action_id?: string
}

export type OpsOnsiteDiagnosticSessionActionResponse = {
  schema: 'sitelayer.ops_diagnostic_session_action.v1'
  session: OpsOnsiteDiagnosticSessionRecord
  accepted_action: {
    key: OpsOnsiteDiagnosticActionKey
    effect: 'audit_only'
    desktop_evidence?: OpsOnsiteDiagnosticDesktopEvidenceResult
    capture_route?: OpsOnsiteDiagnosticCaptureRouteResult
    agent_feed?: OpsOnsiteDiagnosticAgentFeedResult
  }
}

export type OpsOnsiteDiagnosticSessionControlInput = {
  action: Exclude<OpsOnsiteDiagnosticControlAction, 'redeem'>
  control_token: string
}

export type OpsOnsiteDiagnosticSessionControlRedeemInput = {
  transfer_token: string
}

export type OpsOnsiteDiagnosticSessionControlResponse = {
  schema: 'sitelayer.ops_diagnostic_session_control.v1'
  session: OpsOnsiteDiagnosticSessionRecord
  control: {
    action: OpsOnsiteDiagnosticControlAction
    expires_at: string
    control_token?: string
    transfer_token?: string
  }
}

export type OpsDiagnosticsResponse = {
  schema: 'sitelayer.ops_diagnostics.v1'
  generated_at: string
  status: OpsDiagnosticStatus
  summary: {
    total: number
    ok: number
    degraded: number
    unavailable: number
    error: number
  }
  components: OpsDiagnosticComponent[]
  onsite_session: OpsOnsiteDiagnosticSessionPlan
}

export function fetchOpsDiagnostics(companySlug?: string): Promise<OpsDiagnosticsResponse> {
  return apiGet<OpsDiagnosticsResponse>('/api/ops/diagnostics', companySlug)
}

export function fetchOpsDiagnosticSessions(companySlug?: string): Promise<OpsOnsiteDiagnosticSessionsResponse> {
  return apiGet<OpsOnsiteDiagnosticSessionsResponse>('/api/ops/diagnostics/sessions', companySlug)
}

export function createOpsDiagnosticSession(
  companySlug?: string,
  input: OpsOnsiteDiagnosticSessionCreateInput = {},
): Promise<OpsOnsiteDiagnosticSessionCreateResponse> {
  return apiPost<OpsOnsiteDiagnosticSessionCreateResponse>('/api/ops/diagnostics/sessions', input, companySlug)
}

export function requestOpsDiagnosticSessionAction(
  sessionId: string,
  input: OpsOnsiteDiagnosticActionRequestInput,
  companySlug?: string,
): Promise<OpsOnsiteDiagnosticSessionActionResponse> {
  return apiPost<OpsOnsiteDiagnosticSessionActionResponse>(
    `/api/ops/diagnostics/sessions/${encodeURIComponent(sessionId)}/actions`,
    input,
    companySlug,
  )
}

export function controlOpsDiagnosticSession(
  sessionId: string,
  input: OpsOnsiteDiagnosticSessionControlInput,
  companySlug?: string,
): Promise<OpsOnsiteDiagnosticSessionControlResponse> {
  return apiPost<OpsOnsiteDiagnosticSessionControlResponse>(
    `/api/ops/diagnostics/sessions/${encodeURIComponent(sessionId)}/control`,
    input,
    companySlug,
  )
}

export function redeemOpsDiagnosticControlTransfer(
  sessionId: string,
  input: OpsOnsiteDiagnosticSessionControlRedeemInput,
  companySlug?: string,
): Promise<OpsOnsiteDiagnosticSessionControlResponse> {
  return apiPost<OpsOnsiteDiagnosticSessionControlResponse>(
    `/api/ops/diagnostics/sessions/${encodeURIComponent(sessionId)}/control/redeem`,
    input,
    companySlug,
  )
}
