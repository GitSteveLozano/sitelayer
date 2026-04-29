import { Sentry } from './instrument.js'

// Shared API types
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

export type ClockEventRow = {
  id: string
  company_id: string
  worker_id: string | null
  project_id: string | null
  clerk_user_id: string | null
  event_type: 'in' | 'out' | 'auto_out_geo' | 'auto_out_idle'
  occurred_at: string
  lat: string | null
  lng: string | null
  accuracy_m: string | null
  inside_geofence: boolean | null
  notes: string | null
  created_at: string
}

export type ClockTimelineResponse = {
  events: ClockEventRow[]
}

export type ClockPunchResponse = {
  clockEvent: ClockEventRow
  laborEntry?: LaborRow | null
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

export type RentalRow = {
  id: string
  company_id: string
  project_id: string | null
  customer_id: string | null
  item_description: string
  daily_rate: string
  delivered_on: string
  returned_on: string | null
  next_invoice_at: string | null
  invoice_cadence_days: number
  last_invoice_amount: string | null
  last_invoiced_through: string | null
  status: 'active' | 'returned' | 'invoiced_pending' | 'closed'
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type ListRentalsResponse = {
  rentals: RentalRow[]
}

export type RentalInvoiceResponse = {
  rental: RentalRow
  bill: {
    id: string
    project_id: string | null
    vendor_name: string
    amount: string
    bill_type: string
    description: string | null
    occurred_on: string | null
    created_at: string
  } | null
  days: number
  amount: number
  invoiced_through: string
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

export type OfflineMutation = {
  id: string
  method: 'POST' | 'PATCH' | 'DELETE'
  path: string
  body: unknown
  companySlug: string
  userId: string
  createdAt: string
  /**
   * ISO timestamp captured at enqueue-time. When the mutation replays the
   * frontend sends it as `If-Unmodified-Since` so the API can apply the
   * last-write-wins gate (see Decisions #4 in CLAUDE.md). Optional for
   * back-compat with queue entries that were persisted before the LWW path
   * shipped — those replay without the header and the API skips the check.
   */
  clientUpdatedAt?: string
  /**
   * Optional human label used in the conflict toast when a 409 is returned.
   * If absent we fall back to the path. The frontend mutation builders
   * supply this when the entity name is meaningful (e.g. "measurement").
   */
  entityLabel?: string
}

/**
 * Best-effort entity label inferred from the request path so older queue
 * entries (which lack `entityLabel`) still produce a useful toast.
 */
function inferEntityLabel(path: string): string {
  const segments = path.split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment === 'api' || /^[0-9a-f-]{8,}$/i.test(segment)) continue
    return segment.replace(/-/g, ' ').replace(/_/g, ' ')
  }
  return 'item'
}

export type TierRibbon = { label: string; tone: 'info' | 'warn' | 'danger' } | null

export type FeaturesResponse = {
  tier: 'local' | 'dev' | 'preview' | 'prod'
  flags: string[]
  ribbon: TierRibbon
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

export type CompaniesResponse = {
  companies: Array<{ id: string; slug: string; name: string; created_at: string; role?: string }>
}

export type CreateCompanyResponse = {
  company: { id: string; slug: string; name: string; created_at: string }
  role: string
}

export type CreateMembershipResponse = {
  membership: {
    id: string
    company_id: string
    clerk_user_id: string
    role: string
    created_at: string
  }
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

export type AuditEventRow = {
  id: string
  actor_user_id: string | null
  actor_role: string | null
  entity_type: string
  entity_id: string
  action: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  request_id: string | null
  sentry_trace: string | null
  created_at: string
}

export type AuditEventsResponse = {
  events: AuditEventRow[]
}

export type AuditEventFilters = {
  entityType?: string
  entityId?: string
  actorUserId?: string
  since?: string
  limit?: number
}

export async function listAuditEventsApi(
  filters: AuditEventFilters,
  companySlug: string,
): Promise<AuditEventsResponse> {
  const params = new URLSearchParams()
  if (filters.entityType) params.set('entity_type', filters.entityType)
  if (filters.entityId) params.set('entity_id', filters.entityId)
  if (filters.actorUserId) params.set('actor_user_id', filters.actorUserId)
  if (filters.since) params.set('since', filters.since)
  if (filters.limit) params.set('limit', String(filters.limit))
  const suffix = params.toString() ? `?${params.toString()}` : ''
  return apiGet<AuditEventsResponse>(`/api/audit-events${suffix}`, companySlug)
}

type QboAuthResponse = {
  authUrl: string
}

class QueueableMutationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueableMutationError'
  }
}

// Configuration
export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
export const DEFAULT_COMPANY_SLUG = import.meta.env.VITE_COMPANY_SLUG ?? 'la-operations'
/** @deprecated Retained for fixtures/legacy storage compat. The runtime user id now comes from Clerk. */
export const DEFAULT_USER_ID = import.meta.env.VITE_USER_ID ?? 'demo-user'
export const FIXTURES_ENABLED = import.meta.env.VITE_FIXTURES === '1' || import.meta.env.VITE_FIXTURES === 'true'
const RESPONSE_CACHE_PREFIX = 'sitelayer.cache'
const MUTATION_QUEUE_KEY = 'sitelayer.offlineQueue'

// Clerk session token provider. Registered once at boot from <App> via useAuth().getToken.
// Returning null means "no signed-in user" — calls fall back to no Authorization header,
// which the prod API will reject once AUTH_ALLOW_HEADER_FALLBACK is flipped to 0.
type TokenProvider = () => Promise<string | null>
let tokenProvider: TokenProvider = async () => null

export function registerClerkTokenProvider(fn: TokenProvider) {
  tokenProvider = fn
}

async function authHeaders(companySlug: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'x-sitelayer-company-slug': companySlug }
  try {
    const token = await tokenProvider()
    if (token) headers['Authorization'] = `Bearer ${token}`
  } catch (error) {
    // Token provider failures should not crash request building; the API's auth
    // layer will return 401 and the caller can surface that. Surface to Sentry.
    Sentry.captureException(error, { tags: { scope: 'clerk_token_provider' } })
  }
  return headers
}

/** @deprecated The SPA uses Clerk session JWTs now; user id is server-derived. Fixtures still read this. */
export function getStoredUserId() {
  if (typeof window === 'undefined') return DEFAULT_USER_ID
  return window.localStorage.getItem('sitelayer.userId') ?? DEFAULT_USER_ID
}

/** @deprecated Kept for fixtures compat; production no longer writes user id from the client. */
export function setStoredUserId(userId: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('sitelayer.userId', userId)
}

export function getStoredCompanySlug() {
  if (typeof window === 'undefined') return DEFAULT_COMPANY_SLUG
  return window.localStorage.getItem('sitelayer.companySlug') ?? DEFAULT_COMPANY_SLUG
}

export function setStoredCompanySlug(slug: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('sitelayer.companySlug', slug)
}

// Caching
function cacheKey(companySlug: string, path: string) {
  return `${RESPONSE_CACHE_PREFIX}:${companySlug}:${path}`
}

function readCachedResponse<T>(companySlug: string, path: string): T | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(cacheKey(companySlug, path))
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function cacheResponse(companySlug: string, path: string, value: unknown) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(cacheKey(companySlug, path), JSON.stringify(value))
}

function invalidateCompanyCache(companySlug: string) {
  if (typeof window === 'undefined') return
  const prefix = `${RESPONSE_CACHE_PREFIX}:${companySlug}:`
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index)
    if (key && key.startsWith(prefix)) {
      window.localStorage.removeItem(key)
    }
  }
}

// Offline queue
export async function readOfflineQueue(): Promise<OfflineMutation[]> {
  if (typeof window === 'undefined') return []
  const raw = window.localStorage.getItem(MUTATION_QUEUE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as OfflineMutation[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeOfflineQueue(queue: OfflineMutation[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(MUTATION_QUEUE_KEY, JSON.stringify(queue))
}

export async function enqueueOfflineMutation(mutation: Omit<OfflineMutation, 'id' | 'createdAt'>) {
  if (typeof window === 'undefined') return
  const queue = await readOfflineQueue()
  const now = new Date().toISOString()
  queue.push({
    ...mutation,
    id: `${mutation.method.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: now,
    // Default `clientUpdatedAt` to enqueue time when the caller didn't supply
    // one. This is the timestamp the LWW gate compares against on replay.
    clientUpdatedAt: mutation.clientUpdatedAt ?? now,
  })
  await writeOfflineQueue(queue)
  Sentry.addBreadcrumb({
    category: 'offline_queue',
    type: 'info',
    level: 'info',
    message: `enqueued ${mutation.method} ${mutation.path}`,
    data: { depth: queue.length, method: mutation.method, path: mutation.path, companySlug: mutation.companySlug },
  })
  window.dispatchEvent(new Event('sitelayer:offline-queue'))
}

// API methods
export async function apiGet<T>(path: string, companySlug: string): Promise<T> {
  if (FIXTURES_ENABLED) {
    const { getFixtureResponse } = await import('./fixtures.js')
    return getFixtureResponse<T>(path, companySlug)
  }
  const response = await fetch(`${API_URL}${path}`, {
    headers: await authHeaders(companySlug),
  })
  if (!response.ok) {
    const cached = readCachedResponse<T>(companySlug, path)
    if (cached !== null) return cached
    throw new Error(`GET ${path} failed: ${response.status}`)
  }
  const parsed = (await response.json()) as T
  cacheResponse(companySlug, path, parsed)
  return parsed
}

async function apiMutate<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  companySlug: string,
): Promise<T> {
  if (FIXTURES_ENABLED) {
    const { mutateFixtureResponse } = await import('./fixtures.js')
    return mutateFixtureResponse<T>(method, path, body, companySlug)
  }
  try {
    const headers = await authHeaders(companySlug)
    headers['content-type'] = 'application/json'
    const requestInit: RequestInit = {
      method,
      headers,
    }
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body)
    }
    const response = await fetch(`${API_URL}${path}`, requestInit)
    if (!response.ok) {
      const fallback = await response.text()
      if (response.status >= 500) {
        throw new QueueableMutationError(`${method} ${path} failed: ${response.status} ${fallback}`)
      }
      throw new Error(`${method} ${path} failed: ${response.status} ${fallback}`)
    }
    const parsed = (await response.json()) as T
    invalidateCompanyCache(companySlug)
    cacheResponse(companySlug, path, parsed)
    return parsed
  } catch (error) {
    if (!(error instanceof QueueableMutationError)) {
      throw error
    }
    // userId is no longer load-bearing under Clerk auth — the JWT is fetched fresh
    // at replay time via tokenProvider. Persist a placeholder so older queued
    // entries (which had a real userId) still deserialize cleanly.
    await enqueueOfflineMutation({
      method,
      path,
      body,
      companySlug,
      userId: getStoredUserId(),
      // `clientUpdatedAt` defaults to enqueue-time inside enqueueOfflineMutation;
      // set explicitly here so the call site is self-documenting and so future
      // refactors that hoist enqueue out of the catch path retain the value.
      clientUpdatedAt: new Date().toISOString(),
    })
    console.warn(`[offline] queued ${method} ${path}`, error)
    return (body ?? { queued: true }) as T
  }
}

export async function apiPost<T>(path: string, body: unknown, companySlug: string): Promise<T> {
  return apiMutate<T>('POST', path, body, companySlug)
}

export async function apiPatch<T>(path: string, body: unknown, companySlug: string): Promise<T> {
  return apiMutate<T>('PATCH', path, body, companySlug)
}

export async function apiDelete<T>(path: string, companySlug: string, body?: unknown): Promise<T> {
  return apiMutate<T>('DELETE', path, body, companySlug)
}

/**
 * Streaming multipart blueprint upload. Bypasses the JSON+offline-queue path
 * because binary file bodies don't survive IndexedDB persistence cleanly and
 * blueprint uploads are typically office-side anyway. Caller is responsible
 * for retry on network failure.
 */
export async function apiUploadBlueprint<T>(
  method: 'POST' | 'PATCH',
  path: string,
  formData: FormData,
  companySlug: string,
): Promise<T> {
  if (FIXTURES_ENABLED) {
    const { mutateFixtureResponse } = await import('./fixtures.js')
    const summary: Record<string, unknown> = {}
    for (const [name, value] of formData.entries()) {
      if (typeof value === 'string') summary[name] = value
      else if (value instanceof File) summary[name] = { name: value.name, size: value.size }
    }
    return mutateFixtureResponse<T>(method, path, summary, companySlug)
  }
  const headers = await authHeaders(companySlug)
  // Don't set content-type — fetch derives the multipart boundary from the FormData body.
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: formData,
  })
  if (!response.ok) {
    const fallback = await response.text()
    throw new Error(`${method} ${path} failed: ${response.status} ${fallback}`)
  }
  const parsed = (await response.json()) as T
  invalidateCompanyCache(companySlug)
  cacheResponse(companySlug, path, parsed)
  return parsed
}

/**
 * Pull an estimate PDF as a Blob and trigger a browser download. Stays out
 * of `apiGet` because the response is binary and shouldn't be cached or
 * fed through the offline-queue path.
 */
export async function downloadEstimatePdf(projectId: string, projectName: string, companySlug: string): Promise<void> {
  const headers = await authHeaders(companySlug)
  const response = await fetch(`${API_URL}/api/projects/${projectId}/estimate.pdf`, { headers })
  if (!response.ok) {
    throw new Error(`Estimate PDF download failed: ${response.status}`)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    const safeName = projectName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'estimate'
    anchor.download = `estimate-${safeName}.pdf`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function createCompany(
  input: { slug: string; name: string; seed_defaults?: boolean },
  companySlug: string,
): Promise<CreateCompanyResponse> {
  return apiPost<CreateCompanyResponse>('/api/companies', input, companySlug)
}

export async function inviteMembership(
  companyId: string,
  input: { clerk_user_id: string; role?: string },
  companySlug: string,
): Promise<CreateMembershipResponse> {
  return apiPost<CreateMembershipResponse>(`/api/companies/${companyId}/memberships`, input, companySlug)
}

export async function replayOfflineMutations(companySlug: string) {
  if (FIXTURES_ENABLED) return
  if (typeof window === 'undefined') return
  const queue = await readOfflineQueue()
  if (!queue.length) return

  return Sentry.startSpan(
    {
      name: 'offline_queue.replay',
      op: 'queue.replay',
      attributes: {
        'queue.depth_before': queue.length,
        'queue.company_slug': companySlug,
      },
    },
    async (span) => {
      const remaining: OfflineMutation[] = []
      let replayed = 0
      let dropped = 0
      let conflicts = 0
      for (const mutation of queue) {
        if (mutation.companySlug !== companySlug) {
          remaining.push(mutation)
          continue
        }

        try {
          // Re-fetch a fresh Clerk token per mutation; tokens expire in ~60s and
          // the queue may have been parked across multiple sign-in sessions.
          const headers = await authHeaders(mutation.companySlug)
          headers['content-type'] = 'application/json'
          if (mutation.clientUpdatedAt) {
            // LWW gate (see Decisions #4): server compares its row's
            // updated_at against this header. If the server has a newer
            // change we get 409 and drop our queued mutation.
            headers['If-Unmodified-Since'] = mutation.clientUpdatedAt
          }
          const requestInit: RequestInit = {
            method: mutation.method,
            headers,
          }
          if (mutation.body !== undefined) {
            requestInit.body = JSON.stringify(mutation.body)
          }
          const response = await fetch(`${API_URL}${mutation.path}`, requestInit)
          if (!response.ok) {
            if (response.status === 409) {
              // Last-write-wins: a newer change was synced from another
              // device, so drop this queued mutation rather than re-queue.
              conflicts += 1
              dropped += 1
              const entityLabel = mutation.entityLabel ?? inferEntityLabel(mutation.path)
              Sentry.addBreadcrumb({
                category: 'offline_queue',
                level: 'warning',
                message: `lww conflict ${mutation.method} ${mutation.path}`,
                data: { status: 409, path: mutation.path, entity: entityLabel },
              })
              try {
                const { toastInfo } = await import('./components/ui/toast.js')
                toastInfo(
                  'Local edit discarded',
                  `A newer change for ${entityLabel} was synced from another device — your local edit was discarded.`,
                )
              } catch (toastErr) {
                Sentry.captureException(toastErr, { tags: { scope: 'offline_replay_toast' } })
              }
              continue
            }
            if (response.status >= 400 && response.status < 500) {
              dropped += 1
              Sentry.addBreadcrumb({
                category: 'offline_queue',
                level: 'warning',
                message: `dropped invalid ${mutation.method} ${mutation.path}`,
                data: { status: response.status, path: mutation.path },
              })
              continue
            }
            throw new Error(`${mutation.method} ${mutation.path} failed: ${response.status}`)
          }
          const parsed = await response.json().catch(() => null)
          if (parsed !== null) {
            invalidateCompanyCache(mutation.companySlug)
            cacheResponse(mutation.companySlug, mutation.path, parsed)
          }
          replayed += 1
        } catch (error) {
          Sentry.captureException(error, {
            tags: { scope: 'offline_replay' },
            extra: { path: mutation.path, method: mutation.method },
          })
          remaining.push(mutation)
        }
      }
      await writeOfflineQueue(remaining)
      span?.setAttribute('queue.replayed', replayed)
      span?.setAttribute('queue.dropped', dropped)
      span?.setAttribute('queue.conflicts', conflicts)
      span?.setAttribute('queue.depth_after', remaining.length)
      window.dispatchEvent(new Event('sitelayer:offline-queue'))
    },
  )
}

export type RentalStatusFilter = 'active' | 'returned' | 'closed' | 'all'

export async function listRentals(
  companySlug: string,
  status: RentalStatusFilter = 'active',
): Promise<ListRentalsResponse> {
  const suffix = status === 'active' ? '' : `?status=${status}`
  return apiGet<ListRentalsResponse>(`/api/rentals${suffix}`, companySlug)
}

export type CreateRentalInput = {
  item_description: string
  daily_rate: number
  delivered_on: string
  returned_on?: string | null
  invoice_cadence_days?: number
  project_id?: string | null
  customer_id?: string | null
  notes?: string | null
}

export async function createRental(input: CreateRentalInput, companySlug: string): Promise<RentalRow> {
  return apiPost<RentalRow>('/api/rentals', input, companySlug)
}

export async function updateRental(
  rentalId: string,
  input: Partial<CreateRentalInput & { status: RentalRow['status']; expected_version: number }>,
  companySlug: string,
): Promise<RentalRow> {
  return apiPatch<RentalRow>(`/api/rentals/${rentalId}`, input, companySlug)
}

export async function markRentalReturned(
  rentalId: string,
  returnedOn: string,
  expectedVersion: number,
  companySlug: string,
): Promise<RentalRow> {
  return updateRental(
    rentalId,
    { returned_on: returnedOn, status: 'returned', expected_version: expectedVersion },
    companySlug,
  )
}

export async function triggerRentalInvoice(rentalId: string, companySlug: string): Promise<RentalInvoiceResponse> {
  return apiPost<RentalInvoiceResponse>(`/api/rentals/${rentalId}/invoice`, {}, companySlug)
}

export async function deleteRental(
  rentalId: string,
  companySlug: string,
  expectedVersion?: number,
): Promise<RentalRow> {
  return apiDelete<RentalRow>(
    `/api/rentals/${rentalId}`,
    companySlug,
    expectedVersion ? { expected_version: expectedVersion } : undefined,
  )
}

// ---------------------------------------------------------------------------
// Inventory catalog client.
// ---------------------------------------------------------------------------

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

export type InventoryItemInput = {
  code: string
  description: string
  category?: string | null
  unit?: string | null
  default_rental_rate?: number | string | null
  replacement_value?: number | string | null
  tracking_mode?: 'quantity' | 'serialized' | null
  active?: boolean | null
  notes?: string | null
}

export async function listInventoryItems(companySlug: string): Promise<{ inventoryItems: InventoryItemRow[] }> {
  return apiGet<{ inventoryItems: InventoryItemRow[] }>('/api/inventory/items', companySlug)
}

export async function createInventoryItem(input: InventoryItemInput, companySlug: string): Promise<InventoryItemRow> {
  return apiPost<InventoryItemRow>('/api/inventory/items', input, companySlug)
}

export async function updateInventoryItem(
  itemId: string,
  input: Partial<InventoryItemInput> & { expected_version?: number },
  companySlug: string,
): Promise<InventoryItemRow> {
  return apiPatch<InventoryItemRow>(`/api/inventory/items/${itemId}`, input, companySlug)
}

export async function deleteInventoryItem(
  itemId: string,
  companySlug: string,
  expectedVersion?: number,
): Promise<InventoryItemRow> {
  return apiDelete<InventoryItemRow>(
    `/api/inventory/items/${itemId}`,
    companySlug,
    expectedVersion ? { expected_version: expectedVersion } : undefined,
  )
}

// ---------------------------------------------------------------------------
// Job rental contracts + lines client. Each project gets at most one active
// contract (per the unique partial index on job_rental_contracts (project_id,
// active)); each contract has 0+ rental lines that map an inventory item to
// an agreed price + rate unit + on/off-rent dates. Billing runs preview and
// generate against this shape.
// ---------------------------------------------------------------------------

export type JobRentalContractRow = {
  id: string
  project_id: string
  customer_id: string | null
  billing_cycle_days: number
  billing_mode: string
  billing_start_date: string
  last_billed_through: string | null
  next_billing_date: string
  status: 'draft' | 'active' | 'paused' | 'closed'
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type JobRentalLineRow = {
  id: string
  contract_id: string
  inventory_item_id: string
  item_code: string | null
  item_description: string | null
  quantity: string
  agreed_rate: string
  rate_unit: 'day' | 'cycle' | 'week' | 'month' | 'each'
  on_rent_date: string
  off_rent_date: string | null
  last_billed_through: string | null
  billable: boolean
  taxable: boolean
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export async function listProjectRentalContracts(
  projectId: string,
  companySlug: string,
): Promise<{ rentalContracts: JobRentalContractRow[] }> {
  return apiGet<{ rentalContracts: JobRentalContractRow[] }>(`/api/projects/${projectId}/rental-contracts`, companySlug)
}

export type CreateRentalContractInput = {
  customer_id?: string | null
  billing_cycle_days?: number
  billing_mode?: string
  billing_start_date?: string
  notes?: string | null
}

export async function createRentalContract(
  projectId: string,
  input: CreateRentalContractInput,
  companySlug: string,
): Promise<JobRentalContractRow> {
  return apiPost<JobRentalContractRow>(`/api/projects/${projectId}/rental-contracts`, input, companySlug)
}

export async function updateRentalContract(
  contractId: string,
  input: Partial<CreateRentalContractInput & { status: string; expected_version: number }>,
  companySlug: string,
): Promise<JobRentalContractRow> {
  return apiPatch<JobRentalContractRow>(`/api/rental-contracts/${contractId}`, input, companySlug)
}

export async function listRentalContractLines(
  contractId: string,
  companySlug: string,
): Promise<{ rentalLines: JobRentalLineRow[] }> {
  return apiGet<{ rentalLines: JobRentalLineRow[] }>(`/api/rental-contracts/${contractId}/lines`, companySlug)
}

export type RentalLineInput = {
  inventory_item_id: string
  quantity: number | string
  agreed_rate: number | string
  rate_unit?: JobRentalLineRow['rate_unit']
  on_rent_date?: string
  off_rent_date?: string | null
  billable?: boolean
  taxable?: boolean
  notes?: string | null
}

export async function createRentalLine(
  contractId: string,
  input: RentalLineInput,
  companySlug: string,
): Promise<JobRentalLineRow> {
  return apiPost<JobRentalLineRow>(`/api/rental-contracts/${contractId}/lines`, input, companySlug)
}

export async function updateRentalLine(
  lineId: string,
  input: Partial<RentalLineInput & { status: string; expected_version: number }>,
  companySlug: string,
): Promise<JobRentalLineRow> {
  return apiPatch<JobRentalLineRow>(`/api/rental-contract-lines/${lineId}`, input, companySlug)
}

export async function deleteRentalLine(
  lineId: string,
  companySlug: string,
  expectedVersion?: number,
): Promise<JobRentalLineRow> {
  return apiDelete<JobRentalLineRow>(
    `/api/rental-contract-lines/${lineId}`,
    companySlug,
    expectedVersion ? { expected_version: expectedVersion } : undefined,
  )
}

export type RentalBillingRunPreview = {
  period_start: string
  period_end: string
  due_date: string
  next_billing_date: string
  billing_cycle_days: number
  is_due: boolean
  subtotal: number
  lines: Array<{
    line_id: string
    inventory_item_id: string | null
    quantity: number
    agreed_rate: number
    rate_unit: string
    billable_days: number
    period_start: string
    period_end: string
    amount: number
    taxable: boolean
    description: string | null
  }>
}

export async function previewBillingRun(
  contractId: string,
  companySlug: string,
  referenceDate?: string,
): Promise<{ contract: JobRentalContractRow; preview: RentalBillingRunPreview }> {
  return apiPost<{ contract: JobRentalContractRow; preview: RentalBillingRunPreview }>(
    `/api/rental-contracts/${contractId}/billing-runs/preview`,
    referenceDate ? { reference_date: referenceDate } : {},
    companySlug,
  )
}

export async function generateBillingRun(
  contractId: string,
  companySlug: string,
  options?: { referenceDate?: string; force?: boolean },
): Promise<{ billingRun: { id: string }; lines: unknown[]; contract: JobRentalContractRow }> {
  return apiPost(
    `/api/rental-contracts/${contractId}/billing-runs`,
    {
      ...(options?.referenceDate ? { reference_date: options.referenceDate } : {}),
      ...(options?.force ? { force: true } : {}),
    },
    companySlug,
  )
}

export type InventoryAvailabilityRow = {
  inventory_item_id: string
  on_rent_quantity: string
  on_rent_lines: number
  on_rent_projects: number
}

export async function listInventoryAvailability(
  companySlug: string,
): Promise<{ availability: InventoryAvailabilityRow[] }> {
  return apiGet<{ availability: InventoryAvailabilityRow[] }>('/api/inventory/items/availability', companySlug)
}

export type InventoryMovementRow = {
  id: string
  inventory_item_id: string
  from_location_id: string | null
  to_location_id: string | null
  project_id: string | null
  movement_type: 'deliver' | 'return' | 'transfer' | 'adjustment' | 'damaged' | 'lost' | 'repair'
  quantity: string
  occurred_on: string
  ticket_number: string | null
  notes: string | null
  version: number
  created_at: string
  item_code: string | null
  item_description: string | null
  from_location_name: string | null
  to_location_name: string | null
  project_name: string | null
}

export async function listInventoryMovements(
  companySlug: string,
  filters?: { itemId?: string; projectId?: string; type?: InventoryMovementRow['movement_type'] },
): Promise<{ inventoryMovements: InventoryMovementRow[] }> {
  const params = new URLSearchParams()
  if (filters?.itemId) params.set('item_id', filters.itemId)
  if (filters?.projectId) params.set('project_id', filters.projectId)
  if (filters?.type) params.set('type', filters.type)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  return apiGet<{ inventoryMovements: InventoryMovementRow[] }>(`/api/inventory/movements${suffix}`, companySlug)
}

export type InventoryLocationRow = {
  id: string
  project_id: string | null
  name: string
  location_type: 'yard' | 'job' | 'in_transit' | 'repair' | 'lost' | 'damaged'
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

export type CreateMovementInput = {
  inventory_item_id: string
  movement_type: InventoryMovementRow['movement_type']
  quantity: number | string
  from_location_id?: string | null
  to_location_id?: string | null
  project_id?: string | null
  occurred_on?: string
  ticket_number?: string | null
  notes?: string | null
}

export async function createInventoryMovement(
  input: CreateMovementInput,
  companySlug: string,
): Promise<InventoryMovementRow> {
  return apiPost<InventoryMovementRow>('/api/inventory/movements', input, companySlug)
}

export type InventoryImportResult = {
  total: number
  inserted: number
  updated: number
  errors: Array<{ index: number; code: string | null; error: string }>
}

export async function importInventoryItems(
  items: InventoryItemInput[],
  companySlug: string,
): Promise<InventoryImportResult> {
  return apiPost<InventoryImportResult>('/api/inventory/items/import', { items }, companySlug)
}

// ---------------------------------------------------------------------------
// Rental billing run workflow client. See docs/DETERMINISTIC_WORKFLOWS.md.
// The UI consumes the WorkflowSnapshot returned by the API verbatim — it does
// NOT compute next_events locally or invent its own state vocabulary.
// ---------------------------------------------------------------------------

export type RentalBillingWorkflowState = 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'

export type RentalBillingHumanEvent = 'APPROVE' | 'POST_REQUESTED' | 'RETRY_POST' | 'VOID'

export type RentalBillingWorkflowNextEvent = {
  type: RentalBillingHumanEvent
  label: string
  disabled_reason?: string
}

export type RentalBillingRunLine = {
  id: string
  inventory_item_id: string
  quantity: string
  agreed_rate: string
  rate_unit: string
  billable_days: number
  period_start: string
  period_end: string
  amount: string
  taxable: boolean
  description: string | null
}

export type RentalBillingWorkflowSnapshotResponse = {
  state: RentalBillingWorkflowState
  state_version: number
  context: {
    id: string
    company_id: string
    contract_id: string
    project_id: string
    customer_id: string | null
    period_start: string
    period_end: string
    subtotal: string
    qbo_invoice_id: string | null
    approved_at: string | null
    approved_by: string | null
    posted_at: string | null
    failed_at: string | null
    error: string | null
    workflow_engine: string
    workflow_run_id: string | null
    created_at: string
    updated_at: string
    lines: RentalBillingRunLine[]
  }
  next_events: RentalBillingWorkflowNextEvent[]
}

export async function getRentalBillingRunSnapshot(
  runId: string,
  companySlug: string,
): Promise<RentalBillingWorkflowSnapshotResponse> {
  return apiGet<RentalBillingWorkflowSnapshotResponse>(`/api/rental-billing-runs/${runId}`, companySlug)
}

export async function dispatchRentalBillingEvent(
  runId: string,
  event: RentalBillingHumanEvent,
  stateVersion: number,
  companySlug: string,
): Promise<RentalBillingWorkflowSnapshotResponse> {
  return apiPost<RentalBillingWorkflowSnapshotResponse>(
    `/api/rental-billing-runs/${runId}/events`,
    { event, state_version: stateVersion },
    companySlug,
  )
}

export type RentalBillingRunListRow = {
  id: string
  contract_id: string
  project_id: string
  customer_id: string | null
  period_start: string
  period_end: string
  status: RentalBillingWorkflowState
  state_version: number
  subtotal: string
  qbo_invoice_id: string | null
  posted_at: string | null
  failed_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export async function listRentalBillingRuns(
  companySlug: string,
  state?: RentalBillingWorkflowState,
): Promise<{ billingRuns: RentalBillingRunListRow[] }> {
  const suffix = state ? `?state=${state}` : ''
  return apiGet<{ billingRuns: RentalBillingRunListRow[] }>(`/api/rental-billing-runs${suffix}`, companySlug)
}

export async function startQboOAuth(companySlug: string) {
  if (FIXTURES_ENABLED) return
  const response = await fetch(`${API_URL}/api/integrations/qbo/auth`, {
    headers: await authHeaders(companySlug),
  })
  if (!response.ok) {
    const fallback = await response.text()
    throw new Error(`GET /api/integrations/qbo/auth failed: ${response.status} ${fallback}`)
  }
  const payload = (await response.json()) as QboAuthResponse
  if (!payload.authUrl) throw new Error('QBO auth URL was not returned')
  window.location.assign(payload.authUrl)
}
