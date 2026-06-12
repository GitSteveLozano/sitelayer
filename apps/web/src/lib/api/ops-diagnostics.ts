import { apiGet } from './client'

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
