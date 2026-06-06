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
