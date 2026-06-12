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
  effect: 'audit_only'
  summary: string
}

export type OpsOnsiteDiagnosticSessionRecord = {
  id: string
  state: 'active'
  created_at: string
  expires_at: string
  operator_user_id: string | null
  label: string | null
  intent: OpsOnsiteDiagnosticActionKey | null
  plan: OpsOnsiteDiagnosticSessionPlan
  audit_events: OpsOnsiteDiagnosticAuditEvent[]
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

export type OpsOnsiteDiagnosticAgentFeedResult = {
  audience: string
  concern_ref: string
  queued: boolean
  id: string | null
}

export type OpsOnsiteDiagnosticActionRequestInput = {
  action_key: OpsOnsiteDiagnosticActionKey
  control_token: string
}

export type OpsOnsiteDiagnosticSessionActionResponse = {
  schema: 'sitelayer.ops_diagnostic_session_action.v1'
  session: OpsOnsiteDiagnosticSessionRecord
  accepted_action: {
    key: OpsOnsiteDiagnosticActionKey
    effect: 'audit_only'
    agent_feed?: OpsOnsiteDiagnosticAgentFeedResult
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
