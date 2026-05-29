// Project billing milestones (v2) — types + hooks. Wraps the routes in
// apps/api/src/routes/project-billing-milestones.ts (migration
// 104_project_billing_milestones.sql).
//
// This is the persistent backing for the deposit/progress/final ladder the
// mobile invoice flow (invoice-quick.tsx / invoice-sent.tsx) used to render
// as a stub. It is an ADDITIVE tracking layer alongside the estimate_push
// workflow (./estimate-pushes.ts) — estimate_push still owns the actual QBO
// push; a milestone records what to bill per phase and whether it's been
// invoiced / paid. Status is set MANUALLY (no QBO payment-webhook).
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export type BillingMilestoneStatus = 'not_yet' | 'invoiced' | 'paid'

export interface BillingMilestone {
  id: string
  company_id: string
  project_id: string
  label: string
  pct: number | null
  amount: number | null
  sort_order: number
  status: BillingMilestoneStatus
  estimate_push_id: string | null
  invoiced_at: string | null
  paid_at: string | null
  tier_origin: string | null
  created_at: string
  updated_at: string
}

export interface BillingMilestonesResponse {
  billing_milestones: BillingMilestone[]
}

export interface BillingMilestoneResponse {
  billing_milestone: BillingMilestone
}

/** One milestone definition for a create request. */
export interface BillingMilestoneInput {
  label: string
  pct?: number | null
  amount?: number | null
  sort_order?: number
  status?: BillingMilestoneStatus
  estimate_push_id?: string | null
}

/**
 * Create-request body. Precedence on the server:
 *   1. `milestones[]` — explicit set
 *   2. `label` present — single milestone
 *   3. otherwise — seed the default deposit/progress/final ladder, deriving
 *      amounts from `contract_value` when supplied.
 */
export interface CreateBillingMilestonesInput {
  milestones?: BillingMilestoneInput[]
  label?: string
  pct?: number | null
  amount?: number | null
  sort_order?: number
  status?: BillingMilestoneStatus
  estimate_push_id?: string | null
  /** Used only when seeding the default ladder — derives per-step amounts. */
  contract_value?: number
}

/** PATCH body — any subset; `status` drives invoiced_at/paid_at stamping. */
export interface PatchBillingMilestoneInput {
  status?: BillingMilestoneStatus
  label?: string
  pct?: number | null
  amount?: number | null
  sort_order?: number
  estimate_push_id?: string | null
}

const KEYS = {
  all: () => ['billing-milestones'] as const,
  byProject: (projectId: string) => [...KEYS.all(), 'project', projectId] as const,
}
export const billingMilestoneQueryKeys = KEYS

export function fetchProjectBillingMilestones(projectId: string): Promise<BillingMilestonesResponse> {
  return request<BillingMilestonesResponse>(`/api/projects/${encodeURIComponent(projectId)}/billing-milestones`)
}

export function createBillingMilestones(
  projectId: string,
  input: CreateBillingMilestonesInput = {},
): Promise<BillingMilestonesResponse> {
  return request<BillingMilestonesResponse>(`/api/projects/${encodeURIComponent(projectId)}/billing-milestones`, {
    method: 'POST',
    json: input,
  })
}

export function patchBillingMilestone(
  id: string,
  input: PatchBillingMilestoneInput,
): Promise<BillingMilestoneResponse> {
  return request<BillingMilestoneResponse>(`/api/billing-milestones/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: input,
  })
}

export function useBillingMilestones(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<BillingMilestonesResponse>>,
) {
  return useQuery<BillingMilestonesResponse>({
    queryKey: KEYS.byProject(projectId ?? ''),
    queryFn: () => fetchProjectBillingMilestones(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

export function useCreateBillingMilestones(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateBillingMilestonesInput = {}) => createBillingMilestones(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.byProject(projectId) }),
  })
}

export function usePatchBillingMilestone(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { id: string; input: PatchBillingMilestoneInput }) =>
      patchBillingMilestone(args.id, args.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.byProject(projectId) }),
  })
}
