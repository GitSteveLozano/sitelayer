// Damage-charge settlement workflow — detail snapshot + state-transition
// events. Wraps the deterministic-workflow surface added in
// apps/api/src/routes/damage-charges.ts:
//   GET  /api/damage-charges/:id        → WorkflowSnapshot
//   POST /api/damage-charges/:id/events → { event, state_version }
//
// Sits alongside the resource-shaped hooks in damage-charges.ts (list /
// create / legacy invoice+waive). This file owns ONLY the headless
// workflow surface so the detail UI renders state + next_events straight
// from the server and never invents a vocabulary. Same shape as
// billing-runs.ts → RentalBillingSnapshot.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DamageChargeSettlementHumanEventType, DamageChargeSettlementWorkflowState } from '@sitelayer/workflows'
import { request } from './client'

export type DamageChargeSettlementState = DamageChargeSettlementWorkflowState
export type DamageChargeSettlementEvent = DamageChargeSettlementHumanEventType

export interface DamageChargeSettlementSnapshot {
  state: DamageChargeSettlementState
  state_version: number
  next_events: Array<{ type: DamageChargeSettlementEvent; label: string }>
  context: {
    id: string
    project_id: string | null
    customer_id: string | null
    shipment_id: string | null
    shipment_line_id: string | null
    inventory_item_id: string | null
    catalog_part_id: string | null
    kind: 'damage' | 'loss' | 'late_return' | 'cleanup'
    quantity: string
    unit_amount: string
    total_amount: string
    description: string
    taxable: boolean
    qbo_invoice_id: string | null
    invoiced_at: string | null
    invoiced_by: string | null
    waived_at: string | null
    waived_by: string | null
    waive_reason: string | null
    notes: string | null
    created_at: string
    updated_at: string
  }
}

const KEYS = {
  all: () => ['damage-charge-settlement'] as const,
  detail: (id: string) => [...KEYS.all(), 'detail', id] as const,
}

export const damageChargeSettlementQueryKeys = KEYS

export function fetchDamageChargeSnapshot(id: string): Promise<DamageChargeSettlementSnapshot> {
  return request<DamageChargeSettlementSnapshot>(`/api/damage-charges/${encodeURIComponent(id)}`)
}

/**
 * Dispatch a human event against the settlement reducer. The optional
 * `waiveReason` rides on the body for WAIVE; the API ignores it for
 * INVOICE. 409 (stale state_version / illegal transition) surfaces as a
 * thrown error the caller reloads the snapshot on.
 */
export function dispatchDamageChargeEvent(
  id: string,
  event: DamageChargeSettlementEvent,
  stateVersion: number,
  waiveReason?: string | null,
): Promise<DamageChargeSettlementSnapshot> {
  return request<DamageChargeSettlementSnapshot>(`/api/damage-charges/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    json:
      waiveReason != null && waiveReason !== ''
        ? { event, state_version: stateVersion, waive_reason: waiveReason }
        : { event, state_version: stateVersion },
  })
}

export function useDamageChargeSnapshot(id: string | null | undefined) {
  return useQuery<DamageChargeSettlementSnapshot>({
    queryKey: KEYS.detail(id ?? ''),
    queryFn: () => fetchDamageChargeSnapshot(id!),
    enabled: Boolean(id),
  })
}

export function useDispatchDamageChargeEvent(id: string) {
  const qc = useQueryClient()
  return useMutation<
    DamageChargeSettlementSnapshot,
    Error,
    { event: DamageChargeSettlementEvent; state_version: number; waive_reason?: string | null }
  >({
    mutationFn: ({ event, state_version, waive_reason }) =>
      dispatchDamageChargeEvent(id, event, state_version, waive_reason ?? null),
    onSuccess: (data) => {
      // Write the fresh snapshot straight into the cache so the detail
      // view re-renders the post-event state without a refetch hop, then
      // invalidate the per-project list so its status pill updates.
      qc.setQueryData(KEYS.detail(id), data)
      qc.invalidateQueries({ queryKey: ['project'] })
    },
  })
}
