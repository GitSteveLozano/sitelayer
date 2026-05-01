// Estimate — types + hooks for the prj-detail Estimate sub-tab and the
// 2C est-summary / est-share / est-sent screens.
// Wraps GET /api/projects/:id/estimate/scope-vs-bid +
// GET /api/projects/:id/estimate.pdf.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { API_URL, request } from './client'

export type BidVsScopeStatus = 'ok' | 'warn' | 'mismatch'

export interface EstimateLine {
  service_item_code: string
  quantity: string
  unit: string
  rate: string
  amount: string
  division_code: string | null
  created_at: string
}

export interface ScopeVsBidResponse {
  bid_total: number
  scope_total: number
  delta: number
  delta_pct: number
  status: BidVsScopeStatus
  lines: EstimateLine[]
}

const KEYS = {
  all: () => ['estimate'] as const,
  scopeVsBid: (projectId: string) => [...KEYS.all(), 'scope-vs-bid', projectId] as const,
}

export const estimateQueryKeys = KEYS

export function fetchScopeVsBid(projectId: string): Promise<ScopeVsBidResponse> {
  return request<ScopeVsBidResponse>(`/api/projects/${encodeURIComponent(projectId)}/estimate/scope-vs-bid`)
}

export function useScopeVsBid(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<ScopeVsBidResponse>>,
) {
  return useQuery<ScopeVsBidResponse>({
    queryKey: KEYS.scopeVsBid(projectId ?? ''),
    queryFn: () => fetchScopeVsBid(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

/** Build the estimate PDF download URL. The browser handles auth via
 * the Authorization header on the same fetch — the share sheet uses
 * this for the "Download PDF" action; presigned/streamed via the API. */
export function estimatePdfUrl(projectId: string): string {
  return `${API_URL}/api/projects/${encodeURIComponent(projectId)}/estimate.pdf`
}
