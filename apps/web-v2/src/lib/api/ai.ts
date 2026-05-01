// Phase 5: AI Layer hooks. Bid-accuracy cohort stats + insight CRUD +
// takeoff-to-bid agent trigger. The visual primitives live in
// apps/web-v2/src/components/ai/; this module is just the data layer.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

// ---------------------------------------------------------------------------
// Bid accuracy cohort stats
// ---------------------------------------------------------------------------

export type AccuracyConfidence = 'low' | 'med' | 'high'

export interface BidAccuracyProject {
  project_id: string
  project_name: string
  customer_name: string | null
  status: string
  bid_total: string
  actual_material_cents: number
  actual_labor_cents: number
  actual_total_cents: number
  delta_cents: number
  delta_pct: number
  confidence: AccuracyConfidence
}

export interface BidAccuracySummary {
  project_count: number
  closed_project_count: number
  mean_closed_delta_pct: number
  over_count: number
  under_count: number
  exact_count: number
  attribution: string
}

export function useBidAccuracy() {
  return useQuery<{ projects: BidAccuracyProject[]; summary: BidAccuracySummary }>({
    queryKey: ['ai', 'bid-accuracy'],
    queryFn: () => request('/api/ai/bid-accuracy'),
  })
}

// ---------------------------------------------------------------------------
// Insights CRUD
// ---------------------------------------------------------------------------

export interface AiInsight<TPayload = unknown> {
  id: string
  kind: string
  entity_type: string
  entity_id: string | null
  payload: TPayload
  confidence: AccuracyConfidence
  attribution: string
  source_run_id: string | null
  produced_by: string
  applied_at: string | null
  applied_by: string | null
  dismissed_at: string | null
  dismissed_by: string | null
  dismiss_reason: string | null
  created_at: string
  updated_at: string
}

export interface InsightListParams {
  kind?: string
  open?: boolean
  entityId?: string
}

export function useAiInsights<TPayload = unknown>(params: InsightListParams = {}) {
  const search = new URLSearchParams()
  if (params.kind) search.set('kind', params.kind)
  if (params.open) search.set('open', '1')
  if (params.entityId) search.set('entity_id', params.entityId)
  const qs = search.toString() ? `?${search}` : ''
  return useQuery<{ insights: AiInsight<TPayload>[] }>({
    queryKey: ['ai', 'insights', params],
    queryFn: () => request(`/api/ai/insights${qs}`),
  })
}

export function useDismissInsight() {
  const qc = useQueryClient()
  return useMutation<{ insight: AiInsight }, Error, { id: string; reason?: string }>({
    mutationFn: ({ id, reason }) =>
      request(`/api/ai/insights/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST',
        json: { reason: reason ?? null },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai'] }),
  })
}

export function useApplyInsight() {
  const qc = useQueryClient()
  return useMutation<{ insight: AiInsight }, Error, { id: string }>({
    mutationFn: ({ id }) =>
      request(`/api/ai/insights/${encodeURIComponent(id)}/apply`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai'] }),
  })
}

// ---------------------------------------------------------------------------
// Takeoff-to-bid agent trigger
// ---------------------------------------------------------------------------

export interface TakeoffToBidProposal {
  service_item_code: string
  description: string
  quantity: number
  unit: string
  rate: number
  amount: number
  confidence: AccuracyConfidence
  rationale: string
}

export interface TakeoffToBidPayload {
  lines: TakeoffToBidProposal[]
  total_amount: number
  measurement_count: number
}

export function useTriggerTakeoffToBid() {
  const qc = useQueryClient()
  return useMutation<
    { run_id: string; project_id: string; status: string },
    Error,
    { project_id: string }
  >({
    mutationFn: (input) => request('/api/ai/agents/takeoff-to-bid', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai'] }),
  })
}
