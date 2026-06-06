// Budget freeze + per-cost-code variance data layer (Takeoff Deep Dive §4 —
// bid / budget / actuals).
//
// The freeze is an EXPLICIT operator action: it snapshots the project's CURRENT
// estimate_lines (the live bid) into an IMMUTABLE budget_snapshots row. A change
// order mints a NEW version; an existing snapshot is never mutated. The variance
// view then compares that frozen BUDGET against ACTUALS (material_bills +
// labor_entries). estimate_lines stays the live bid — this layer never touches it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface BudgetSnapshot {
  id: string
  project_id: string
  version: number
  frozen_at: string
  frozen_by: string | null
  note: string | null
  material_total: string
  labor_total: string
  budget_total: string
  created_at: string
}

export interface BudgetSnapshotLine {
  id: string
  cost_code: string | null
  division_code: string | null
  service_item_code: string
  qty: string
  unit: string
  material_amount: string
  labor_amount: string
}

/** A confidence pill is ordinal — never a numeric pct (AI Layer rule). */
export type VarianceConfidence = 'low' | 'med' | 'high'

export interface VarianceCostCode {
  service_item_code: string
  cost_code: string | null
  division_code: string | null
  unit: string
  budget_qty: number
  budget_material_cents: number
  budget_labor_cents: number
  budget_total_cents: number
  actual_material_cents: number
  actual_labor_cents: number
  actual_total_cents: number
  variance_cents: number
  confidence: VarianceConfidence
}

export interface BudgetVarianceSummary {
  budget_total_cents: number
  budget_material_cents?: number
  budget_labor_cents?: number
  actual_material_cents: number
  actual_labor_cents?: number
  actual_total_cents: number
  variance_cents: number
  unallocated_material_cents?: number
}

export interface BudgetVarianceResponse {
  frozen: boolean
  snapshot: BudgetSnapshot | null
  cost_codes: VarianceCostCode[]
  unallocated_material_cents?: number
  summary: BudgetVarianceSummary
  attribution: string
}

export interface BudgetListResponse {
  snapshots: BudgetSnapshot[]
}

export interface FreezeBudgetResponse {
  snapshot: BudgetSnapshot
  lines: BudgetSnapshotLine[]
}

const budgetKey = (projectId: string) => ['budget', projectId] as const
const varianceKey = (projectId: string) => ['budget', projectId, 'variance'] as const

/** GET /api/projects/:id/budget/variance — BUDGET (latest snapshot) vs ACTUALS. */
export function useBudgetVariance(projectId: string | null | undefined) {
  return useQuery<BudgetVarianceResponse>({
    queryKey: varianceKey(projectId ?? ''),
    queryFn: () => request(`/api/projects/${encodeURIComponent(projectId ?? '')}/budget/variance`),
    enabled: Boolean(projectId),
  })
}

/** GET /api/projects/:id/budget — the snapshot list (change-order trail). */
export function useBudgetSnapshots(projectId: string | null | undefined) {
  return useQuery<BudgetListResponse>({
    queryKey: budgetKey(projectId ?? ''),
    queryFn: () => request(`/api/projects/${encodeURIComponent(projectId ?? '')}/budget`),
    enabled: Boolean(projectId),
  })
}

export interface FreezeBudgetInput {
  projectId: string
  note?: string
}

/** POST /api/projects/:id/budget/freeze — freeze the live estimate into a new immutable snapshot. */
export function useFreezeBudget() {
  const qc = useQueryClient()
  return useMutation<FreezeBudgetResponse, Error, FreezeBudgetInput>({
    mutationFn: ({ projectId, note }) =>
      request(`/api/projects/${encodeURIComponent(projectId)}/budget/freeze`, {
        method: 'POST',
        // Conditionally include note — exactOptionalPropertyTypes forbids
        // passing `note: undefined` to an optional field.
        json: note ? { note } : {},
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: budgetKey(vars.projectId) })
      void qc.invalidateQueries({ queryKey: varianceKey(vars.projectId) })
    },
  })
}
