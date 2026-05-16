// Shipments — estimate-to-fulfillment workflow.
// API surface lives in apps/api/src/routes/shipments.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export type ShipmentStatus =
  | 'planned'
  | 'picking'
  | 'shipped'
  | 'delivered'
  | 'returning'
  | 'closed'
  | 'voided'

export interface Shipment {
  id: string
  company_id: string
  project_id: string
  bom_id: string | null
  source_branch_id: string | null
  destination_location_id: string | null
  direction: 'outbound' | 'return'
  status: ShipmentStatus
  state_version: number
  scheduled_for: string | null
  shipped_at: string | null
  delivered_at: string | null
  confirmed_by: string | null
  driver: string | null
  ticket_number: string | null
  notes: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface ShipmentLine {
  id: string
  shipment_id: string
  inventory_item_id: string | null
  catalog_part_id: string | null
  bom_line_id: string | null
  quantity_planned: string
  quantity_shipped: string
  quantity_delivered: string
  quantity_returned: string
  quantity_damaged: string
  quantity_lost: string
  notes: string | null
}

export interface ShipmentEvent {
  id: string
  shipment_id: string
  event_type: string
  payload: Record<string, unknown>
  state_before: string | null
  state_after: string | null
  state_version: number
  produced_by: string
  created_at: string
}

export interface ShipmentDetail extends Shipment {
  lines: ShipmentLine[]
  events: ShipmentEvent[]
}

export function useProjectShipments(projectId: string) {
  return useQuery<{ shipments: Shipment[] }>({
    queryKey: ['project', projectId, 'shipments'],
    enabled: !!projectId,
    queryFn: () =>
      request<{ shipments: Shipment[] }>(`/api/projects/${encodeURIComponent(projectId)}/shipments`),
  })
}

export function useShipment(shipmentId: string) {
  return useQuery<ShipmentDetail>({
    queryKey: ['shipment', shipmentId],
    enabled: !!shipmentId,
    queryFn: () => request<ShipmentDetail>(`/api/shipments/${encodeURIComponent(shipmentId)}`),
  })
}

export function useCreateShipment(projectId: string) {
  const qc = useQueryClient()
  return useMutation<
    Shipment,
    Error,
    {
      bom_id?: string
      source_branch_id?: string
      destination_location_id?: string
      direction?: 'outbound' | 'return'
      scheduled_for?: string
      driver?: string
      ticket_number?: string
      notes?: string
    }
  >({
    mutationFn: (input) =>
      request<Shipment>(`/api/projects/${encodeURIComponent(projectId)}/shipments`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId, 'shipments'] }),
  })
}

export function useAppendShipmentLines(shipmentId: string) {
  const qc = useQueryClient()
  return useMutation<
    { lines: ShipmentLine[] },
    Error,
    {
      lines: Array<{
        inventory_item_id?: string
        catalog_part_id?: string
        bom_line_id?: string
        quantity_planned: number
        notes?: string
      }>
    }
  >({
    mutationFn: (input) =>
      request<{ lines: ShipmentLine[] }>(`/api/shipments/${encodeURIComponent(shipmentId)}/lines`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shipment', shipmentId] }),
  })
}

export function useTransitionShipment(shipmentId: string) {
  const qc = useQueryClient()
  return useMutation<
    Shipment,
    Error,
    { event_type: string; next_status: ShipmentStatus; state_version: number; payload?: Record<string, unknown> }
  >({
    mutationFn: (input) =>
      request<Shipment>(`/api/shipments/${encodeURIComponent(shipmentId)}/transition`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shipment', shipmentId] }),
  })
}
