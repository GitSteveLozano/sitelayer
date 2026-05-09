/**
 * api-v1-compat — type defs + thin function shims for Steve's mobile shell
 * (apps/web/src/screens/mobile-shell.tsx and friends, migrated from
 * apps/web/src/ in PR #235).
 *
 * Originally a verbatim copy of the 1.6k-line apps/web/src/api.ts. As of
 * 2026-05-04 the function bodies are gone — apiGet/apiPost/apiPatch
 * delegate to v2's `lib/api/client.ts:request<T>()`, which is the same
 * code v2's TanStack Query hooks use under the hood. So there's exactly
 * one HTTP client in v2 now; this file just preserves the v1-style
 * function signatures and types the mobile screens were already importing.
 *
 * Types kept verbatim from v1 because the mobile screens reference them
 * directly. They're plain shapes; deduplicating against v2's narrower
 * resource types is real product work, not a bug-fix.
 */
import { request, getActiveCompanySlug } from './lib/api/client'

// ----------------------------------------------------------------------
// Type definitions (verbatim from v1's apps/web/src/api.ts)
// ----------------------------------------------------------------------

export type BootstrapResponse = {
  company: { id: string; name: string; slug: string }
  template: { slug: string; name: string; description: string }
  workflowStages: string[]
  divisions: Array<{ code: string; name: string; sort_order: number }>
  serviceItems: Array<{
    code: string
    name: string
    category: string
    unit: string
    default_rate: string | null
    source: string
  }>
  customers: Array<{
    id: string
    name: string
    external_id: string | null
    source: string
    version: number
    deleted_at: string | null
  }>
  projects: Array<ProjectRow>
  workers: Array<WorkerRow>
  pricingProfiles: Array<PricingProfileRow>
  bonusRules: Array<BonusRuleRow>
  integrations: Array<{
    id: string
    provider: string
    provider_account_id: string | null
    sync_cursor: string | null
    status: string
  }>
  integrationMappings: Array<IntegrationMappingRow>
  laborEntries: Array<LaborRow>
  materialBills: Array<MaterialBillRow>
  schedules: Array<{
    id: string
    project_id: string
    scheduled_for: string
    crew: unknown[]
    status: string
    version: number
    deleted_at: string | null
    created_at?: string
  }>
  // Caller's own active project assignments. Drives the contextual mobile
  // shell — see apps/web/src/lib/active-context.ts.
  projectAssignments?: Array<ProjectAssignmentRow>
}

export type ProjectAssignmentRow = {
  id: string
  project_id: string
  role: 'foreman' | 'worker'
  assigned_by_clerk_user_id: string | null
  created_at: string
}

export type ProjectRow = {
  id: string
  customer_id: string | null
  name: string
  customer_name: string
  division_code: string
  status: string
  bid_total: string
  labor_rate: string
  target_sqft_per_hr: string | null
  bonus_pool: string
  closed_at: string | null
  summary_locked_at: string | null
  site_lat?: string | null
  site_lng?: string | null
  site_radius_m?: number | null
  version: number
  created_at: string
  updated_at: string
}

export type WorkerRow = {
  id: string
  name: string
  role: string
  version: number
  deleted_at: string | null
  created_at: string
}

export type LaborRow = {
  id: string
  project_id: string
  worker_id: string | null
  service_item_code: string
  hours: string
  sqft_done: string
  status: string
  occurred_on: string
  version: number
  deleted_at: string | null
  created_at: string
}

export type MaterialBillRow = {
  id: string
  project_id: string
  vendor: string
  amount: string
  bill_type: string
  description: string | null
  occurred_on: string | null
  version: number
  deleted_at: string | null
  created_at: string
}

export type PricingProfileRow = {
  id: string
  name: string
  is_default: boolean
  config: Record<string, unknown>
  version: number
  created_at: string
}

export type BonusRuleRow = {
  id: string
  name: string
  config: Record<string, unknown>
  is_active: boolean
  version: number
  created_at: string
}

export type IntegrationMappingRow = {
  id: string
  provider: string
  entity_type: string
  local_ref: string
  external_id: string
  label: string | null
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type ProjectSummary = {
  project: ProjectRow
  metrics: {
    totalMeasurementQuantity: number
    estimateTotal: number
    laborCost: number
    materialCost: number
    subCost: number
    totalCost: number
    margin: { revenue: number; cost: number; profit: number; margin: number }
    bonus: { eligible: boolean; payoutPercent: number; payout: number }
  }
  measurements: Array<{ service_item_code: string; quantity: string; unit: string; notes: string | null }>
  estimateLines: Array<{ service_item_code: string; quantity: string; unit: string; rate: string; amount: string }>
  laborEntries: LaborRow[]
}

export type SessionResponse = {
  user: { id: string; role: string }
  activeCompany: { id: string; name: string; slug: string }
  memberships: Array<{
    id: string
    company_id: string
    clerk_user_id: string
    role: string
    created_at: string
    slug: string
    name: string
  }>
}

export type InventoryItemRow = {
  id: string
  code: string
  description: string
  category: string
  unit: string
  default_rental_rate: string
  replacement_value: string | null
  tracking_mode: 'quantity' | 'serialized'
  active: boolean
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

// ----------------------------------------------------------------------
// Function shims — delegate to v2's request<T>()
// ----------------------------------------------------------------------

function withSlug(companySlug: string | undefined): { companySlug?: string } {
  return companySlug !== undefined ? { companySlug } : {}
}

export function apiGet<T>(path: string, companySlug?: string): Promise<T> {
  return request<T>(path, { method: 'GET', ...withSlug(companySlug) })
}

export function apiPost<T>(path: string, body: unknown, companySlug?: string): Promise<T> {
  return request<T>(path, { method: 'POST', json: body, ...withSlug(companySlug) })
}

export function apiPatch<T>(path: string, body: unknown, companySlug?: string): Promise<T> {
  return request<T>(path, { method: 'PATCH', json: body, ...withSlug(companySlug) })
}

export function apiDelete<T>(path: string, companySlug?: string): Promise<T> {
  return request<T>(path, { method: 'DELETE', ...withSlug(companySlug) })
}

/**
 * Single-call helper used by Steve's rentals/inventory mobile screens.
 * Mirrors the v1 export so the mobile screens don't need a code change.
 */
export async function listInventoryItems(companySlug: string): Promise<{ inventoryItems: InventoryItemRow[] }> {
  return apiGet<{ inventoryItems: InventoryItemRow[] }>('/api/inventory/items', companySlug)
}

export type InventoryLocationRow = {
  id: string
  company_id: string
  project_id: string | null
  name: string
  location_type: 'yard' | 'job_site' | 'service' | string
  is_default: boolean
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export async function listInventoryLocations(
  companySlug: string,
): Promise<{ inventoryLocations: InventoryLocationRow[] }> {
  return apiGet<{ inventoryLocations: InventoryLocationRow[] }>('/api/inventory/locations', companySlug)
}

/**
 * Active company-slug accessor. v1 stored this in localStorage; v2's
 * lib/api/client.ts has its own active-slug state. This shim points at
 * v2's so both surfaces agree on which company a request is about.
 */
export function getStoredCompanySlug(): string {
  return getActiveCompanySlug()
}

export const DEFAULT_COMPANY_SLUG = 'la-operations'

// ----------------------------------------------------------------------
// Workflow snapshot types — re-exported from v2's lib/api/* under the
// v1-style names that the moved XState machines use. These workflows are
// the temporal.io-style backend (packages/workflows/), so the types are
// canonically defined there and surfaced via TanStack hooks; the shim
// just bridges naming.
// ----------------------------------------------------------------------

export {
  type EstimatePushHumanEvent,
  type EstimatePushSnapshot as EstimatePushWorkflowSnapshotResponse,
  type EstimatePushLine,
  type EstimatePushState as EstimatePushWorkflowState,
  fetchEstimatePush as getEstimatePushSnapshotInner,
} from './lib/api/estimate-pushes'

export {
  type RentalBillingHumanEvent,
  type RentalBillingSnapshot as RentalBillingWorkflowSnapshotResponse,
  type RentalBillingRunLine,
  type RentalBillingState as RentalBillingWorkflowState,
  fetchBillingRun as getRentalBillingRunSnapshotInner,
} from './lib/api/billing-runs'

import {
  fetchEstimatePush as _fetchEstimatePush,
  type EstimatePushHumanEvent as _EstimatePushHumanEvent,
  type EstimatePushSnapshot as _EstimatePushSnapshot,
} from './lib/api/estimate-pushes'
import {
  fetchBillingRun as _fetchBillingRun,
  type RentalBillingHumanEvent as _RentalBillingHumanEvent,
  type RentalBillingSnapshot as _RentalBillingSnapshot,
} from './lib/api/billing-runs'

/** v1-style (id, slug) — the machines were written before v2's TanStack
 *  hooks existed. Slug is now derived from request<T>() context, so the
 *  arg is accepted for compatibility but ignored. */
export function getEstimatePushSnapshot(pushId: string, _companySlug?: string): Promise<_EstimatePushSnapshot> {
  return _fetchEstimatePush(pushId)
}

export function dispatchEstimatePushEvent(
  pushId: string,
  event: _EstimatePushHumanEvent,
  stateVersion: number,
  _companySlug?: string,
): Promise<_EstimatePushSnapshot> {
  return apiPost<_EstimatePushSnapshot>(`/api/estimate-pushes/${pushId}/events`, {
    event,
    state_version: stateVersion,
  })
}

// ----------------------------------------------------------------------
// Project lifecycle workflow — bridges the project-lifecycle xstate machine
// to GET /api/projects/:id/lifecycle and POST /:id/lifecycle/events.
// Same v1-style (id, slug) signature as estimate-push for parity.
// ----------------------------------------------------------------------

export type ProjectLifecycleHumanEvent =
  | 'START_ESTIMATING'
  | 'SEND'
  | 'ACCEPT'
  | 'DECLINE'
  | 'START_WORK'
  | 'COMPLETE'
  | 'ARCHIVE'
  | 'REOPEN'

export type ProjectLifecycleWorkflowState =
  | 'draft'
  | 'estimating'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'in_progress'
  | 'done'
  | 'archived'

export type ProjectLifecycleSnapshotResponse = {
  state: ProjectLifecycleWorkflowState
  state_version: number
  context: {
    project_id: string
    name: string
    customer_name: string
    sent_at: string | null
    accepted_at: string | null
    declined_at: string | null
    decline_reason: string | null
    started_at: string | null
    completed_at: string | null
    archived_at: string | null
  }
  next_events: Array<{ type: ProjectLifecycleHumanEvent; label: string; disabled_reason?: string }>
}

export function getProjectLifecycleSnapshot(
  projectId: string,
  _companySlug?: string,
): Promise<ProjectLifecycleSnapshotResponse> {
  return apiGet<ProjectLifecycleSnapshotResponse>(`/api/projects/${projectId}/lifecycle`)
}

export function dispatchProjectLifecycleEvent(
  projectId: string,
  event: ProjectLifecycleHumanEvent,
  stateVersion: number,
  reason?: string,
  _companySlug?: string,
): Promise<ProjectLifecycleSnapshotResponse> {
  return apiPost<ProjectLifecycleSnapshotResponse>(`/api/projects/${projectId}/lifecycle/events`, {
    event,
    state_version: stateVersion,
    ...(reason ? { reason } : {}),
  })
}

export function getRentalBillingRunSnapshot(runId: string, _companySlug?: string): Promise<_RentalBillingSnapshot> {
  return _fetchBillingRun(runId)
}

export function dispatchRentalBillingEvent(
  runId: string,
  event: _RentalBillingHumanEvent,
  stateVersion: number,
  _companySlug?: string,
): Promise<_RentalBillingSnapshot> {
  return apiPost<_RentalBillingSnapshot>(`/api/rental-billing-runs/${runId}/events`, {
    event,
    state_version: stateVersion,
  })
}

// ----------------------------------------------------------------------
// Workflow / state machine glue — re-exports v2's existing primitives
// under v1-style names that the moved XState machines were written
// against.
// ----------------------------------------------------------------------

export type { OfflineMutation } from './lib/offline/queue'
import { listOfflineMutations as _listOfflineMutations } from './lib/offline/queue'
import { replayOfflineQueue as _replayOfflineQueue } from './lib/offline/replay'

/** v1 name for v2's listOfflineMutations. */
export function readOfflineQueue() {
  return _listOfflineMutations()
}

/** v1 name for v2's replayOfflineQueue. The v1 machine passed
 *  companySlug; v2's queue carries it per-mutation, so the arg is
 *  accepted for compatibility but ignored. */
export async function replayOfflineMutations(_companySlug?: string) {
  return _replayOfflineQueue()
}

// ----------------------------------------------------------------------
// Misc types the bootstrap-refresh + project-selection machines need
// ----------------------------------------------------------------------

export type TierRibbon = { label: string; tone: 'info' | 'warn' | 'danger' } | null

export type FeaturesResponse = {
  tier: 'local' | 'dev' | 'preview' | 'prod'
  flags: string[]
  ribbon: TierRibbon
}

export type CompaniesResponse = {
  companies: Array<{ id: string; slug: string; name: string; created_at: string; role?: string }>
}

export type SyncStatusResponse = {
  company: { id: string; name: string; slug: string }
  pendingOutboxCount: number
  pendingSyncEventCount: number
  latestSyncEvent: {
    created_at: string
    entity_type: string
    entity_id: string
    direction: string
    status: string
  } | null
  connections: Array<{
    id: string
    provider: string
    provider_account_id: string | null
    sync_cursor: string | null
    last_synced_at: string | null
    status: string
    version: number
    created_at: string
  }>
}

export type QboConnectionResponse = {
  connection: SyncStatusResponse['connections'][number] | null
  status: SyncStatusResponse
}

export type ScheduleRow = {
  id: string
  project_id: string
  scheduled_for: string
  crew: unknown[]
  status: string
  version: number
  deleted_at: string | null
  created_at?: string
}

export type BlueprintRow = {
  id: string
  project_id: string
  file_name: string
  storage_path: string
  preview_type: string
  calibration_length: string | null
  calibration_unit: string | null
  sheet_scale: string | null
  version: number
  deleted_at: string | null
  replaces_blueprint_document_id: string | null
  file_url: string
  created_at: string
}

export type MeasurementRow = {
  id: string
  project_id: string
  blueprint_document_id: string | null
  service_item_code: string
  quantity: string
  unit: string
  notes: string | null
  geometry: { kind?: string; points?: Array<{ x: number; y: number }>; label?: string } | Record<string, unknown>
  version: number
  deleted_at: string | null
  created_at: string
}
