// Condition layer resource hooks (Takeoff Deep Dive H1) — company-scoped CRUD
// for reusable typed takeoff templates, consumed by the est-canvas Condition
// picker + legend.
//
// A Condition is the keystone reusable abstraction: pick a typed, named,
// colored template (with drivers) and draw against it, instead of
// re-specifying scope on every polygon. This module is purely additive — the
// existing tag/flat-line measurement flow remains the fallback.
//
// The `TakeoffCondition` row shape is the canonical one from @sitelayer/domain
// (shared with the API), re-exported here so a screen has one import surface.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConditionMeasurementKind, TakeoffCondition } from '@sitelayer/domain'
import { request } from './client'

export type { ConditionMeasurementKind, TakeoffCondition } from '@sitelayer/domain'

const CONDITIONS_KEY = ['takeoff', 'conditions'] as const

interface ConditionListResponse {
  conditions: TakeoffCondition[]
}

/** List the company's live (non-deleted) conditions for the picker + legend. */
export function useConditions() {
  return useQuery<ConditionListResponse>({
    queryKey: CONDITIONS_KEY,
    queryFn: () => request('/api/takeoff/conditions'),
    // Conditions are company-level templates that change rarely during a
    // drawing session; a 5-minute stale window matches the assemblies /
    // service-items hooks so repeated draws don't refetch the list.
    staleTime: 5 * 60_000,
  })
}

export interface CreateConditionInput {
  name: string
  color?: string
  measurement_kind?: ConditionMeasurementKind
  height_value?: number | null
  thickness_value?: number | null
  sides?: number | null
  slope_value?: number | null
  default_assembly_id?: string | null
  emit_linear?: boolean
  emit_area?: boolean
  emit_volume?: boolean
}

/** POST /api/takeoff/conditions — create a condition. */
export function useCreateCondition() {
  const qc = useQueryClient()
  return useMutation<{ condition: TakeoffCondition }, Error, CreateConditionInput>({
    mutationFn: (input) => request('/api/takeoff/conditions', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONDITIONS_KEY }),
  })
}

export interface UpdateConditionInput extends Partial<CreateConditionInput> {
  id: string
}

/** PATCH /api/takeoff/conditions/:id — partial update. */
export function useUpdateCondition() {
  const qc = useQueryClient()
  return useMutation<{ condition: TakeoffCondition }, Error, UpdateConditionInput>({
    mutationFn: ({ id, ...body }) =>
      request(`/api/takeoff/conditions/${encodeURIComponent(id)}`, { method: 'PATCH', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONDITIONS_KEY }),
  })
}

/** DELETE /api/takeoff/conditions/:id — soft-delete (the picker stops listing it). */
export function useDeleteCondition() {
  const qc = useQueryClient()
  return useMutation<{ condition: TakeoffCondition }, Error, { id: string }>({
    mutationFn: ({ id }) => request(`/api/takeoff/conditions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONDITIONS_KEY }),
  })
}
