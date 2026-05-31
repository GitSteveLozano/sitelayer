// Estimate — types + hooks for the prj-detail Estimate sub-tab and the
// 2C est-summary / est-share / est-sent screens.
// Wraps GET /api/projects/:id/estimate/scope-vs-bid +
// GET /api/projects/:id/estimate.pdf.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { API_URL, request } from './client'

export type BidVsScopeStatus = 'ok' | 'warn' | 'mismatch'

export interface EstimateLine {
  /** estimate_lines.id — present on scope-vs-bid responses; the target for PATCH /api/estimate-lines/:id. */
  id: string
  service_item_code: string
  quantity: string
  unit: string
  rate: string
  amount: string
  division_code: string | null
  created_at: string
  /**
   * PlanSwift Phase 2 provenance — when this line was produced by exploding an
   * assembly-attached measurement, these identify the source assembly +
   * component + cost kind so the estimate UI can group exploded lines under a
   * collapsible parent. NULL/absent on hand/flat lines.
   */
  assembly_id?: string | null
  assembly_component_id?: string | null
  kind?: 'material' | 'labor' | 'sub' | 'freight' | null
}

export interface UpdateEstimateLineInput {
  /** New quantity. Omit to leave unchanged. */
  quantity?: number
  /** New unit rate. Omit to leave unchanged. */
  rate?: number
  /**
   * Optimistic guard: the `amount` the client last saw for this line.
   * On mismatch the API returns 409 so the caller can reload. Omit to
   * opt out of the guard.
   */
  expected_amount?: number
}

export interface UpdateEstimateLineResponse {
  line: EstimateLine
  scope_vs_bid: ScopeVsBidResponse
}

/**
 * PATCH /api/estimate-lines/:id — edit one estimate line's quantity/rate
 * in place. Returns the updated line plus the refreshed scope-vs-bid
 * snapshot for the line's draft so callers can repaint totals in one hop.
 */
export function updateEstimateLine(
  lineId: string,
  input: UpdateEstimateLineInput,
): Promise<UpdateEstimateLineResponse> {
  return request<UpdateEstimateLineResponse>(`/api/estimate-lines/${encodeURIComponent(lineId)}`, {
    method: 'PATCH',
    json: input,
  })
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

export interface RepriceMarginResponse {
  project_id: string
  target_margin_pct: number
  bid_total: number
  cost: number
  scope_vs_bid: ScopeVsBidResponse | null
}

/**
 * POST /api/projects/:id/estimate/margin — interactive margin re-pricing
 * (D10 · MARGIN slider). Sends a SET_MARGIN intent with the operator's chosen
 * target margin (a fraction in [0, 1)); the server reprices the project's
 * contract bid off the internal cost basis (bid = cost / (1 - margin)) and
 * persists both. Returns the new bid + the refreshed scope-vs-bid snapshot.
 */
export function repriceEstimateMargin(projectId: string, targetMarginPct: number): Promise<RepriceMarginResponse> {
  return request<RepriceMarginResponse>(`/api/projects/${encodeURIComponent(projectId)}/estimate/margin`, {
    method: 'POST',
    json: { event: 'SET_MARGIN', target_margin_pct: targetMarginPct },
  })
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

/** Build the estimate CSV (Excel-friendly) download URL — same auth/draft
 * model as the PDF. Opens directly in a spreadsheet. */
export function estimateCsvUrl(projectId: string, draftId: string | null = null): string {
  const qs = draftId ? `?draft_id=${encodeURIComponent(draftId)}` : ''
  return `${API_URL}/api/projects/${encodeURIComponent(projectId)}/estimate.csv${qs}`
}

/** Build the estimate .xlsx (real Excel workbook) download URL — same auth/draft
 * model as the PDF/CSV. PlanSwift-parity formatted export. */
export function estimateXlsxUrl(projectId: string, draftId: string | null = null): string {
  const qs = draftId ? `?draft_id=${encodeURIComponent(draftId)}` : ''
  return `${API_URL}/api/projects/${encodeURIComponent(projectId)}/estimate.xlsx${qs}`
}

/** PlanSwift-parity report kinds (Phase 3 report builder). One estimate model,
 * four audiences. `summary` is the original internal estimate. */
export type EstimateReportKind = 'summary' | 'customer' | 'rfq' | 'cost_vs_sell'

export const ESTIMATE_REPORTS: ReadonlyArray<{ kind: EstimateReportKind; label: string }> = [
  { kind: 'summary', label: 'Estimate (internal)' },
  { kind: 'customer', label: 'Customer proposal' },
  { kind: 'rfq', label: 'RFQ (for subs)' },
  { kind: 'cost_vs_sell', label: 'Cost vs sell' },
]

/** Build a report PDF download URL for a report kind (rides the estimate.pdf
 * route with ?report=). */
export function estimateReportUrl(
  projectId: string,
  report: EstimateReportKind,
  draftId: string | null = null,
): string {
  const params = new URLSearchParams()
  if (report !== 'summary') params.set('report', report)
  if (draftId) params.set('draft_id', draftId)
  const qs = params.toString()
  return `${API_URL}/api/projects/${encodeURIComponent(projectId)}/estimate.pdf${qs ? `?${qs}` : ''}`
}
