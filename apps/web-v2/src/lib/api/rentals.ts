// Phase 4 rentals — inventory catalog, dispatch movements, contracts,
// utilization rollup. The legacy v1 web has its own bigger rental
// editor; v2 ships the field-facing scan flow + a calm utilization
// dashboard for owners. See the v1 routes in
// `apps/api/src/routes/rental-inventory-crud.ts` for the canonical
// shape.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

// ---------------------------------------------------------------------------
// Inventory catalog
// ---------------------------------------------------------------------------

export interface InventoryItem {
  id: string
  code: string
  description: string
  category: string
  unit: string
  default_rental_rate: string
  replacement_value: string | null
  tracking_mode: string
  active: boolean
  notes: string | null
}

export function useInventoryItems() {
  return useQuery<{ inventoryItems: InventoryItem[] }>({
    queryKey: ['inventory', 'items'],
    queryFn: () => request('/api/inventory/items'),
  })
}

export interface InventoryLocation {
  id: string
  project_id: string | null
  name: string
  location_type: string
  is_default: boolean
}

export function useInventoryLocations() {
  return useQuery<{ inventoryLocations: InventoryLocation[] }>({
    queryKey: ['inventory', 'locations'],
    queryFn: () => request('/api/inventory/locations'),
  })
}

// ---------------------------------------------------------------------------
// Movements (dispatch ledger)
// ---------------------------------------------------------------------------

export interface InventoryMovement {
  id: string
  inventory_item_id: string
  from_location_id: string | null
  to_location_id: string | null
  project_id: string | null
  movement_type: 'deliver' | 'return' | 'transfer' | 'adjustment' | 'damage' | 'loss'
  quantity: string
  occurred_on: string
  ticket_number: string | null
  notes: string | null
  worker_id: string | null
  clerk_user_id: string | null
  scan_payload: string | null
  scanned_at: string | null
  lat: string | null
  lng: string | null
  created_at: string
  item_code?: string | null
  item_description?: string | null
  from_location_name?: string | null
  to_location_name?: string | null
  project_name?: string | null
}

export interface MovementListParams {
  itemId?: string
  projectId?: string
  type?: InventoryMovement['movement_type']
}

export function useInventoryMovements(params: MovementListParams = {}) {
  const search = new URLSearchParams()
  if (params.itemId) search.set('item_id', params.itemId)
  if (params.projectId) search.set('project_id', params.projectId)
  if (params.type) search.set('type', params.type)
  const qs = search.toString() ? `?${search}` : ''
  return useQuery<{ inventoryMovements: InventoryMovement[] }>({
    queryKey: ['inventory', 'movements', params],
    queryFn: () => request(`/api/inventory/movements${qs}`),
  })
}

export interface ScanDispatchInput {
  inventory_item_id: string
  quantity: number
  movement_type: InventoryMovement['movement_type']
  from_location_id?: string | null
  to_location_id?: string | null
  project_id?: string | null
  ticket_number?: string | null
  notes?: string | null
  worker_id?: string | null
  scan_payload?: string | null
  scanned_at?: string | null
  lat?: number | null
  lng?: number | null
}

export function useDispatchMovement() {
  const qc = useQueryClient()
  return useMutation<InventoryMovement, Error, ScanDispatchInput>({
    mutationFn: (input) =>
      request('/api/inventory/movements', { method: 'POST', json: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

// ---------------------------------------------------------------------------
// Contracts (read-only in v2)
// ---------------------------------------------------------------------------

export interface JobRentalContract {
  id: string
  project_id: string
  customer_id: string | null
  billing_cycle_days: number
  billing_mode: string
  billing_start_date: string
  next_billing_date: string
  last_billed_through: string | null
  status: 'draft' | 'active' | 'paused' | 'closed'
  notes: string | null
}

export function useProjectRentalContracts(projectId: string | null | undefined) {
  return useQuery<{ contracts: JobRentalContract[] }>({
    queryKey: ['rental-contracts', 'by-project', projectId ?? ''],
    queryFn: () =>
      request(`/api/projects/${encodeURIComponent(projectId!)}/rental-contracts`),
    enabled: Boolean(projectId),
  })
}

// ---------------------------------------------------------------------------
// Utilization rollup
// ---------------------------------------------------------------------------

export interface UtilizationRow {
  inventory_item_id: string
  code: string
  description: string
  unit: string
  default_rental_rate: string
  on_rent_quantity: string
  available_quantity: string
  active_lines: number
  days_since_activity: number | null
  idle_revenue_per_day_cents: number
}

export interface UtilizationTotals {
  total_idle_revenue_per_day_cents: number
  total_on_rent: number
  total_available: number
  generated_at: string
}

export function useInventoryUtilization() {
  return useQuery<{ items: UtilizationRow[]; totals: UtilizationTotals }>({
    queryKey: ['inventory', 'utilization'],
    queryFn: () => request('/api/inventory/utilization'),
  })
}
