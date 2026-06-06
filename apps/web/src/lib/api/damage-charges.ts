// Damage / loss / late-return / cleanup charges.
// API surface lives in apps/api/src/routes/damage-charges.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface DamageCharge {
  id: string
  company_id: string
  project_id: string
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
  status: 'open' | 'invoiced' | 'waived' | 'disputed'
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

export function useDamageCharges(projectId: string) {
  return useQuery<{ charges: DamageCharge[] }>({
    queryKey: ['project', projectId, 'damage-charges'],
    enabled: !!projectId,
    queryFn: () =>
      request<{ charges: DamageCharge[] }>(`/api/projects/${encodeURIComponent(projectId)}/damage-charges`),
  })
}

export function useCreateDamageCharge(projectId: string) {
  const qc = useQueryClient()
  return useMutation<
    DamageCharge,
    Error,
    {
      kind: DamageCharge['kind']
      description: string
      quantity?: number
      unit_amount?: number
      total_amount?: number
      customer_id?: string
      shipment_id?: string
      shipment_line_id?: string
      inventory_item_id?: string
      catalog_part_id?: string
      taxable?: boolean
      notes?: string
    }
  >({
    mutationFn: (input) =>
      request<DamageCharge>(`/api/projects/${encodeURIComponent(projectId)}/damage-charges`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId, 'damage-charges'] }),
  })
}

export function useInvoiceDamageCharge() {
  const qc = useQueryClient()
  return useMutation<DamageCharge, Error, { id: string }>({
    mutationFn: ({ id }) =>
      request<DamageCharge>(`/api/damage-charges/${encodeURIComponent(id)}/invoice`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })
}

export function useWaiveDamageCharge() {
  const qc = useQueryClient()
  return useMutation<DamageCharge, Error, { id: string; waive_reason?: string }>({
    mutationFn: ({ id, ...input }) =>
      request<DamageCharge>(`/api/damage-charges/${encodeURIComponent(id)}/waive`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  })
}
