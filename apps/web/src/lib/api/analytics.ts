// Job-costing analytics: estimate (bid) vs ACTUAL cost per project, computed
// from internal data — logged labor (hours × project labor rate) + material
// bills — NOT a live QBO pull. This is the "see actual cost vs the estimate"
// loop Cavy asked for (WhatsApp 4/3), testable today without QBO connected.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface AnalyticsProjectMetrics {
  totalHours: number
  totalSqft: number
  laborCost: number
  materialCost: number
  subCost: number
  totalCost: number
  /** revenue = the project bid_total (the estimate the job was sold at). */
  revenue: number
  profit: number
  /** Fraction (0..1). */
  margin: number
  bonus: number
  sqftPerHr: number
}

export interface AnalyticsProject {
  project: {
    id: string
    name: string
    customer_name: string | null
    division_code: string | null
    status: string
    bid_total: number | string | null
    labor_rate: number | string | null
    bonus_pool: number | string | null
  }
  metrics: AnalyticsProjectMetrics
}

export interface AnalyticsDivision {
  divisionCode: string
  revenue: number
  cost: number
  profit: number
  margin: number
  count: number
}

export interface AnalyticsResponse {
  projects: AnalyticsProject[]
  divisions: AnalyticsDivision[]
}

export function useAnalytics(options?: Partial<UseQueryOptions<AnalyticsResponse>>) {
  return useQuery<AnalyticsResponse>({
    queryKey: ['analytics'],
    queryFn: () => request<AnalyticsResponse>('/api/analytics', { method: 'GET' }),
    ...options,
  })
}

// Per-service-item productivity: ACTUAL quantity-per-hour the crews are
// achieving on each service item, aggregated from logged labor entries
// (sqft_done / hours). This is the per-LINE-ITEM granularity Cavy asked for
// ("see actual cost per line item / build-a-bear") — one level finer than the
// per-project / per-division rollup in /api/analytics. Read-only GET; the
// backend (GET /api/analytics/service-item-productivity, admin/office) owns the
// aggregation, this hook just fetches it.

export interface AnalyticsServiceItemProductivity {
  code: string
  name: string
  unit: string
  /** Number of labor entries that fed this item's stats. */
  samples: number
  /** Total measured quantity (in `unit`) across all entries. */
  total_quantity: number
  /** Total logged hours across all entries. */
  total_hours: number
  /** Mean quantity completed per hour. */
  avg_quantity_per_hour: number
  /** Median (p50) quantity per hour. */
  p50_quantity_per_hour: number
  /** p90 quantity per hour. */
  p90_quantity_per_hour: number
  first_seen: string | null
  last_seen: string | null
}

export interface AnalyticsServiceItemProductivityResponse {
  service_items: AnalyticsServiceItemProductivity[]
}

export function useServiceItemProductivity(
  options?: Partial<UseQueryOptions<AnalyticsServiceItemProductivityResponse>>,
) {
  return useQuery<AnalyticsServiceItemProductivityResponse>({
    queryKey: ['analytics', 'service-item-productivity'],
    queryFn: () =>
      request<AnalyticsServiceItemProductivityResponse>('/api/analytics/service-item-productivity', {
        method: 'GET',
      }),
    ...options,
  })
}
