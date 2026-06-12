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
}

export function fetchOpsDiagnostics(companySlug?: string): Promise<OpsDiagnosticsResponse> {
  return apiGet<OpsDiagnosticsResponse>('/api/ops/diagnostics', companySlug)
}
