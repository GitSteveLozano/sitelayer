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
  /** Phase A.4: which takeoff draft the response is scoped to. Null when no draft exists for the project. */
  draft_id: string | null
  lines: EstimateLine[]
}

const KEYS = {
  all: () => ['estimate'] as const,
  scopeVsBid: (projectId: string, draftId: string | null) =>
    [...KEYS.all(), 'scope-vs-bid', projectId, draftId ?? '__default'] as const,
}

export const estimateQueryKeys = KEYS

export function fetchScopeVsBid(projectId: string, draftId: string | null = null): Promise<ScopeVsBidResponse> {
  const qs = draftId ? `?draft_id=${encodeURIComponent(draftId)}` : ''
  return request<ScopeVsBidResponse>(`/api/projects/${encodeURIComponent(projectId)}/estimate/scope-vs-bid${qs}`)
}

export function useScopeVsBid(
  projectId: string | null | undefined,
  options: { draftId?: string | null } & Partial<UseQueryOptions<ScopeVsBidResponse>> = {},
) {
  const { draftId = null, ...queryOptions } = options
  return useQuery<ScopeVsBidResponse>({
    queryKey: KEYS.scopeVsBid(projectId ?? '', draftId),
    queryFn: () => fetchScopeVsBid(projectId!, draftId),
    enabled: Boolean(projectId),
    ...queryOptions,
  })
}

/** Build the estimate PDF download URL. The browser handles auth via
 * the Authorization header on the same fetch — the share sheet uses
 * this for the "Download PDF" action; presigned/streamed via the API.
 * Phase A.4: optional `draftId` scopes the PDF to a specific takeoff
 * draft so the per-draft estimate flows through to the rendered PDF. */
export function estimatePdfUrl(projectId: string, draftId: string | null = null): string {
  const qs = draftId ? `?draft_id=${encodeURIComponent(draftId)}` : ''
  return `${API_URL}/api/projects/${encodeURIComponent(projectId)}/estimate.pdf${qs}`
}
