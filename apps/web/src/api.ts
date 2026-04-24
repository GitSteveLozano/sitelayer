// Shared API types
export type BootstrapResponse = {
  company: { id: string; name: string; slug: string }
  template: { slug: string; name: string; description: string }
  workflowStages: string[]
  divisions: Array<{ code: string; name: string; sort_order: number }>
  serviceItems: Array<{ code: string; name: string; category: string; unit: string; default_rate: string | null; source: string }>
  customers: Array<{ id: string; name: string; external_id: string | null; source: string; version: number; deleted_at: string | null }>
  projects: Array<ProjectRow>
  workers: Array<WorkerRow>
  pricingProfiles: Array<PricingProfileRow>
  bonusRules: Array<BonusRuleRow>
  integrations: Array<{ id: string; provider: string; provider_account_id: string | null; sync_cursor: string | null; status: string }>
  integrationMappings: Array<IntegrationMappingRow>
  laborEntries: Array<LaborRow>
  materialBills: Array<MaterialBillRow>
  schedules: Array<{ id: string; project_id: string; scheduled_for: string; crew: unknown[]; status: string; version: number; deleted_at: string | null; created_at?: string }>
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
  memberships: Array<{ id: string; company_id: string; clerk_user_id: string; role: string; created_at: string; slug: string; name: string }>
}

export type CompaniesResponse = {
  companies: Array<{ id: string; slug: string; name: string; created_at: string }>
  activeCompany: { id: string; name: string; slug: string }
}

export type SyncStatusResponse = {
  company: { id: string; name: string; slug: string }
  pendingOutboxCount: number
  pendingSyncEventCount: number
  latestSyncEvent: { created_at: string; entity_type: string; entity_id: string; direction: string; status: string } | null
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
export const DEFAULT_USER_ID = import.meta.env.VITE_USER_ID ?? 'demo-user'
export const FIXTURES_ENABLED = import.meta.env.VITE_FIXTURES === '1' || import.meta.env.VITE_FIXTURES === 'true'
const RESPONSE_CACHE_PREFIX = 'sitelayer.cache'
const MUTATION_QUEUE_KEY = 'sitelayer.offlineQueue'

// User storage
export function getStoredUserId() {
  if (typeof window === 'undefined') return DEFAULT_USER_ID
  return window.localStorage.getItem('sitelayer.userId') ?? DEFAULT_USER_ID
}

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
  queue.push({
    ...mutation,
    id: `${mutation.method.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
  })
  await writeOfflineQueue(queue)
  window.dispatchEvent(new Event('sitelayer:offline-queue'))
}

// API methods
export async function apiGet<T>(path: string, companySlug: string): Promise<T> {
  if (FIXTURES_ENABLED) {
    const { getFixtureResponse } = await import('./fixtures.js')
    return getFixtureResponse<T>(path, companySlug)
  }
  const userId = getStoredUserId()
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      'x-sitelayer-company-slug': companySlug,
      'x-sitelayer-user-id': userId,
    },
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

async function apiMutate<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, companySlug: string): Promise<T> {
  if (FIXTURES_ENABLED) {
    const { mutateFixtureResponse } = await import('./fixtures.js')
    return mutateFixtureResponse<T>(method, path, body, companySlug)
  }
  const userId = getStoredUserId()
  try {
    const requestInit: RequestInit = {
      method,
      headers: {
        'content-type': 'application/json',
        'x-sitelayer-company-slug': companySlug,
        'x-sitelayer-user-id': userId,
      },
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
    await enqueueOfflineMutation({ method, path, body, companySlug, userId })
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

export async function replayOfflineMutations(companySlug: string) {
  if (FIXTURES_ENABLED) return
  if (typeof window === 'undefined') return
  const queue = await readOfflineQueue()
  if (!queue.length) return

  const remaining: OfflineMutation[] = []
  for (const mutation of queue) {
    if (mutation.companySlug !== companySlug) {
      remaining.push(mutation)
      continue
    }

    try {
      const requestInit: RequestInit = {
        method: mutation.method,
        headers: {
          'content-type': 'application/json',
          'x-sitelayer-company-slug': mutation.companySlug,
          'x-sitelayer-user-id': mutation.userId,
        },
      }
      if (mutation.body !== undefined) {
        requestInit.body = JSON.stringify(mutation.body)
      }
      const response = await fetch(`${API_URL}${mutation.path}`, requestInit)
      if (!response.ok) {
        if (response.status === 409) {
          remaining.push(mutation)
          continue
        }
        if (response.status >= 400 && response.status < 500) {
          console.warn(`[offline] dropping invalid mutation ${mutation.method} ${mutation.path}: ${response.status}`)
          continue
        }
        throw new Error(`${mutation.method} ${mutation.path} failed: ${response.status}`)
      }
      const parsed = await response.json().catch(() => null)
      if (parsed !== null) {
        invalidateCompanyCache(mutation.companySlug)
        cacheResponse(mutation.companySlug, mutation.path, parsed)
      }
    } catch {
      remaining.push(mutation)
    }
  }
  await writeOfflineQueue(remaining)
  window.dispatchEvent(new Event('sitelayer:offline-queue'))
}

export async function startQboOAuth(companySlug: string) {
  if (FIXTURES_ENABLED) return
  const userId = getStoredUserId()
  const response = await fetch(`${API_URL}/api/integrations/qbo/auth`, {
    headers: {
      'x-sitelayer-company-slug': companySlug,
      'x-sitelayer-user-id': userId,
    },
  })
  if (!response.ok) {
    const fallback = await response.text()
    throw new Error(`GET /api/integrations/qbo/auth failed: ${response.status} ${fallback}`)
  }
  const payload = (await response.json()) as QboAuthResponse
  if (!payload.authUrl) throw new Error('QBO auth URL was not returned')
  window.location.assign(payload.authUrl)
}
