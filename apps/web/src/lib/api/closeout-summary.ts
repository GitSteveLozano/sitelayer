// Closeout summary — types + hook for the Budget-tab closing summary card
// on the mobile project detail screen. Wraps
// GET /api/projects/:id/closeout-summary.
//
// Shape contract matches apps/api/src/routes/projects.ts (handleProjectRoutes
// closeout-summary branch). All money values come through as JS numbers
// already rounded to two decimals on the server, so the card can drop them
// straight into `formatMoney` without re-parsing.
//
// The rollup combines four sources: estimate_lines.amount, labor_entries.hours
// × project.labor_rate, posted material_bills.amount, and posted
// rental_billing_runs.subtotal. The card surfaces each bucket as an
// estimate-vs-actual row so the user can see which side of the bid the
// project landed on.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface CloseoutSummaryResponse {
  project: { id: string; name: string }
  bid: number
  estimate_total: number
  labor_hours: number
  labor_rate: number
  labor_actual: number
  materials_actual: number
  rentals_actual: number
  total_actual: number
  margin: number
  margin_pct: number
}

const KEYS = {
  all: () => ['closeout-summary'] as const,
  byProject: (projectId: string) => [...KEYS.all(), projectId] as const,
}

export const closeoutSummaryQueryKeys = KEYS

export function fetchProjectCloseoutSummary(projectId: string): Promise<CloseoutSummaryResponse> {
  return request<CloseoutSummaryResponse>(`/api/projects/${encodeURIComponent(projectId)}/closeout-summary`)
}

export function useProjectCloseoutSummary(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<CloseoutSummaryResponse>>,
) {
  return useQuery<CloseoutSummaryResponse>({
    queryKey: KEYS.byProject(projectId ?? ''),
    queryFn: () => fetchProjectCloseoutSummary(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}
