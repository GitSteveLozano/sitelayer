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
  version: number
  deleted_at?: string | null
  created_at?: string
  updated_at?: string
}

export function useInventoryItems() {
  return useQuery<{ inventoryItems: InventoryItem[] }>({
    queryKey: ['inventory', 'items'],
    queryFn: () => request('/api/inventory/items'),
  })
}

/** Imperative fetcher for inventory items. The `companySlug` arg pins
 *  a non-active company; omit to use the active slug. */
export function listInventoryItems(companySlug?: string): Promise<{ inventoryItems: InventoryItem[] }> {
  return request<{ inventoryItems: InventoryItem[] }>(
    '/api/inventory/items',
    companySlug !== undefined ? { companySlug } : {},
  )
}

export interface InventoryLocation {
  id: string
  company_id?: string
  project_id: string | null
  name: string
  location_type: 'yard' | 'job_site' | 'service' | string
  is_default: boolean
  version: number
  deleted_at?: string | null
  created_at?: string
  updated_at?: string
}

export function useInventoryLocations() {
  return useQuery<{ inventoryLocations: InventoryLocation[] }>({
    queryKey: ['inventory', 'locations'],
    queryFn: () => request('/api/inventory/locations'),
  })
}

/** Imperative fetcher for inventory locations. */
export function listInventoryLocations(companySlug?: string): Promise<{ inventoryLocations: InventoryLocation[] }> {
  return request<{ inventoryLocations: InventoryLocation[] }>(
    '/api/inventory/locations',
    companySlug !== undefined ? { companySlug } : {},
  )
}

// ---------------------------------------------------------------------------
// Utilization summary (mobile dashboard)
// ---------------------------------------------------------------------------

export interface InventoryUtilizationTopItem {
  inventory_item_id: string
  code: string
  name: string
  on_rent_quantity: string
  total_quantity: string
  utilization_pct: number
}

export interface InventoryUtilizationSummary {
  total_items: number
  total_quantity_owned: number
  on_rent_count: number
  in_yard_count: number
  out_for_service_count: number
  utilization_pct: number
  top_utilized: InventoryUtilizationTopItem[]
  generated_at: string
}

/**
 * Headline deployment rollup for the rentals dashboard. The full
 * payload (per-item breakdown, legacy idle-revenue totals) is also on
 * the wire — see `useInventoryUtilization` for that surface. Mobile
 * callers just need the deployment headline.
 */
export async function fetchInventoryUtilizationSummary(companySlug?: string): Promise<InventoryUtilizationSummary> {
  const body = await request<{ totals: InventoryUtilizationSummary }>(
    '/api/inventory/utilization',
    companySlug !== undefined ? { companySlug } : {},
  )
  return body.totals
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
  // Canonical server-side movement types (apps/api rental-inventory.types.ts
  // `MOVEMENT_TYPES`). The POST handler `normalizeEnum`s anything else to
  // `adjustment`, so a damaged-return must post `'damaged'` (not `'damage'`),
  // a loss `'lost'`, and a service flag `'repair'`.
  movement_type: 'deliver' | 'return' | 'transfer' | 'adjustment' | 'damaged' | 'lost' | 'repair'
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
    mutationFn: (input) => request('/api/inventory/movements', { method: 'POST', json: input }),
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
  version: number
}

export function useProjectRentalContracts(projectId: string | null | undefined) {
  return useQuery<{ contracts: JobRentalContract[] }>({
    queryKey: ['rental-contracts', 'by-project', projectId ?? ''],
    queryFn: () => request(`/api/projects/${encodeURIComponent(projectId!)}/rental-contracts`),
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

export interface UtilizationTopItem {
  inventory_item_id: string
  code: string
  name: string
  on_rent_quantity: string
  total_quantity: string
  utilization_pct: number
}

export interface UtilizationTotals {
  total_idle_revenue_per_day_cents: number
  total_on_rent: number
  total_available: number
  // Deployment rollup — owner persona "% of equipment currently deployed".
  total_items: number
  total_quantity_owned: number
  on_rent_count: number
  in_yard_count: number
  out_for_service_count: number
  utilization_pct: number
  top_utilized: UtilizationTopItem[]
  generated_at: string
}

export function useInventoryUtilization() {
  return useQuery<{ items: UtilizationRow[]; totals: UtilizationTotals }>({
    queryKey: ['inventory', 'utilization'],
    queryFn: () => request('/api/inventory/utilization'),
  })
}

// ---------------------------------------------------------------------------
// Inventory items — admin CRUD (Phase 6 Batch 4)
// ---------------------------------------------------------------------------

export interface InventoryItemCreateRequest {
  code: string
  description: string
  category?: string
  unit?: string
  default_rental_rate?: number | string
  replacement_value?: number | string | null
  tracking_mode?: string
  active?: boolean
  notes?: string | null
}

export interface InventoryItemPatchRequest {
  code?: string
  description?: string
  category?: string
  unit?: string
  default_rental_rate?: number | string
  replacement_value?: number | string | null
  tracking_mode?: string
  active?: boolean
  notes?: string | null
  expected_version?: number
}

export function useCreateInventoryItem() {
  const qc = useQueryClient()
  return useMutation<InventoryItem, Error, InventoryItemCreateRequest>({
    mutationFn: (input) => request<InventoryItem>('/api/inventory/items', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  })
}

export function usePatchInventoryItem(id: string) {
  const qc = useQueryClient()
  return useMutation<InventoryItem, Error, InventoryItemPatchRequest>({
    mutationFn: (input) =>
      request<InventoryItem>(`/api/inventory/items/${encodeURIComponent(id)}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  })
}

export function useDeleteInventoryItem() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; expected_version?: number }>({
    mutationFn: ({ id, expected_version }) =>
      request(`/api/inventory/items/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  })
}

// ---------------------------------------------------------------------------
// Inventory locations — admin CRUD
// ---------------------------------------------------------------------------

export interface InventoryLocationCreateRequest {
  name: string
  location_type?: string
  project_id?: string | null
  is_default?: boolean
}

export interface InventoryLocationPatchRequest {
  name?: string
  location_type?: string
  project_id?: string | null
  is_default?: boolean
  expected_version?: number
}

export function useCreateInventoryLocation() {
  const qc = useQueryClient()
  return useMutation<InventoryLocation, Error, InventoryLocationCreateRequest>({
    mutationFn: (input) => request<InventoryLocation>('/api/inventory/locations', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  })
}

export function usePatchInventoryLocation(id: string) {
  const qc = useQueryClient()
  return useMutation<InventoryLocation, Error, InventoryLocationPatchRequest>({
    mutationFn: (input) =>
      request<InventoryLocation>(`/api/inventory/locations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  })
}

export function useDeleteInventoryLocation() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; expected_version?: number }>({
    mutationFn: ({ id, expected_version }) =>
      request(`/api/inventory/locations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  })
}

// ---------------------------------------------------------------------------
// Rental contracts + lines — per-project editor + billing-run trigger
// ---------------------------------------------------------------------------

export interface RentalContractLine {
  id: string
  contract_id: string
  inventory_item_id: string
  quantity: string
  agreed_rate: string
  rate_unit: string
  on_rent_date: string
  off_rent_date: string | null
  last_billed_through: string | null
  billable: boolean
  taxable: boolean
  status: string
  notes: string | null
  version: number
}

export interface ContractListResponse {
  contracts: JobRentalContract[]
}

export interface ContractLineListResponse {
  lines: RentalContractLine[]
}

export interface ContractCreateRequest {
  customer_id?: string | null
  billing_cycle_days?: number
  billing_mode?: string
  billing_start_date: string
  notes?: string | null
}

export interface ContractPatchRequest {
  customer_id?: string | null
  billing_cycle_days?: number
  billing_mode?: string
  billing_start_date?: string
  next_billing_date?: string
  status?: string
  notes?: string | null
  expected_version?: number
}

export interface ContractLineCreateRequest {
  inventory_item_id: string
  quantity: number | string
  agreed_rate: number | string
  rate_unit?: string
  on_rent_date: string
  off_rent_date?: string | null
  billable?: boolean
  taxable?: boolean
  notes?: string | null
}

export interface ContractLinePatchRequest {
  quantity?: number | string
  agreed_rate?: number | string
  rate_unit?: string
  on_rent_date?: string
  off_rent_date?: string | null
  billable?: boolean
  taxable?: boolean
  status?: string
  notes?: string | null
  expected_version?: number
}

export interface BillingRunPreview {
  contract_id: string
  period_start: string
  period_end: string
  subtotal: number
  lines: Array<{
    contract_line_id: string
    inventory_item_id: string
    quantity: string
    agreed_rate: string
    billable_days: number
    amount: number
  }>
}

export function useCreateRentalContract(projectId: string) {
  const qc = useQueryClient()
  return useMutation<JobRentalContract, Error, ContractCreateRequest>({
    mutationFn: (input) =>
      request<JobRentalContract>(`/api/projects/${encodeURIComponent(projectId)}/rental-contracts`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rental-contracts'] }),
  })
}

export function usePatchRentalContract(id: string) {
  const qc = useQueryClient()
  return useMutation<JobRentalContract, Error, ContractPatchRequest>({
    mutationFn: (input) =>
      request<JobRentalContract>(`/api/rental-contracts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rental-contracts'] }),
  })
}

export function useRentalContractLines(contractId: string | null | undefined) {
  return useQuery<ContractLineListResponse>({
    queryKey: ['rental-contracts', 'lines', contractId ?? ''],
    queryFn: () => request<ContractLineListResponse>(`/api/rental-contracts/${encodeURIComponent(contractId!)}/lines`),
    enabled: Boolean(contractId),
  })
}

export function useCreateContractLine(contractId: string) {
  const qc = useQueryClient()
  return useMutation<RentalContractLine, Error, ContractLineCreateRequest>({
    mutationFn: (input) =>
      request<RentalContractLine>(`/api/rental-contracts/${encodeURIComponent(contractId)}/lines`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rental-contracts'] }),
  })
}

export function usePatchContractLine(id: string) {
  const qc = useQueryClient()
  return useMutation<RentalContractLine, Error, ContractLinePatchRequest>({
    mutationFn: (input) =>
      request<RentalContractLine>(`/api/rental-contract-lines/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rental-contracts'] }),
  })
}

export function useDeleteContractLine() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; expected_version?: number }>({
    mutationFn: ({ id, expected_version }) =>
      request(`/api/rental-contract-lines/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rental-contracts'] }),
  })
}

export function usePreviewBillingRun(contractId: string) {
  return useMutation<BillingRunPreview, Error, { period_end?: string }>({
    mutationFn: (input) =>
      request<BillingRunPreview>(`/api/rental-contracts/${encodeURIComponent(contractId)}/billing-runs/preview`, {
        method: 'POST',
        json: input,
      }),
  })
}

export function useGenerateBillingRun(contractId: string) {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { period_end?: string }>({
    mutationFn: (input) =>
      request(`/api/rental-contracts/${encodeURIComponent(contractId)}/billing-runs`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing-runs'] }),
  })
}

// ---------------------------------------------------------------------------
// Returns reconciliation (Phase 5: rental returns + transfer)
// ---------------------------------------------------------------------------

export interface RentalReturnRequest {
  qty_good: number
  qty_damaged: number
  qty_lost: number
  damage_photos: string[]
  damage_charges_cents: number
  original_qty?: number
}

export interface RentalRow {
  id: string
  company_id: string
  project_id: string | null
  customer_id: string | null
  item_description: string
  daily_rate: string
  delivered_on: string
  returned_on: string | null
  invoice_cadence_days: number
  status: string
  notes: string | null
  qty_good: number | null
  qty_damaged: number | null
  qty_lost: number | null
  damage_photos: string[]
  damage_charges_cents: string
  damage_work_order_id: string | null
  transferred_from_rental_id: string | null
  version: number
}

export function useRentalReturn(rentalId: string) {
  const qc = useQueryClient()
  return useMutation<RentalRow, Error, RentalReturnRequest>({
    mutationFn: (input) =>
      request<RentalRow>(`/api/rentals/${encodeURIComponent(rentalId)}/return`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rentals'] })
      qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

export interface RentalTransferRequest {
  to_project_id: string
  transferred_at?: string
}

export interface RentalTransferResponse {
  closed: RentalRow
  created: RentalRow
}

export function useRentalTransfer(rentalId: string) {
  const qc = useQueryClient()
  return useMutation<RentalTransferResponse, Error, RentalTransferRequest>({
    mutationFn: (input) =>
      request<RentalTransferResponse>(`/api/rentals/${encodeURIComponent(rentalId)}/transfer`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rentals'] })
      qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

// ---------------------------------------------------------------------------
// Demand forecast (utilization view, 6-week SVG chart)
// ---------------------------------------------------------------------------

export interface ForecastWeek {
  week_start: string
  projected_on_rent_qty: string
  projected_idle_qty: string
}

export interface ForecastResponse {
  inventory_item_id: string
  weeks: ForecastWeek[]
}

export function useInventoryForecast(itemId: string | null | undefined, weeks = 6) {
  return useQuery<ForecastResponse>({
    queryKey: ['inventory', 'forecast', itemId ?? '', weeks],
    queryFn: () =>
      request<ForecastResponse>(`/api/inventory-items/${encodeURIComponent(itemId!)}/forecast?weeks=${weeks}`),
    enabled: Boolean(itemId),
  })
}

// ---------------------------------------------------------------------------
// Rental rate tiers (per-line tiered pricing — migration 067)
// ---------------------------------------------------------------------------

export type RentalRateUnit = 'day' | 'week' | 'month' | 'cycle' | 'each'

export interface RentalRateTier {
  id: string
  job_rental_line_id: string
  rate_unit: RentalRateUnit
  min_days: number
  max_days: number | null
  rate: string
  sort_order: number
}

export interface RentalRateTierListResponse {
  rateTiers: RentalRateTier[]
}

export interface RentalRateTierCreateRequest {
  rate_unit: RentalRateUnit
  min_days: number
  max_days: number | null
  rate: number
  sort_order?: number
}

export function useRentalRateTiers(lineId: string | null | undefined) {
  return useQuery<RentalRateTierListResponse>({
    queryKey: ['rental-rate-tiers', lineId ?? ''],
    queryFn: () =>
      request<RentalRateTierListResponse>(`/api/rental-contract-lines/${encodeURIComponent(lineId!)}/rate-tiers`),
    enabled: Boolean(lineId),
  })
}

export function useCreateRentalRateTier(lineId: string) {
  const qc = useQueryClient()
  return useMutation<RentalRateTier, Error, RentalRateTierCreateRequest>({
    mutationFn: (input) =>
      request<RentalRateTier>(`/api/rental-contract-lines/${encodeURIComponent(lineId)}/rate-tiers`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rental-rate-tiers', lineId] })
      qc.invalidateQueries({ queryKey: ['rental-contracts'] })
    },
  })
}

export function useDeleteRentalRateTier(lineId: string) {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { tierId: string }>({
    mutationFn: ({ tierId }) =>
      request(`/api/rental-contract-lines/${encodeURIComponent(lineId)}/rate-tiers/${encodeURIComponent(tierId)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rental-rate-tiers', lineId] })
      qc.invalidateQueries({ queryKey: ['rental-contracts'] })
    },
  })
}
