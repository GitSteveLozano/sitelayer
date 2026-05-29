// Change orders (v2) — types + hooks. Wraps the routes in
// apps/api/src/routes/change-orders.ts; reducer in
// packages/workflows/change-order.ts.
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type { ChangeOrder, ChangeOrderStatus } from '@sitelayer/domain'
import type { ChangeOrderHumanEventType } from '@sitelayer/workflows'
import { request } from './client'

export type { ChangeOrder, ChangeOrderStatus } from '@sitelayer/domain'

export interface ChangeOrderSnapshot {
  state: ChangeOrderStatus
  state_version: number
  context: ChangeOrder
  next_events: Array<{ type: ChangeOrderHumanEventType; label: string }>
}

export interface ChangeOrdersResponse {
  change_orders: ChangeOrder[]
  /** Σ of accepted COs' value_delta — add to project.bid_total for effective value. */
  accepted_value_delta: number
}

export interface CreateChangeOrderInput {
  description: string
  value_delta: number
  schedule_impact_days?: number
}

const KEYS = {
  all: () => ['change-orders'] as const,
  byProject: (projectId: string) => [...KEYS.all(), 'project', projectId] as const,
  detail: (id: string) => [...KEYS.all(), 'detail', id] as const,
}
export const changeOrderQueryKeys = KEYS

export function fetchProjectChangeOrders(projectId: string): Promise<ChangeOrdersResponse> {
  return request<ChangeOrdersResponse>(`/api/projects/${encodeURIComponent(projectId)}/change-orders`)
}

export function createChangeOrder(projectId: string, input: CreateChangeOrderInput): Promise<ChangeOrderSnapshot> {
  return request<ChangeOrderSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/change-orders`, {
    method: 'POST',
    json: input,
  })
}

export function dispatchChangeOrderEvent(
  id: string,
  event: ChangeOrderHumanEventType,
  stateVersion: number,
  reason?: string,
): Promise<ChangeOrderSnapshot> {
  return request<ChangeOrderSnapshot>(`/api/change-orders/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    json: { event, state_version: stateVersion, ...(reason ? { reason } : {}) },
  })
}

export function useProjectChangeOrders(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<ChangeOrdersResponse>>,
) {
  return useQuery<ChangeOrdersResponse>({
    queryKey: KEYS.byProject(projectId ?? ''),
    queryFn: () => fetchProjectChangeOrders(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

export function useCreateChangeOrder(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateChangeOrderInput) => createChangeOrder(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.byProject(projectId) }),
  })
}

export function useChangeOrderEvent(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { id: string; event: ChangeOrderHumanEventType; stateVersion: number; reason?: string }) =>
      dispatchChangeOrderEvent(args.id, args.event, args.stateVersion, args.reason),
    onSuccess: (snap) => {
      qc.invalidateQueries({ queryKey: KEYS.byProject(projectId) })
      qc.invalidateQueries({ queryKey: KEYS.detail(snap.context.id) })
    },
  })
}

/**
 * Cross-project change-order event mutation — for surfaces (e.g. the owner
 * approvals inbox) that act on COs from several projects at once. Invalidates
 * every change-order query so the originating project's list refreshes
 * regardless of which project the CO belongs to.
 */
export function useAnyProjectChangeOrderEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { id: string; event: ChangeOrderHumanEventType; stateVersion: number; reason?: string }) =>
      dispatchChangeOrderEvent(args.id, args.event, args.stateVersion, args.reason),
    onSuccess: (snap) => {
      qc.invalidateQueries({ queryKey: KEYS.all() })
      qc.invalidateQueries({ queryKey: KEYS.detail(snap.context.id) })
    },
  })
}
