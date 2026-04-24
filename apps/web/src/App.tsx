import { useEffect, useState, type ReactNode } from 'react'
import { LA_TEMPLATE, formatMoney } from '@sitelayer/domain'
import type {
  BootstrapResponse,
  BonusRuleRow,
  BlueprintRow,
  IntegrationMappingRow,
  LaborRow,
  MeasurementRow,
  MaterialBillRow,
  OfflineMutation,
  PricingProfileRow,
  ProjectSummary,
  ProjectRow,
  ScheduleRow,
  WorkerRow,
} from './api.js'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
const DEFAULT_COMPANY_SLUG = import.meta.env.VITE_COMPANY_SLUG ?? 'la-operations'
const DEFAULT_USER_ID = import.meta.env.VITE_USER_ID ?? 'demo-user'
const MUTATION_QUEUE_KEY = 'sitelayer.offlineQueue'
const RESPONSE_CACHE_PREFIX = 'sitelayer.cache'

class QueueableMutationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueableMutationError'
  }
}

type SessionResponse = {
  user: { id: string; role: string }
  activeCompany: { id: string; name: string; slug: string }
  memberships: Array<{ id: string; company_id: string; clerk_user_id: string; role: string; created_at: string; slug: string; name: string }>
}

type CompaniesResponse = {
  companies: Array<{ id: string; slug: string; name: string; created_at: string }>
  activeCompany: { id: string; name: string; slug: string }
}

type SyncStatusResponse = {
  company: { id: string; name: string; slug: string }
  pendingOutboxCount: number
  pendingSyncEventCount: number
  latestSyncEvent: { created_at: string; entity_type: string; entity_id: string; direction: string; status: string } | null
  connections: Array<{ id: string; provider: string; provider_account_id: string | null; sync_cursor: string | null; last_synced_at: string | null; status: string; version: number; created_at: string }>
}

type QboConnectionResponse = {
  connection: { id: string; provider: string; provider_account_id: string | null; sync_cursor: string | null; last_synced_at: string | null; status: string; version: number; created_at: string } | null
  status: SyncStatusResponse
}

type QboAuthResponse = {
  authUrl: string
}

async function apiGet<T>(path: string, companySlug: string): Promise<T> {
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

async function apiPost<T>(path: string, body: unknown, companySlug: string): Promise<T> {
  return apiMutate<T>('POST', path, body, companySlug)
}

async function apiPatch<T>(path: string, body: unknown, companySlug: string): Promise<T> {
  return apiMutate<T>('PATCH', path, body, companySlug)
}

async function apiDelete<T>(path: string, companySlug: string, body?: unknown): Promise<T> {
  return apiMutate<T>('DELETE', path, body, companySlug)
}

async function startQboOAuth(companySlug: string) {
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

function getStoredUserId() {
  if (typeof window === 'undefined') return DEFAULT_USER_ID
  return window.localStorage.getItem('sitelayer.userId') ?? DEFAULT_USER_ID
}

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

async function fileToBase64(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.includes(',') ? result.split(',', 2)[1] ?? result : result)
    }
    reader.readAsDataURL(file)
  })
}

async function readBlueprintUpload(form: FormData) {
  const file = form.get('blueprint_file')
  if (!(file instanceof File) || !file.size) return null
  return {
    file_name: file.name,
    original_file_name: file.name,
    mime_type: file.type || 'application/pdf',
    contents_base64: await fileToBase64(file),
  }
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

function readOfflineQueue(): OfflineMutation[] {
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

function writeOfflineQueue(queue: OfflineMutation[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(MUTATION_QUEUE_KEY, JSON.stringify(queue))
}

function enqueueOfflineMutation(mutation: Omit<OfflineMutation, 'id' | 'createdAt'>) {
  const queue = readOfflineQueue()
  queue.push({
    ...mutation,
    id: `${mutation.method.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
  })
  writeOfflineQueue(queue)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('sitelayer:offline-queue'))
  }
}

async function apiMutate<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, companySlug: string): Promise<T> {
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
    enqueueOfflineMutation({ method, path, body, companySlug, userId })
    console.warn(`[offline] queued ${method} ${path}`, error)
    return (body ?? { queued: true }) as T
  }
}

async function replayOfflineMutations(companySlug: string) {
  if (typeof window === 'undefined') return
  const queue = readOfflineQueue()
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
        throw new QueueableMutationError(`${mutation.method} ${mutation.path} failed: ${response.status}`)
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
  writeOfflineQueue(remaining)
  window.dispatchEvent(new Event('sitelayer:offline-queue'))
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [companySlug, setCompanySlug] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_COMPANY_SLUG
    return window.localStorage.getItem('sitelayer.companySlug') ?? DEFAULT_COMPANY_SLUG
  })
  const [userId, setUserId] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_USER_ID
    return window.localStorage.getItem('sitelayer.userId') ?? DEFAULT_USER_ID
  })
  const [blueprints, setBlueprints] = useState<BlueprintRow[]>([])
  const [measurements, setMeasurements] = useState<MeasurementRow[]>([])
  const [schedules, setSchedules] = useState<ScheduleRow[]>([])
  const [materialBills, setMaterialBills] = useState<MaterialBillRow[]>([])
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [companies, setCompanies] = useState<CompaniesResponse['companies']>([])
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null)
  const [qboConnection, setQboConnection] = useState<QboConnectionResponse['connection'] | null>(null)
  const [offlineQueue, setOfflineQueue] = useState<OfflineMutation[]>([])
  const [syncRefreshKey, setSyncRefreshKey] = useState(0)

  useEffect(() => {
    window.localStorage.setItem('sitelayer.companySlug', companySlug)
  }, [companySlug])

  useEffect(() => {
    window.localStorage.setItem('sitelayer.userId', userId)
  }, [userId])

  async function refresh() {
    const [sessionData, data] = await Promise.all([
      apiGet<SessionResponse>('/api/session', companySlug),
      apiGet<BootstrapResponse>('/api/bootstrap', companySlug),
    ])
    setSession(sessionData)
    try {
      const companyData = await apiGet<CompaniesResponse>('/api/companies', companySlug)
      setCompanies(companyData.companies)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    }
    setBootstrap(data)
    setSelectedProjectId((current) => current || data.projects[0]?.id || '')
    try {
      const status = await apiGet<SyncStatusResponse>('/api/sync/status', companySlug)
      setSyncStatus(status)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    }
    try {
      const qbo = await apiGet<QboConnectionResponse>('/api/integrations/qbo', companySlug)
      setQboConnection(qbo.connection)
      setSyncStatus(qbo.status)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    }
    setOfflineQueue(readOfflineQueue())
    setSyncRefreshKey((current) => current + 1)
  }

  useEffect(() => {
    setSelectedProjectId('')
    setSummary(null)
    void refresh()
      .then(() => setError(null))
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'unknown error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySlug])

  useEffect(() => {
    let active = true
    const replay = () => {
      replayOfflineMutations(companySlug)
        .then(() => {
          if (active) {
            setOfflineQueue(readOfflineQueue())
          }
        })
        .catch(() => {
          if (active) {
            setOfflineQueue(readOfflineQueue())
          }
        })
    }

    replay()
    const syncOfflineQueue = () => {
      if (active) {
        setOfflineQueue(readOfflineQueue())
      }
    }
    window.addEventListener('online', replay)
    window.addEventListener('sitelayer:offline-queue', syncOfflineQueue as EventListener)
    const timer = window.setInterval(replay, 15000)
    return () => {
      active = false
      window.removeEventListener('online', replay)
      window.removeEventListener('sitelayer:offline-queue', syncOfflineQueue as EventListener)
      window.clearInterval(timer)
    }
  }, [companySlug])

  async function refreshSummary(projectId: string) {
    if (!projectId) {
      setSummary(null)
      return
    }
    const data = await apiGet<ProjectSummary>(`/api/projects/${projectId}/summary`, companySlug)
    setSummary(data)
  }

  async function refreshTakeoff(projectId: string) {
    if (!projectId) {
      setBlueprints([])
      setMeasurements([])
      setSchedules([])
      setMaterialBills([])
      setSelectedBlueprintId('')
      return
    }
    const [blueprintData, measurementData, billData] = await Promise.all([
      apiGet<{ blueprints: BlueprintRow[] }>(`/api/projects/${projectId}/blueprints`, companySlug),
      apiGet<{ measurements: MeasurementRow[] }>(`/api/projects/${projectId}/takeoff/measurements`, companySlug),
      apiGet<{ materialBills: MaterialBillRow[] }>(`/api/projects/${projectId}/material-bills`, companySlug),
    ])
    setBlueprints(blueprintData.blueprints)
    setMeasurements(measurementData.measurements)
    setMaterialBills(billData.materialBills)
    setSelectedBlueprintId((current) => current && blueprintData.blueprints.some((blueprint) => blueprint.id === current) ? current : blueprintData.blueprints[0]?.id ?? '')
    const scheduleData = await apiGet<{ schedules: ScheduleRow[] }>(`/api/projects/${projectId}/schedules`, companySlug)
    setSchedules(scheduleData.schedules)
  }

  useEffect(() => {
    void refreshSummary(selectedProjectId).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    })
    void refreshTakeoff(selectedProjectId).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    })
  }, [selectedProjectId, companySlug])

  async function runAction(label: string, action: () => Promise<void>, options?: { skipRefresh?: boolean }) {
    try {
      setBusy(label)
      setError(null)
      await action()
      if (!options?.skipRefresh) {
        await refresh()
        if (selectedProjectId) {
          await refreshSummary(selectedProjectId)
        }
      }
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    } finally {
      setBusy(null)
    }
  }

  const divisions = bootstrap?.divisions ?? []
  const serviceItems = bootstrap?.serviceItems ?? []
  const customers = bootstrap?.customers ?? []
  const workers = bootstrap?.workers ?? []
  const pricingProfiles = bootstrap?.pricingProfiles ?? []
  const bonusRules = bootstrap?.bonusRules ?? []
  const integrationMappings = bootstrap?.integrationMappings ?? []
  const activeBlueprint = blueprints.find((blueprint) => blueprint.id === selectedBlueprintId) ?? blueprints[0] ?? null
  const mappedCustomerRefs = new Set(
    integrationMappings.filter((mapping) => mapping.entity_type === 'customer' && mapping.deleted_at === null).map((mapping) => mapping.local_ref),
  )
  const mappedServiceItemRefs = new Set(
    integrationMappings.filter((mapping) => mapping.entity_type === 'service_item' && mapping.deleted_at === null).map((mapping) => mapping.local_ref),
  )
  const mappedDivisionRefs = new Set(
    integrationMappings.filter((mapping) => mapping.entity_type === 'division' && mapping.deleted_at === null).map((mapping) => mapping.local_ref),
  )
  const mappedProjectRefs = new Set(
    integrationMappings.filter((mapping) => mapping.entity_type === 'project' && mapping.deleted_at === null).map((mapping) => mapping.local_ref),
  )
  const suggestedCustomerMappings = customers.filter((customer) => customer.external_id && !mappedCustomerRefs.has(customer.id))
  const suggestedServiceItemMappings = serviceItems.filter(
    (item) => (item.source === 'qbo' || item.code.startsWith('qbo-')) && !mappedServiceItemRefs.has(item.code),
  )
  const suggestedDivisionMappings = divisions.filter((division) => !mappedDivisionRefs.has(division.code))
  const suggestedProjectMappings = bootstrap?.projects.filter((project) => !mappedProjectRefs.has(project.id)) ?? []

  const primaryDivision = divisions.find((division) => division.code === 'D4')?.code ?? divisions[0]?.code ?? 'D4'
  const measurableServiceItems = serviceItems.filter((item) => item.category === 'measurable')

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Greenfield reset</p>
        <h1>Sitelayer</h1>
        <p className="lede">
          A construction operations layer with a fixed workflow backbone, tenant-scoped data, and adapter-first integrations.
        </p>
        <p className="lede compact">
          Tenant: {bootstrap?.company.name ?? 'loading...'} · Template: {bootstrap?.template.name ?? LA_TEMPLATE.name}
        </p>
      </section>

      <section className="panel">
        <h2>Auth Shell</h2>
        <dl className="kv">
          <div>
            <dt>User</dt>
            <dd>{session?.user.id ?? 'loading...'}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{session?.user.role ?? 'loading...'}</dd>
          </div>
          <div>
            <dt>Active company</dt>
            <dd>{session?.activeCompany.slug ?? companySlug}</dd>
          </div>
          <div>
            <dt>Memberships</dt>
            <dd>{session?.memberships.length ?? 0}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>Clerk Bridge</h2>
        <p className="muted">The app speaks in Clerk-shaped user ids and company memberships, even while running locally.</p>
        <FormRow
          actionLabel="Load user"
          busy={busy === 'user'}
          onSubmit={(form) =>
            runAction(
              'user',
              async () => {
                const nextUserId = String(form.get('user_id') ?? '').trim()
                if (!nextUserId) throw new Error('user id is required')
                setUserId(nextUserId)
              },
              { skipRefresh: true },
            )
          }
        >
          <input name="user_id" defaultValue={userId} placeholder="Clerk user id" />
          <input name="display_name" defaultValue={session?.user.id ?? userId} placeholder="Display name" disabled />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Company Switcher</h2>
        <FormRow
          actionLabel="Load company"
          busy={busy === 'company'}
          onSubmit={(form) =>
            runAction(
              'company',
            async () => {
                const nextSlug = String(form.get('company_slug') ?? form.get('company_slug_manual') ?? '').trim()
                if (!nextSlug) throw new Error('company slug is required')
                setCompanySlug(nextSlug)
              },
              { skipRefresh: true },
            )
          }
        >
          <select
            name="company_slug"
            defaultValue={companySlug}
            onChange={(event) => setCompanySlug(event.target.value)}
          >
            {companies.map((company) => (
              <option key={company.id} value={company.slug}>
                {company.name} · {company.slug}
              </option>
            ))}
            {!companies.some((company) => company.slug === companySlug) ? (
              <option value={companySlug}>{companySlug}</option>
            ) : null}
          </select>
          <input name="company_slug_manual" defaultValue={companySlug} placeholder="Or type a company slug" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Workflow Backbone</h2>
        <ol className="stages">
          {bootstrap?.workflowStages?.map((stage) => (
            <li key={stage}>{stage}</li>
          )) ?? <li>Loading workflow stages...</li>}
        </ol>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Company Snapshot</h2>
          <dl className="kv">
            <div>
              <dt>Projects</dt>
              <dd>{bootstrap?.projects.length ?? 0}</dd>
            </div>
            <div>
              <dt>Customers</dt>
              <dd>{customers.length}</dd>
            </div>
            <div>
              <dt>Workers</dt>
              <dd>{workers.length}</dd>
            </div>
            <div>
              <dt>Service Items</dt>
              <dd>{serviceItems.length}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <h2>API Status</h2>
          <p>{error ? error : bootstrap ? 'Connected' : 'Loading bootstrap...'}</p>
          <p className="muted">This is the company-scoped working set for the seeded tenant.</p>
        </article>
      </section>

      <section className="panel">
        <h2>Create Customer</h2>
        <FormRow
          actionLabel="Add customer"
          busy={busy === 'customer'}
          onSubmit={(form) =>
            runAction('customer', async () => {
              await apiPost('/api/customers', {
                name: String(form.get('name') ?? '').trim(),
                external_id: String(form.get('external_id') ?? '').trim() || null,
                source: 'manual',
              }, companySlug)
            })
          }
        >
          <input name="name" placeholder="Customer name" />
          <input name="external_id" placeholder="External ID (optional)" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Customers</h2>
        <ul className="list">
          {bootstrap?.customers.map((customer) => (
            <li key={customer.id}>
              <CustomerEditor
                customer={customer}
                busy={busy === `customer:${customer.id}`}
                onSubmit={(form) =>
                  runAction(`customer:${customer.id}`, async () => {
                    await apiPatch(
                      `/api/customers/${customer.id}`,
                      {
                        name: String(form.get('name') ?? '').trim(),
                        external_id: String(form.get('external_id') ?? '').trim() || null,
                        source: String(form.get('source') ?? customer.source),
                        expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                      },
                      companySlug,
                    )
                  })
                }
                  onDelete={() =>
                    runAction(`customer:${customer.id}`, async () => {
                      await apiDelete(`/api/customers/${customer.id}`, companySlug, { expected_version: customer.version })
                    })
                  }
                />
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Create Project</h2>
        <FormRow
          actionLabel="Add project"
          busy={busy === 'project'}
          onSubmit={(form) =>
            runAction('project', async () => {
              await apiPost('/api/projects', {
                name: String(form.get('name') ?? '').trim(),
                customer_name: String(form.get('customer_name') ?? '').trim(),
                division_code: String(form.get('division_code') ?? primaryDivision),
                status: 'lead',
                bid_total: Number(form.get('bid_total') ?? 0),
                labor_rate: Number(form.get('labor_rate') ?? 38),
                target_sqft_per_hr: Number(form.get('target_sqft_per_hr') ?? 0) || null,
                bonus_pool: Number(form.get('bonus_pool') ?? 0),
              }, companySlug)
            })
          }
        >
          <input name="name" placeholder="Project name" />
          <input name="customer_name" placeholder="Customer / builder" />
          <select name="division_code" defaultValue={primaryDivision}>
            {divisions.map((division) => (
              <option key={division.code} value={division.code}>
                {division.code} - {division.name}
              </option>
            ))}
          </select>
          <input name="bid_total" placeholder="Bid total" type="number" step="0.01" />
          <input name="labor_rate" placeholder="Labor rate" type="number" step="0.01" defaultValue="38" />
          <input name="target_sqft_per_hr" placeholder="Target sqft/hr" type="number" step="0.01" />
          <input name="bonus_pool" placeholder="Bonus pool" type="number" step="0.01" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Create Worker</h2>
        <FormRow
          actionLabel="Add worker"
          busy={busy === 'worker'}
          onSubmit={(form) =>
            runAction('worker', async () => {
              await apiPost('/api/workers', {
                name: String(form.get('name') ?? '').trim(),
                role: String(form.get('role') ?? 'crew').trim() || 'crew',
              }, companySlug)
            })
          }
        >
          <input name="name" placeholder="Worker name" />
          <input name="role" placeholder="Role" defaultValue="crew" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Workers</h2>
        <ul className="list compact">
          {workers.map((worker) => (
            <li key={worker.id}>
              <WorkerEditor
                worker={worker}
                busy={busy === `worker:${worker.id}`}
                onSubmit={(form) =>
                  runAction(`worker:${worker.id}`, async () => {
                    await apiPatch(
                      `/api/workers/${worker.id}`,
                      {
                        name: String(form.get('name') ?? '').trim(),
                        role: String(form.get('role') ?? '').trim(),
                        expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                      },
                      companySlug,
                    )
                  })
                }
                  onDelete={() =>
                    runAction(`worker:${worker.id}`, async () => {
                      await apiDelete(`/api/workers/${worker.id}`, companySlug, { expected_version: worker.version })
                    })
                  }
                />
            </li>
          ))}
        </ul>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Pricing Profiles</h2>
          <FormRow
            actionLabel="Add pricing profile"
            busy={busy === 'pricing-profile'}
            onSubmit={(form) =>
              runAction('pricing-profile', async () => {
                const configRaw = String(form.get('config') ?? '').trim()
                const config = configRaw ? JSON.parse(configRaw) : {}
                await apiPost(
                  '/api/pricing-profiles',
                  {
                    name: String(form.get('name') ?? '').trim(),
                    is_default: form.get('is_default') === 'on',
                    config,
                  },
                  companySlug,
                )
              })
            }
          >
            <input name="name" placeholder="Profile name" defaultValue="Default" />
            <label className="checkbox">
              <input name="is_default" type="checkbox" defaultChecked />
              <span>Default profile</span>
            </label>
            <textarea
              name="config"
              placeholder={`{\n  "template": "la-default"\n}`}
              rows={4}
              defaultValue={JSON.stringify({ template: 'la-default' }, null, 2)}
            />
          </FormRow>
          <ul className="list compact">
            {pricingProfiles.map((profile) => (
              <li key={profile.id}>
                <PricingProfileEditor
                  profile={profile}
                  busy={busy === `pricing-profile:${profile.id}`}
                  onSubmit={(form) =>
                    runAction(`pricing-profile:${profile.id}`, async () => {
                      const configRaw = String(form.get('config') ?? '').trim()
                      const config = configRaw ? JSON.parse(configRaw) : {}
                      await apiPatch(
                        `/api/pricing-profiles/${profile.id}`,
                        {
                          name: String(form.get('name') ?? '').trim(),
                          is_default: form.get('is_default') === 'on',
                          config,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                    })
                  }
                  onDelete={() =>
                    runAction(`pricing-profile:${profile.id}`, async () => {
                      await apiDelete(`/api/pricing-profiles/${profile.id}`, companySlug, { expected_version: profile.version })
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Bonus Rules</h2>
          <FormRow
            actionLabel="Add bonus rule"
            busy={busy === 'bonus-rule'}
            onSubmit={(form) =>
              runAction('bonus-rule', async () => {
                const configRaw = String(form.get('config') ?? '').trim()
                const config = configRaw ? JSON.parse(configRaw) : {}
                await apiPost(
                  '/api/bonus-rules',
                  {
                    name: String(form.get('name') ?? '').trim(),
                    is_active: form.get('is_active') === 'on',
                    config,
                  },
                  companySlug,
                )
              })
            }
          >
            <input name="name" placeholder="Rule name" defaultValue="Default Margin Bonus" />
            <label className="checkbox">
              <input name="is_active" type="checkbox" defaultChecked />
              <span>Active rule</span>
            </label>
            <textarea
              name="config"
              placeholder={`{\n  "basis": "margin",\n  "threshold": 0.15\n}`}
              rows={4}
              defaultValue={JSON.stringify({ basis: 'margin', threshold: 0.15 }, null, 2)}
            />
          </FormRow>
          <ul className="list compact">
            {bonusRules.map((rule) => (
              <li key={rule.id}>
                <BonusRuleEditor
                  rule={rule}
                  busy={busy === `bonus-rule:${rule.id}`}
                  onSubmit={(form) =>
                    runAction(`bonus-rule:${rule.id}`, async () => {
                      const configRaw = String(form.get('config') ?? '').trim()
                      const config = configRaw ? JSON.parse(configRaw) : {}
                      await apiPatch(
                        `/api/bonus-rules/${rule.id}`,
                        {
                          name: String(form.get('name') ?? '').trim(),
                          is_active: form.get('is_active') === 'on',
                          config,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                    })
                  }
                  onDelete={() =>
                    runAction(`bonus-rule:${rule.id}`, async () => {
                      await apiDelete(`/api/bonus-rules/${rule.id}`, companySlug, { expected_version: rule.version })
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="panel">
        <h2>Project Selection</h2>
        <div className="toolbar">
          <label className="selectWrap">
            <span>Selected project</span>
            <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
              <option value="">Choose a project</option>
              {bootstrap?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {project.customer_name} · {project.division_code} · {project.status}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Takeoff Workspace</h2>
        {selectedProjectId ? (
          <TakeoffWorkspace
            projectId={selectedProjectId}
            companySlug={companySlug}
            blueprints={blueprints}
            measurements={measurements}
            serviceItems={measurableServiceItems}
            selectedBlueprintId={selectedBlueprintId}
            onSelectBlueprint={setSelectedBlueprintId}
            onSaved={() => void refreshTakeoff(selectedProjectId)}
          />
        ) : (
          <p className="muted">Pick a project to open the takeoff board.</p>
        )}
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Blueprint Documents</h2>
          <FormRow
            actionLabel="Add blueprint"
            busy={busy === 'blueprint'}
            onSubmit={(form) =>
              runAction('blueprint', async () => {
                if (!selectedProjectId) throw new Error('select a project first')
                const upload = await readBlueprintUpload(form)
                await apiPost(`/api/projects/${selectedProjectId}/blueprints`, {
                  file_name: String(form.get('file_name') ?? upload?.file_name ?? '').trim(),
                  storage_path: String(form.get('storage_path') ?? '').trim(),
                  preview_type: String(form.get('preview_type') ?? 'storage_path').trim(),
                  calibration_length: Number(form.get('calibration_length') ?? 0) || null,
                  calibration_unit: String(form.get('calibration_unit') ?? '').trim() || null,
                  sheet_scale: Number(form.get('sheet_scale') ?? 0) || null,
                  version: Number(form.get('version') ?? 0) || undefined,
                  file_contents_base64: upload?.contents_base64 ?? undefined,
                  original_file_name: upload?.original_file_name ?? undefined,
                  mime_type: upload?.mime_type ?? undefined,
                }, companySlug)
                await refreshTakeoff(selectedProjectId)
              })
            }
          >
            <input name="file_name" placeholder="Blueprint file name" />
            <input name="blueprint_file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*" />
            <input name="storage_path" placeholder="storage/path.pdf" />
            <input name="preview_type" placeholder="Preview type" defaultValue="storage_path" />
            <input name="calibration_length" placeholder="Calibration length" type="number" step="0.01" />
            <input name="calibration_unit" placeholder="Calibration unit" />
            <input name="sheet_scale" placeholder="Sheet scale" type="number" step="0.0001" />
            <input name="version" placeholder="Version" type="number" step="1" defaultValue="1" />
          </FormRow>
          <ul className="list compact">
            {blueprints.map((blueprint) => (
              <li key={blueprint.id}>
                <BlueprintEditor
                  blueprint={blueprint}
                  lineage={getBlueprintLineageLabel(blueprints, blueprint.id)}
                  busy={busy === `blueprint:${blueprint.id}`}
                  onSubmit={(form) =>
                    runAction(`blueprint:${blueprint.id}`, async () => {
                      const upload = await readBlueprintUpload(form)
                      await apiPatch(
                        `/api/blueprints/${blueprint.id}`,
                        {
                          file_name: String(form.get('file_name') ?? upload?.file_name ?? '').trim(),
                          storage_path: String(form.get('storage_path') ?? '').trim(),
                          preview_type: String(form.get('preview_type') ?? '').trim(),
                          calibration_length: Number(form.get('calibration_length') ?? 0) || null,
                          calibration_unit: String(form.get('calibration_unit') ?? '').trim() || null,
                          sheet_scale: Number(form.get('sheet_scale') ?? 0) || null,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                          file_contents_base64: upload?.contents_base64 ?? undefined,
                          original_file_name: upload?.original_file_name ?? undefined,
                          mime_type: upload?.mime_type ?? undefined,
                        },
                        companySlug,
                      )
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                  onCreateVersion={(form) =>
                    runAction(`blueprint-version:${blueprint.id}`, async () => {
                      const upload = await readBlueprintUpload(form)
                      const response = await apiPost<BlueprintRow>(
                        `/api/blueprints/${blueprint.id}/versions`,
                        {
                          file_name: String(form.get('file_name') ?? upload?.file_name ?? blueprint.file_name).trim(),
                          storage_path: String(form.get('storage_path') ?? '').trim(),
                          preview_type: String(form.get('preview_type') ?? blueprint.preview_type).trim(),
                          calibration_length: Number(form.get('calibration_length') ?? 0) || blueprint.calibration_length || null,
                          calibration_unit: String(form.get('calibration_unit') ?? '').trim() || blueprint.calibration_unit || null,
                          sheet_scale: Number(form.get('sheet_scale') ?? 0) || blueprint.sheet_scale || null,
                          copy_measurements: form.get('copy_measurements') !== 'off',
                          file_contents_base64: upload?.contents_base64 ?? undefined,
                          original_file_name: upload?.original_file_name ?? undefined,
                          mime_type: upload?.mime_type ?? undefined,
                        },
                        companySlug,
                      )
                      await refreshTakeoff(selectedProjectId)
                      setSelectedBlueprintId(response.id)
                    })
                  }
                  onDelete={() =>
                    runAction(`blueprint:${blueprint.id}`, async () => {
                      await apiDelete(`/api/blueprints/${blueprint.id}`, companySlug, { expected_version: blueprint.version })
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Takeoff Measurements</h2>
          <FormRow
            actionLabel="Save takeoff"
            busy={busy === 'takeoff'}
            onSubmit={(form) =>
              runAction('takeoff', async () => {
                if (!selectedProjectId) throw new Error('select a project first')
                const measurementRows = parseMeasurementRows(form)
                await apiPost(`/api/projects/${selectedProjectId}/takeoff/measurements`, {
                  measurements: measurementRows,
                  expected_version: summary?.project.version ?? undefined,
                }, companySlug)
                await refreshTakeoff(selectedProjectId)
              })
            }
          >
            <textarea
              name="measurements"
              placeholder={`One per line: service_item_code, quantity, unit, notes\nEPS, 1250, sqft, front elevation`}
              rows={7}
            />
            <small>Use measurable items only. Example: EPS, 1250, sqft, front elevation</small>
          </FormRow>
          <ul className="list compact">
            {measurements.map((measurement) => (
              <li key={measurement.id}>
                <MeasurementEditor
                  measurement={measurement}
                  busy={busy === `measurement:${measurement.id}`}
                  serviceItems={measurableServiceItems}
                  onSubmit={(form) =>
                    runAction(`measurement:${measurement.id}`, async () => {
                      await apiPatch(
                        `/api/takeoff/measurements/${measurement.id}`,
                        {
                          service_item_code: String(form.get('service_item_code') ?? '').trim(),
                          quantity: Number(form.get('quantity') ?? 0),
                          unit: String(form.get('unit') ?? '').trim(),
                          notes: String(form.get('notes') ?? '').trim() || null,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                  onDelete={() =>
                    runAction(`measurement:${measurement.id}`, async () => {
                      await apiDelete(`/api/takeoff/measurements/${measurement.id}`, companySlug, { expected_version: measurement.version })
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Time Capture</h2>
          <FormRow
            actionLabel="Add labor"
            busy={busy === 'labor'}
            onSubmit={(form) =>
              runAction('labor', async () => {
                if (!selectedProjectId) throw new Error('select a project first')
                await apiPost('/api/labor-entries', {
                  project_id: selectedProjectId,
                  worker_id: String(form.get('worker_id') ?? '').trim() || null,
                  service_item_code: String(form.get('service_item_code') ?? '').trim(),
                  hours: Number(form.get('hours') ?? 0),
                  sqft_done: Number(form.get('sqft_done') ?? 0),
                  occurred_on: String(form.get('occurred_on') ?? ''),
                  status: 'confirmed',
                  expected_version: summary?.project.version ?? undefined,
                }, companySlug)
              })
            }
          >
            <select name="worker_id" defaultValue="">
              <option value="">Choose worker</option>
              {workers.map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.name}
                </option>
              ))}
            </select>
            <select name="service_item_code" defaultValue="">
              <option value="">Service item</option>
              {measurableServiceItems.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} - {item.name}
                </option>
              ))}
            </select>
            <input name="hours" placeholder="Hours" type="number" step="0.25" defaultValue="8" />
            <input name="sqft_done" placeholder="Sqft done" type="number" step="0.1" defaultValue="0" />
            <input name="occurred_on" placeholder="2026-04-23" defaultValue={new Date().toISOString().slice(0, 10)} />
          </FormRow>
        </article>

        <article className="panel">
          <h2>Material Bills</h2>
          <FormRow
            actionLabel="Add bill"
            busy={busy === 'material-bill'}
            onSubmit={(form) =>
              runAction('material-bill', async () => {
                if (!selectedProjectId) throw new Error('select a project first')
                await apiPost(`/api/projects/${selectedProjectId}/material-bills`, {
                  vendor: String(form.get('vendor') ?? '').trim(),
                  amount: Number(form.get('amount') ?? 0),
                  bill_type: String(form.get('bill_type') ?? 'material').trim() || 'material',
                  description: String(form.get('description') ?? '').trim() || null,
                  occurred_on: String(form.get('occurred_on') ?? '').trim() || null,
                  expected_version: summary?.project.version ?? undefined,
                }, companySlug)
                await refreshTakeoff(selectedProjectId)
              })
            }
          >
            <input name="vendor" placeholder="Vendor" />
            <input name="amount" placeholder="Amount" type="number" step="0.01" />
            <input name="bill_type" placeholder="Type" defaultValue="material" />
            <input name="description" placeholder="Description" />
            <input name="occurred_on" placeholder="2026-04-23" defaultValue={new Date().toISOString().slice(0, 10)} />
          </FormRow>
          <ul className="list compact">
            {materialBills.map((bill) => (
              <li key={bill.id}>
                <MaterialBillEditor
                  bill={bill}
                  busy={busy === `material-bill:${bill.id}`}
                  onSubmit={(form) =>
                    runAction(`material-bill:${bill.id}`, async () => {
                      await apiPatch(
                        `/api/material-bills/${bill.id}`,
                        {
                          vendor: String(form.get('vendor') ?? '').trim(),
                          amount: Number(form.get('amount') ?? 0),
                          bill_type: String(form.get('bill_type') ?? '').trim(),
                          description: String(form.get('description') ?? '').trim() || null,
                          occurred_on: String(form.get('occurred_on') ?? '').trim() || null,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                  onDelete={() =>
                    runAction(`material-bill:${bill.id}`, async () => {
                      await apiDelete(`/api/material-bills/${bill.id}`, companySlug, { expected_version: bill.version })
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Daily Confirm</h2>
          <FormRow
            actionLabel="Confirm day"
            busy={busy === 'confirm-day'}
            onSubmit={(form) =>
              runAction('confirm-day', async () => {
                if (!selectedProjectId) throw new Error('select a project first')
                const scheduleId = String(form.get('schedule_id') ?? '').trim()
                if (!scheduleId) throw new Error('schedule is required')
                const scheduleVersion = schedules.find((schedule) => schedule.id === scheduleId)?.version
                const entries = parseMeasurementRows(form).map((row) => ({
                  worker_id: String(form.get('worker_id') ?? '').trim() || null,
                  service_item_code: row.service_item_code,
                  hours: row.quantity,
                  sqft_done: row.quantity,
                  occurred_on: String(form.get('occurred_on') ?? ''),
                }))
                await apiPost(`/api/schedules/${scheduleId}/confirm`, { entries, expected_version: scheduleVersion ?? undefined }, companySlug)
                await refreshTakeoff(selectedProjectId)
              })
            }
          >
            <select name="schedule_id" defaultValue="">
              <option value="">Choose schedule</option>
              {schedules.map((schedule) => (
                <option key={schedule.id} value={schedule.id}>
                  {schedule.scheduled_for} · {schedule.status}
                </option>
              ))}
            </select>
            <select name="worker_id" defaultValue="">
              <option value="">Worker for all entries</option>
              {workers.map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.name}
                </option>
              ))}
            </select>
            <input name="occurred_on" defaultValue={new Date().toISOString().slice(0, 10)} />
            <textarea
              name="measurements"
              placeholder={`service_item_code, quantity, unit, notes\nEPS, 8, hr, daily confirm shorthand`}
              rows={5}
            />
            <small>Use the same shorthand parser as takeoff to create confirmed labor entries.</small>
          </FormRow>
        </article>
      </section>

      <section className="panel">
        <h2>Schedule</h2>
        <FormRow
          actionLabel="Add schedule"
          busy={busy === 'schedule'}
          onSubmit={(form) =>
            runAction('schedule', async () => {
              if (!selectedProjectId) throw new Error('select a project first')
              const crewInput = String(form.get('crew') ?? '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)

              await apiPost('/api/schedules', {
                project_id: selectedProjectId,
                scheduled_for: String(form.get('scheduled_for') ?? ''),
                crew: crewInput,
                status: 'draft',
              }, companySlug)
              await refreshTakeoff(selectedProjectId)
            })
          }
        >
          <input name="scheduled_for" defaultValue={new Date().toISOString().slice(0, 10)} />
          <input name="crew" placeholder="Crew names, comma separated" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Labor Entries</h2>
        <ul className="list compact">
          {(bootstrap?.laborEntries ?? []).filter((entry) => !selectedProjectId || entry.project_id === selectedProjectId).map((entry) => (
            <li key={entry.id}>
              <LaborEditor
                laborEntry={entry}
                workers={workers}
                serviceItems={measurableServiceItems}
                busy={busy === `labor-entry:${entry.id}`}
                onSubmit={(form) =>
                  runAction(`labor-entry:${entry.id}`, async () => {
                      await apiPatch(
                        `/api/labor-entries/${entry.id}`,
                        {
                          worker_id: String(form.get('worker_id') ?? '').trim() || null,
                          service_item_code: String(form.get('service_item_code') ?? '').trim(),
                          hours: Number(form.get('hours') ?? 0),
                          sqft_done: Number(form.get('sqft_done') ?? 0),
                          status: String(form.get('status') ?? '').trim(),
                          occurred_on: String(form.get('occurred_on') ?? '').trim(),
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                    })
                  }
                  onDelete={() =>
                    runAction(`labor-entry:${entry.id}`, async () => {
                      await apiDelete(`/api/labor-entries/${entry.id}`, companySlug, { expected_version: entry.version })
                    })
                  }
                />
            </li>
          ))}
        </ul>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Selected Project Summary</h2>
          {summary ? (
            <div className="summary">
              <p>
                <strong>{summary.project.name}</strong> · {summary.project.customer_name} · {summary.project.division_code}
              </p>
              <p className="muted">
                Status: {summary.project.status}
                {summary.project.closed_at ? ` · closed ${summary.project.closed_at}` : ''}
                {summary.project.summary_locked_at ? ` · summary locked ${summary.project.summary_locked_at}` : ''}
              </p>
              <dl className="kv">
                <div>
                  <dt>Bid total</dt>
                  <dd>{formatMoney(Number(summary.project.bid_total))}</dd>
                </div>
                <div>
                  <dt>Estimate total</dt>
                  <dd>{formatMoney(summary.metrics.estimateTotal)}</dd>
                </div>
                <div>
                  <dt>Labor cost</dt>
                  <dd>{formatMoney(summary.metrics.laborCost)}</dd>
                </div>
                <div>
                  <dt>Total cost</dt>
                  <dd>{formatMoney(summary.metrics.totalCost)}</dd>
                </div>
                <div>
                  <dt>Margin</dt>
                  <dd>{(summary.metrics.margin.margin * 100).toFixed(2)}%</dd>
                </div>
                <div>
                  <dt>Bonus</dt>
                  <dd>{summary.metrics.bonus.eligible ? formatMoney(summary.metrics.bonus.payout) : 'Not eligible'}</dd>
                </div>
              </dl>

              <div className="actions">
                <button
                  type="button"
                  onClick={() =>
                    void runAction('estimate-recompute', async () => {
                      await apiPost(`/api/projects/${summary.project.id}/estimate/recompute`, {}, companySlug)
                      await refreshSummary(summary.project.id)
                    })
                  }
                >
                  Recompute estimate
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void runAction('project-closeout', async () => {
                      await apiPost(
                        `/api/projects/${summary.project.id}/closeout`,
                        { expected_version: summary.project.version },
                        companySlug,
                      )
                      await refreshSummary(summary.project.id)
                      await refresh()
                    })
                  }
                >
                  Close out project
                </button>
              </div>

              <div className="summaryLists">
                <div>
                  <h3>Measurements</h3>
                  <ul className="list compact">
                    {summary.measurements.length ? (
                      summary.measurements.map((measurement) => (
                        <li key={`${measurement.service_item_code}:${measurement.notes ?? ''}:${measurement.quantity}`}>
                          <strong>{measurement.service_item_code}</strong>
                          <span>
                            {measurement.quantity} {measurement.unit}
                            {measurement.notes ? ` · ${measurement.notes}` : ''}
                          </span>
                        </li>
                      ))
                    ) : (
                      <li>No measurements yet</li>
                    )}
                  </ul>
                </div>

                <div>
                  <h3>Estimate Lines</h3>
                  <ul className="list compact">
                    {summary.estimateLines.length ? (
                      summary.estimateLines.map((line) => (
                        <li key={`${line.service_item_code}:${line.quantity}:${line.rate}`}>
                          <strong>{line.service_item_code}</strong>
                          <span>
                            {line.quantity} {line.unit} · {formatMoney(Number(line.amount))}
                          </span>
                        </li>
                      ))
                    ) : (
                      <li>No estimate lines yet</li>
                    )}
                  </ul>
                </div>
              </div>

              <ProjectEditor
                project={summary.project}
                divisions={divisions}
                busy={busy === 'project-update'}
                onSubmit={(form) =>
                  runAction('project-update', async () => {
                    await apiPatch(`/api/projects/${summary.project.id}`, {
                      name: String(form.get('name') ?? '').trim(),
                      customer_name: String(form.get('customer_name') ?? '').trim(),
                      division_code: String(form.get('division_code') ?? summary.project.division_code),
                      status: String(form.get('status') ?? summary.project.status),
                      bid_total: Number(form.get('bid_total') ?? summary.project.bid_total),
                      labor_rate: Number(form.get('labor_rate') ?? summary.project.labor_rate),
                      target_sqft_per_hr: Number(form.get('target_sqft_per_hr') ?? 0) || null,
                      bonus_pool: Number(form.get('bonus_pool') ?? summary.project.bonus_pool),
                      expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                    }, companySlug)
                  })
                }
              />
            </div>
          ) : (
            <p className="muted">Pick a project to see measurements, estimate lines, and live cost analytics.</p>
          )}
        </article>

        <article className="panel">
          <h2>Project List</h2>
          <ul className="list">
            {bootstrap?.projects?.map((project) => (
              <li
                key={project.id}
                className={project.id === selectedProjectId ? 'active' : ''}
                onClick={() => setSelectedProjectId(project.id)}
              >
                <div className="stacked">
                  <strong>{project.name}</strong>
                  <span className="muted compact">
                    {project.customer_name} · {project.division_code}
                  </span>
                </div>
                <span className="projectMeta">
                  <span className="badge">{project.status}</span>
                  <span className="metaInline">
                    {formatMoney(Number(project.bid_total))}
                    {project.closed_at ? ` · closed ${project.closed_at}` : ''}
                    {project.summary_locked_at ? ` · locked ${project.summary_locked_at}` : ''}
                  </span>
                </span>
              </li>
            )) ?? <li>Waiting for seed data</li>}
          </ul>
        </article>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Divisions</h2>
          <ul className="list compact">
            {divisions.map((division) => (
              <li key={division.code}>
                <strong>{division.code}</strong>
                <span>{division.name}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Curated Service Items</h2>
          <ul className="list compact">
            {measurableServiceItems.map((item) => (
              <li key={item.code}>
                <strong>{item.code}</strong>
                <span>
                  {item.name} · {item.unit} · {item.default_rate ?? 'n/a'}
                </span>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="panel">
        <h2>Analytics Preview</h2>
        <AnalyticsWidget companySlug={companySlug} />
      </section>

      <section className="panel">
        <h2>Integration Stance</h2>
        <p>
          QBO, time tools, takeoff tools, and file systems stay behind adapters. The seeded workflow can be proven with fake data or
          direct database-backed flows before any external connector is added.
        </p>
        <div className="integrationGrid">
          <div className="integrationCard">
            <h3>QBO Connection</h3>
            <dl className="kv compactKv">
              <div>
                <dt>Provider</dt>
                <dd>{qboConnection?.provider ?? 'qbo'}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{qboConnection?.status ?? 'disconnected'}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{qboConnection?.provider_account_id ?? 'not linked'}</dd>
              </div>
              <div>
                <dt>Last sync</dt>
                <dd>{qboConnection?.last_synced_at ? new Date(qboConnection.last_synced_at).toLocaleString() : 'never'}</dd>
              </div>
            </dl>
            <FormRow
              actionLabel="Seed / update QBO"
              busy={busy === 'qbo-connection'}
              onSubmit={(form) =>
                runAction('qbo-connection', async () => {
                  await apiPost(
                    '/api/integrations/qbo',
                    {
                      provider_account_id: String(form.get('provider_account_id') ?? '').trim() || null,
                      sync_cursor: String(form.get('sync_cursor') ?? '').trim() || null,
                      status: String(form.get('status') ?? 'connected').trim() || 'connected',
                      expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                    },
                    companySlug,
                  )
                })
              }
            >
              <input name="expected_version" type="hidden" defaultValue={qboConnection?.version ?? 1} />
              <input name="provider_account_id" defaultValue={qboConnection?.provider_account_id ?? ''} placeholder="QBO realm / account id" />
              <input name="sync_cursor" defaultValue={qboConnection?.sync_cursor ?? ''} placeholder="Sync cursor" />
              <input name="status" defaultValue={qboConnection?.status ?? 'connected'} placeholder="Status" />
            </FormRow>
            <div className="actions">
              <button
                type="button"
                disabled={busy === 'qbo-oauth'}
                onClick={() =>
                  runAction(
                    'qbo-oauth',
                    async () => {
                      await startQboOAuth(companySlug)
                    },
                    { skipRefresh: true },
                  )
                }
              >
                Connect with Intuit OAuth
              </button>
              <button
                type="button"
                onClick={() =>
                  runAction('qbo-sync', async () => {
                    await apiPost('/api/integrations/qbo/sync', { provider_account_id: qboConnection?.provider_account_id ?? null }, companySlug)
                    await refresh()
                  })
                }
              >
                Sync QBO snapshot
              </button>
            </div>
          </div>
          <div className="integrationCard">
            <h3>Queue Health</h3>
            <dl className="kv compactKv">
              <div>
                <dt>Pending outbox</dt>
                <dd>{syncStatus?.pendingOutboxCount ?? '0'}</dd>
              </div>
              <div>
                <dt>Pending sync events</dt>
                <dd>{syncStatus?.pendingSyncEventCount ?? '0'}</dd>
              </div>
              <div>
                <dt>Latest event</dt>
                <dd>{syncStatus?.latestSyncEvent ? `${syncStatus.latestSyncEvent.entity_type}:${syncStatus.latestSyncEvent.entity_id}` : 'none'}</dd>
              </div>
              <div>
                <dt>Connections</dt>
                <dd>{syncStatus?.connections.length ?? 0}</dd>
              </div>
            </dl>
            <div className="actions">
              <button
                type="button"
                onClick={() =>
                  runAction('queue-process', async () => {
                    await apiPost('/api/sync/process', { limit: 25 }, companySlug)
                    await refresh()
                  })
                }
              >
                Process queue
              </button>
            </div>
          </div>
          <div className="integrationCard">
            <h3>QBO Mappings</h3>
            <p className="muted">Explicit local-to-QBO mappings for customers, service items, divisions, and projects.</p>
            <div className="summaryGrid compact">
              <div>
                <dt>Mapped customers</dt>
                <dd>{integrationMappings.filter((mapping) => mapping.entity_type === 'customer' && mapping.deleted_at === null).length}</dd>
              </div>
              <div>
                <dt>Suggested customers</dt>
                <dd>{suggestedCustomerMappings.length}</dd>
              </div>
              <div>
                <dt>Total mappings</dt>
                <dd>{integrationMappings.length}</dd>
              </div>
              <div>
                <dt>Mapped service items</dt>
                <dd>{integrationMappings.filter((mapping) => mapping.entity_type === 'service_item' && mapping.deleted_at === null).length}</dd>
              </div>
              <div>
                <dt>Mapped divisions</dt>
                <dd>{integrationMappings.filter((mapping) => mapping.entity_type === 'division' && mapping.deleted_at === null).length}</dd>
              </div>
              <div>
                <dt>Mapped projects</dt>
                <dd>{integrationMappings.filter((mapping) => mapping.entity_type === 'project' && mapping.deleted_at === null).length}</dd>
              </div>
            </div>
            <h4>Suggested customer mappings</h4>
            <ul className="list compact">
              {suggestedCustomerMappings.length ? (
                suggestedCustomerMappings.map((customer) => (
                  <li key={customer.id} className="splitRow">
                    <div>
                      <strong>{customer.name}</strong>
                      <p className="muted compact">Local ref: {customer.id} · External ID: {customer.external_id}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        runAction(`qbo-suggest:${customer.id}`, async () => {
                          await apiPost(
                            '/api/integrations/qbo/mappings',
                            {
                              entity_type: 'customer',
                              local_ref: customer.id,
                              external_id: customer.external_id,
                              label: customer.name,
                              status: 'active',
                              notes: 'auto-suggested from seeded customer backfill',
                            },
                            companySlug,
                          )
                          await refresh()
                        })
                      }
                    >
                      Create mapping
                    </button>
                  </li>
                ))
              ) : (
                <li>No customers with external IDs need mappings.</li>
              )}
            </ul>
            <h4>Suggested service item mappings</h4>
            <ul className="list compact">
              {suggestedServiceItemMappings.length ? (
                suggestedServiceItemMappings.map((item) => (
                  <li key={item.code} className="splitRow">
                    <div>
                      <strong>{item.code}</strong>
                      <p className="muted compact">
                        {item.name} · {item.category} · {item.unit}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        runAction(`qbo-service-item:${item.code}`, async () => {
                          await apiPost(
                            '/api/integrations/qbo/mappings',
                            {
                              entity_type: 'service_item',
                              local_ref: item.code,
                              external_id: item.code.startsWith('qbo-') ? item.code.slice(4) : item.code,
                              label: item.name,
                              status: 'active',
                              notes: 'auto-suggested from qbo item import',
                            },
                            companySlug,
                          )
                          await refresh()
                        })
                      }
                    >
                      Create mapping
                    </button>
                  </li>
                ))
              ) : (
                <li>No service items need mappings.</li>
              )}
            </ul>
            <h4>Division mappings</h4>
            <p className="muted compact">
              Division mappings are backfilled from QBO Class sync when the class name matches a local division name or code.
            </p>
            <ul className="list compact">
              {suggestedDivisionMappings.length ? (
                suggestedDivisionMappings.map((division) => (
                  <li key={division.code} className="splitRow">
                    <div>
                      <strong>{division.code}</strong>
                      <p className="muted compact">{division.name}</p>
                    </div>
                    <span className="muted compact">Awaiting QBO class match</span>
                  </li>
                ))
              ) : (
                <li>All divisions are mapped.</li>
              )}
            </ul>
            <h4>Project mappings</h4>
            <p className="muted compact">Projects are mapped automatically when their estimate is pushed to QBO.</p>
            <ul className="list compact">
              {suggestedProjectMappings.length ? (
                suggestedProjectMappings.slice(0, 3).map((project) => (
                  <li key={project.id} className="splitRow">
                    <div>
                      <strong>{project.name}</strong>
                      <p className="muted compact">
                        {project.customer_name} · {project.division_code}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        runAction(`qbo-project:${project.id}`, async () => {
                          await apiPost(`/api/projects/${project.id}/estimate/push-qbo`, {}, companySlug)
                          await refresh()
                          if (selectedProjectId === project.id) {
                            await refreshSummary(project.id)
                          }
                        })
                      }
                    >
                      Push and map
                    </button>
                  </li>
                ))
              ) : (
                <li>All projects have QBO mappings.</li>
              )}
            </ul>
            <FormRow
              actionLabel="Save mapping"
              busy={busy === 'qbo-mapping'}
              onSubmit={(form) =>
                runAction('qbo-mapping', async () => {
                  await apiPost(
                    '/api/integrations/qbo/mappings',
                    {
                      entity_type: String(form.get('entity_type') ?? '').trim(),
                      local_ref: String(form.get('local_ref') ?? '').trim(),
                      external_id: String(form.get('external_id') ?? '').trim(),
                      label: String(form.get('label') ?? '').trim() || null,
                      status: String(form.get('status') ?? 'active').trim() || 'active',
                      notes: String(form.get('notes') ?? '').trim() || null,
                      expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                    },
                    companySlug,
                  )
                  await refresh()
                })
              }
            >
              <select name="entity_type" defaultValue="customer">
                <option value="customer">customer</option>
                <option value="service_item">service_item</option>
                <option value="division">division</option>
                <option value="project">project</option>
              </select>
              <input name="local_ref" placeholder="Local ref / id / code" />
              <input name="external_id" placeholder="QBO external id" />
              <input name="label" placeholder="Label (optional)" />
              <input name="status" placeholder="Status" defaultValue="active" />
              <input name="notes" placeholder="Notes (optional)" />
            </FormRow>
            <ul className="list compact">
              {integrationMappings.length ? (
                integrationMappings.map((mapping) => (
                  <li key={mapping.id}>
                    <IntegrationMappingEditor
                      mapping={mapping}
                      busy={busy === `qbo-mapping:${mapping.id}`}
                      onSubmit={(form) =>
                        runAction(`qbo-mapping:${mapping.id}`, async () => {
                          await apiPatch(
                            `/api/integrations/qbo/mappings/${mapping.id}`,
                            {
                              entity_type: String(form.get('entity_type') ?? '').trim(),
                              local_ref: String(form.get('local_ref') ?? '').trim(),
                          external_id: String(form.get('external_id') ?? '').trim(),
                          label: String(form.get('label') ?? '').trim() || null,
                          status: String(form.get('status') ?? '').trim() || 'active',
                          notes: String(form.get('notes') ?? '').trim() || null,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                          await refresh()
                        })
                      }
                      onDelete={() =>
                        runAction(`qbo-mapping:${mapping.id}`, async () => {
                          await apiDelete(`/api/integrations/qbo/mappings/${mapping.id}`, companySlug, { expected_version: mapping.version })
                          await refresh()
                        })
                      }
                    />
                  </li>
                ))
              ) : (
                <li>No QBO mappings yet.</li>
              )}
            </ul>
          </div>
        </div>
        <MutationOutboxWidget companySlug={companySlug} refreshKey={syncRefreshKey} />
        <OfflineQueueWidget companySlug={companySlug} queue={offlineQueue} />
      </section>
    </main>
  )
}

function FormRow({
  children,
  onSubmit,
  actionLabel,
  busy,
}: {
  children: ReactNode
  onSubmit: (formData: FormData) => Promise<void>
  actionLabel: string
  busy: boolean
}) {
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit(new FormData(event.currentTarget))
      }}
    >
      <div className="formGrid">{children}</div>
      <button type="submit" disabled={busy}>
        {busy ? 'Working…' : actionLabel}
      </button>
    </form>
  )
}

function parseMeasurementRows(form: FormData) {
  const raw = String(form.get('measurements') ?? '')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [service_item_code, quantity, unit, ...rest] = line.split(',').map((value) => value.trim())
      return {
        service_item_code,
        quantity: Number(quantity),
        unit,
        notes: rest.join(',').trim() || null,
      }
    })
}

function AnalyticsWidget({ companySlug }: { companySlug: string }) {
  const [data, setData] = useState<{
    projects: Array<{
      project: ProjectSummary['project']
      metrics: {
        totalHours: number
        totalSqft: number
        laborCost: number
        materialCost: number
        subCost: number
        totalCost: number
        revenue: number
        profit: number
        margin: number
        bonus: { eligible: boolean; payoutPercent: number; payout: number }
        sqftPerHr: number
      }
    }>
    divisions: Array<{ divisionCode: string; revenue: number; cost: number; margin: number; count: number }>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void apiGet<{
      projects: Array<{
        project: ProjectSummary['project']
        metrics: {
          totalHours: number
          totalSqft: number
          laborCost: number
          materialCost: number
          subCost: number
          totalCost: number
          revenue: number
          profit: number
          margin: number
          bonus: { eligible: boolean; payoutPercent: number; payout: number }
          sqftPerHr: number
        }
      }>
      divisions: Array<{ divisionCode: string; revenue: number; cost: number; margin: number; count: number }>
    }>('/api/analytics', companySlug)
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'unknown error'))
  }, [companySlug])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading analytics...</p>

  return (
    <div className="analytics">
      <div>
        <h3>Division Rollups</h3>
        <ul className="list compact">
          {data.divisions.map((division) => (
            <li key={division.divisionCode}>
              <strong>{division.divisionCode}</strong>
              <span>
                Revenue {formatMoney(division.revenue)} · Cost {formatMoney(division.cost)} · Margin {formatMoney(division.margin)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3>Project Metrics</h3>
        <ul className="list compact">
          {data.projects.map((entry) => (
            <li key={entry.project.id}>
              <strong>{entry.project.name}</strong>
              <span>
                Labor {formatMoney(entry.metrics.laborCost)} · Cost {formatMoney(entry.metrics.totalCost)} · Margin{' '}
                {(entry.metrics.margin * 100).toFixed(2)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function ProjectEditor({
  project,
  divisions,
  busy,
  onSubmit,
}: {
  project: ProjectRow
  divisions: Array<{ code: string; name: string; sort_order: number }>
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
}) {
  const divisionLabel = divisions.find((division) => division.code === project.division_code)
  return (
    <div className="editor">
      <div className="rowBetween">
        <div className="stacked">
          <h3>Edit Project</h3>
          <span className="muted compact">{project.customer_name}</span>
        </div>
        <div className="stacked alignRight">
          <span className="badge">{project.status}</span>
          <span className="muted compact">
            {divisionLabel ? `${divisionLabel.code} · ${divisionLabel.name}` : project.division_code}
          </span>
        </div>
      </div>
      <FormRow actionLabel="Save project" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={project.version} />
        <input name="name" defaultValue={project.name} placeholder="Project name" />
        <input name="customer_name" defaultValue={project.customer_name} placeholder="Customer / builder" />
        <select name="division_code" defaultValue={project.division_code}>
          {divisions.map((division) => (
            <option key={division.code} value={division.code}>
              {division.code} - {division.name}
            </option>
          ))}
        </select>
        <input name="status" defaultValue={project.status} placeholder="Status" />
        <input name="bid_total" defaultValue={Number(project.bid_total)} type="number" step="0.01" placeholder="Bid total" />
        <input name="labor_rate" defaultValue={Number(project.labor_rate)} type="number" step="0.01" placeholder="Labor rate" />
        <input
          name="target_sqft_per_hr"
          defaultValue={project.target_sqft_per_hr ? Number(project.target_sqft_per_hr) : ''}
          type="number"
          step="0.01"
          placeholder="Target sqft/hr"
        />
        <input name="bonus_pool" defaultValue={Number(project.bonus_pool)} type="number" step="0.01" placeholder="Bonus pool" />
      </FormRow>
    </div>
  )
}

function CustomerEditor({
  customer,
  busy,
  onSubmit,
  onDelete,
}: {
  customer: { id: string; name: string; external_id: string | null; source: string; version: number }
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <div className="stacked">
          <strong>{customer.name}</strong>
          <span className="muted compact">{customer.external_id ? `External ID ${customer.external_id}` : 'Local-only customer'}</span>
        </div>
        <div className="stacked alignRight">
          <span className="badge">{customer.source}</span>
          <span className="muted compact">v{customer.version}</span>
        </div>
      </div>
      <FormRow actionLabel="Save customer" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={customer.version} />
        <input name="name" defaultValue={customer.name} placeholder="Customer name" />
        <input name="external_id" defaultValue={customer.external_id ?? ''} placeholder="External ID" />
        <input name="source" defaultValue={customer.source} placeholder="Source" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function BlueprintEditor({
  blueprint,
  lineage,
  busy,
  onSubmit,
  onCreateVersion,
  onDelete,
}: {
  blueprint: BlueprintRow
  lineage: string
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onCreateVersion: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <div className="stacked">
          <strong>v{blueprint.version}</strong>
          <span className="muted compact">{blueprint.deleted_at ? 'deleted' : 'active'}</span>
        </div>
        <div className="stacked alignRight">
          <span className="badge">{blueprint.preview_type}</span>
          <span className="muted compact">
            {blueprint.replaces_blueprint_document_id ? 'revision' : 'source'}
          </span>
        </div>
      </div>
      <p className="muted compact">History: {lineage}</p>
      <FormRow actionLabel="Save blueprint" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={blueprint.version} />
        <input name="file_name" defaultValue={blueprint.file_name} placeholder="Blueprint file name" />
        <input name="storage_path" defaultValue={blueprint.storage_path} placeholder="Storage path" />
        <input name="preview_type" defaultValue={blueprint.preview_type} placeholder="Preview type" />
        <input name="calibration_length" defaultValue={blueprint.calibration_length ?? ''} placeholder="Calibration length" type="number" step="0.01" />
        <input name="calibration_unit" defaultValue={blueprint.calibration_unit ?? ''} placeholder="Calibration unit" />
        <input name="sheet_scale" defaultValue={blueprint.sheet_scale ?? ''} placeholder="Sheet scale" type="number" step="0.0001" />
        <input name="blueprint_file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*" />
      </FormRow>
      <FormRow actionLabel="Create version" busy={busy} onSubmit={onCreateVersion}>
        <input name="file_name" defaultValue={blueprint.file_name} placeholder="Version file name" />
        <input name="storage_path" defaultValue={blueprint.storage_path} placeholder="Storage path" />
        <input name="preview_type" defaultValue={blueprint.preview_type} placeholder="Preview type" />
        <input name="calibration_length" defaultValue={blueprint.calibration_length ?? ''} placeholder="Calibration length" type="number" step="0.01" />
        <input name="calibration_unit" defaultValue={blueprint.calibration_unit ?? ''} placeholder="Calibration unit" />
        <input name="sheet_scale" defaultValue={blueprint.sheet_scale ?? ''} placeholder="Sheet scale" type="number" step="0.0001" />
        <input name="blueprint_file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*" />
        <label className="checkbox">
          <input name="copy_measurements" type="checkbox" defaultChecked />
          <span>Copy measurements forward</span>
        </label>
      </FormRow>
      <p className="muted compact">
        File preview: {blueprint.file_url ? blueprint.file_url : 'not stored yet'} · Base storage: {blueprint.storage_path}
      </p>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function PricingProfileEditor({
  profile,
  busy,
  onSubmit,
  onDelete,
}: {
  profile: PricingProfileRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{profile.name}</strong>
        <span className="muted">{profile.is_default ? 'default' : 'custom'}</span>
      </div>
      <FormRow
        actionLabel="Save pricing profile"
        busy={busy}
        onSubmit={(form) => onSubmit(form)}
      >
        <input name="expected_version" type="hidden" defaultValue={profile.version} />
        <input name="name" defaultValue={profile.name} placeholder="Profile name" />
        <label className="checkbox">
          <input name="is_default" type="checkbox" defaultChecked={profile.is_default} />
          <span>Default profile</span>
        </label>
        <textarea
          name="config"
          rows={4}
          defaultValue={JSON.stringify(profile.config, null, 2)}
          placeholder='{"template":"la-default"}'
        />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function BonusRuleEditor({
  rule,
  busy,
  onSubmit,
  onDelete,
}: {
  rule: BonusRuleRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{rule.name}</strong>
        <span className="muted">{rule.is_active ? 'active' : 'inactive'}</span>
      </div>
      <FormRow actionLabel="Save bonus rule" busy={busy} onSubmit={(form) => onSubmit(form)}>
        <input name="expected_version" type="hidden" defaultValue={rule.version} />
        <input name="name" defaultValue={rule.name} placeholder="Rule name" />
        <label className="checkbox">
          <input name="is_active" type="checkbox" defaultChecked={rule.is_active} />
          <span>Active rule</span>
        </label>
        <textarea
          name="config"
          rows={4}
          defaultValue={JSON.stringify(rule.config, null, 2)}
          placeholder='{"basis":"margin","threshold":0.15}'
        />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function IntegrationMappingEditor({
  mapping,
  busy,
  onSubmit,
  onDelete,
}: {
  mapping: IntegrationMappingRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{mapping.entity_type}</strong>
        <span className="muted">v{mapping.version}</span>
      </div>
      <FormRow actionLabel="Save mapping" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={mapping.version} />
        <select name="entity_type" defaultValue={mapping.entity_type}>
          <option value="customer">customer</option>
          <option value="service_item">service_item</option>
          <option value="division">division</option>
          <option value="project">project</option>
        </select>
        <input name="local_ref" defaultValue={mapping.local_ref} placeholder="Local ref" />
        <input name="external_id" defaultValue={mapping.external_id} placeholder="QBO external id" />
        <input name="label" defaultValue={mapping.label ?? ''} placeholder="Label" />
        <input name="status" defaultValue={mapping.status} placeholder="Status" />
        <input name="notes" defaultValue={mapping.notes ?? ''} placeholder="Notes" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function WorkerEditor({
  worker,
  busy,
  onSubmit,
  onDelete,
}: {
  worker: WorkerRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{worker.name}</strong>
        <span className="muted">v{worker.version}</span>
      </div>
      <FormRow actionLabel="Save worker" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={worker.version} />
        <input name="name" defaultValue={worker.name} placeholder="Worker name" />
        <input name="role" defaultValue={worker.role} placeholder="Role" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function MeasurementEditor({
  measurement,
  serviceItems,
  busy,
  onSubmit,
  onDelete,
}: {
  measurement: MeasurementRow
  serviceItems: Array<{ code: string; name: string; category: string; unit: string; default_rate: string | null }>
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{measurement.service_item_code}</strong>
        <span className="muted">v{measurement.version}</span>
      </div>
      <FormRow actionLabel="Save measurement" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={measurement.version} />
        <select name="service_item_code" defaultValue={measurement.service_item_code}>
          {serviceItems.map((item) => (
            <option key={item.code} value={item.code}>
              {item.code} - {item.name}
            </option>
          ))}
        </select>
        <input name="quantity" defaultValue={Number(measurement.quantity)} type="number" step="0.01" />
        <input name="unit" defaultValue={measurement.unit} placeholder="Unit" />
        <input name="notes" defaultValue={measurement.notes ?? ''} placeholder="Notes" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function MaterialBillEditor({
  bill,
  busy,
  onSubmit,
  onDelete,
}: {
  bill: MaterialBillRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{bill.vendor}</strong>
        <span className="muted">v{bill.version}</span>
      </div>
      <FormRow actionLabel="Save bill" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={bill.version} />
        <input name="vendor" defaultValue={bill.vendor} placeholder="Vendor" />
        <input name="amount" defaultValue={Number(bill.amount)} type="number" step="0.01" />
        <input name="bill_type" defaultValue={bill.bill_type} placeholder="Type" />
        <input name="description" defaultValue={bill.description ?? ''} placeholder="Description" />
        <input name="occurred_on" defaultValue={bill.occurred_on ?? ''} placeholder="Occurred on" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function LaborEditor({
  laborEntry,
  workers,
  serviceItems,
  busy,
  onSubmit,
  onDelete,
}: {
  laborEntry: LaborRow
  workers: WorkerRow[]
  serviceItems: Array<{ code: string; name: string; category: string; unit: string; default_rate: string | null }>
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{laborEntry.service_item_code}</strong>
        <span className="muted">v{laborEntry.version}</span>
      </div>
      <FormRow actionLabel="Save labor entry" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={laborEntry.version} />
        <select name="worker_id" defaultValue={laborEntry.worker_id ?? ''}>
          <option value="">Worker</option>
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              {worker.name}
            </option>
          ))}
        </select>
        <select name="service_item_code" defaultValue={laborEntry.service_item_code}>
          {serviceItems.map((item) => (
            <option key={item.code} value={item.code}>
              {item.code} - {item.name}
            </option>
          ))}
        </select>
        <input name="hours" defaultValue={Number(laborEntry.hours)} type="number" step="0.25" placeholder="Hours" />
        <input name="sqft_done" defaultValue={Number(laborEntry.sqft_done)} type="number" step="0.1" placeholder="Sqft done" />
        <input name="status" defaultValue={laborEntry.status} placeholder="Status" />
        <input name="occurred_on" defaultValue={laborEntry.occurred_on} type="date" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function TakeoffWorkspace({
  projectId,
  companySlug,
  blueprints,
  measurements,
  serviceItems,
  selectedBlueprintId,
  onSelectBlueprint,
  onSaved,
}: {
  projectId: string
  companySlug: string
  blueprints: BlueprintRow[]
  measurements: MeasurementRow[]
  serviceItems: Array<{ code: string; name: string; category: string; unit: string; default_rate: string | null }>
  selectedBlueprintId: string
  onSelectBlueprint: (blueprintId: string) => void
  onSaved: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftPoints, setDraftPoints] = useState<Array<{ x: number; y: number }>>([])
  const [pointerPoint, setPointerPoint] = useState<{ x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [serviceItemCode, setServiceItemCode] = useState(serviceItems[0]?.code ?? '')
  const [quantityMultiplier, setQuantityMultiplier] = useState(1)
  const [calibrationLength, setCalibrationLength] = useState('100')
  const [calibrationUnit, setCalibrationUnit] = useState('ft')

  const activeBlueprint = blueprints.find((blueprint) => blueprint.id === selectedBlueprintId) ?? blueprints[0] ?? null
  const blueprintMeasurements = measurements.filter((measurement) => measurement.blueprint_document_id === activeBlueprint?.id)

  useEffect(() => {
    if (!selectedBlueprintId && blueprints[0]) {
      onSelectBlueprint(blueprints[0].id)
    }
  }, [blueprints, onSelectBlueprint, selectedBlueprintId])

  useEffect(() => {
    setDraftPoints([])
    setPointerPoint(null)
    setQuantityMultiplier(activeBlueprint?.sheet_scale ? Number(activeBlueprint.sheet_scale) : 1)
    setCalibrationLength(activeBlueprint?.calibration_length ?? '100')
    setCalibrationUnit(activeBlueprint?.calibration_unit ?? 'ft')
  }, [activeBlueprint?.id])

  useEffect(() => {
    if (!serviceItemCode && serviceItems[0]) {
      setServiceItemCode(serviceItems[0].code)
    }
  }, [serviceItemCode, serviceItems])

  async function saveDraftMeasurement() {
    if (!activeBlueprint) {
      throw new Error('select a blueprint first')
    }
    if (!serviceItemCode) {
      throw new Error('service item is required')
    }
    if (draftPoints.length < 3) {
      throw new Error('draw at least 3 points')
    }
    const area = Math.max(0, polygonArea(draftPoints))
    const quantity = Number((area * Number(quantityMultiplier || 1)).toFixed(2))
    setBusy(true)
    setError(null)
    try {
      await apiPost(
        `/api/projects/${projectId}/takeoff/measurement`,
        {
          blueprint_document_id: activeBlueprint.id,
          service_item_code: serviceItemCode,
          quantity,
          unit: serviceItems.find((item) => item.code === serviceItemCode)?.unit ?? 'sqft',
          notes: `polygon:${draftPoints.length}`,
          geometry: {
            kind: 'polygon',
            points: draftPoints,
            sheet_scale: quantityMultiplier,
            calibration_length: Number(calibrationLength) || null,
            calibration_unit: calibrationUnit,
          },
        },
        companySlug,
      )
      setDraftPoints([])
      onSaved()
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="takeoffWorkspace">
      <div className="takeoffToolbar">
        <label className="selectWrap">
          <span>Blueprint</span>
          <select value={activeBlueprint?.id ?? ''} onChange={(event) => onSelectBlueprint(event.target.value)}>
            <option value="">Choose blueprint</option>
            {blueprints.map((blueprint) => (
              <option key={blueprint.id} value={blueprint.id}>
                {blueprint.file_name} · v{blueprint.version}
              </option>
            ))}
          </select>
        </label>
        <label className="selectWrap">
          <span>Service item</span>
          <select value={serviceItemCode} onChange={(event) => setServiceItemCode(event.target.value)}>
            {serviceItems.map((item) => (
              <option key={item.code} value={item.code}>
                {item.code} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="selectWrap">
          <span>Quantity multiplier</span>
          <input value={quantityMultiplier} onChange={(event) => setQuantityMultiplier(Number(event.target.value))} type="number" step="0.01" />
        </label>
        <label className="selectWrap">
          <span>Calibration length</span>
          <input value={calibrationLength} onChange={(event) => setCalibrationLength(event.target.value)} type="number" step="0.01" />
        </label>
        <label className="selectWrap">
          <span>Calibration unit</span>
          <input value={calibrationUnit} onChange={(event) => setCalibrationUnit(event.target.value)} />
        </label>
        <label className="selectWrap">
          <span>Zoom</span>
          <input value={zoom} onChange={(event) => setZoom(Number(event.target.value))} type="range" min="0.6" max="2.2" step="0.1" />
        </label>
      </div>

      <div className="takeoffStageWrap">
        <div className="takeoffStage" style={{ transform: `scale(${zoom})` }}>
          <div className="takeoffBackdrop">
            {activeBlueprint?.file_url ? (
              <iframe title={activeBlueprint.file_name} src={`${API_URL}${activeBlueprint.file_url}`} />
            ) : activeBlueprint?.storage_path && /^https?:\/\//.test(activeBlueprint.storage_path) ? (
              <iframe title={activeBlueprint.file_name} src={activeBlueprint.storage_path} />
            ) : (
              <div className="takeoffGrid" />
            )}
          </div>
          <svg
            className="takeoffSvg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              const x = ((event.clientX - rect.left) / rect.width) * 100
              const y = ((event.clientY - rect.top) / rect.height) * 100
              setPointerPoint({ x, y })
            }}
            onMouseLeave={() => setPointerPoint(null)}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              const x = ((event.clientX - rect.left) / rect.width) * 100
              const y = ((event.clientY - rect.top) / rect.height) * 100
              setDraftPoints((current) => [...current, { x, y }])
            }}
          >
            {pointerPoint ? (
              <>
                <line x1={pointerPoint.x} y1={0} x2={pointerPoint.x} y2={100} className="takeoffCrosshair" />
                <line x1={0} y1={pointerPoint.y} x2={100} y2={pointerPoint.y} className="takeoffCrosshair" />
              </>
            ) : null}
            {blueprintMeasurements
              .filter((measurement) => measurement.geometry && typeof measurement.geometry === 'object' && Array.isArray((measurement.geometry as { points?: unknown[] }).points))
              .map((measurement) => {
                const points = (measurement.geometry as { points?: Array<{ x: number; y: number }> }).points ?? []
                const labelPoint = polygonCentroid(points)
                return (
                  <g key={measurement.id}>
                    <polygon points={polygonPointsToString(points)} className="takeoffPolygon measurementPolygon" />
                    {labelPoint ? (
                      <text x={labelPoint.x} y={labelPoint.y} className="takeoffLabel">
                        {measurement.service_item_code} · {measurement.quantity} {measurement.unit}
                      </text>
                    ) : null}
                  </g>
                )
              })}
            {draftPoints.length > 0 ? (
              <>
                <polyline points={polygonPointsToString(draftPoints)} className="takeoffLine draftLine" />
                <polygon points={polygonPointsToString(draftPoints)} className="takeoffPolygon draftPolygon" />
                {draftPoints.map((point, index) => (
                  <g key={`${index}-${point.x}-${point.y}`}>
                    <circle cx={point.x} cy={point.y} r={1.15} className="takeoffPoint" />
                    <text x={point.x} y={point.y + 0.8} className="takeoffVertexLabel">
                      {index + 1}
                    </text>
                  </g>
                ))}
              </>
            ) : null}
          </svg>
        </div>
      </div>

      <div className="takeoffActions">
        <button type="button" onClick={() => setDraftPoints([])} disabled={busy || !draftPoints.length}>
          Clear draft
        </button>
        <button type="button" onClick={() => void saveDraftMeasurement()} disabled={busy || draftPoints.length < 3}>
          Save polygon
        </button>
      </div>

      <div className="takeoffMeta">
        <div>
          <strong>{activeBlueprint?.file_name ?? 'No blueprint selected'}</strong>
          <p className="muted">
            {activeBlueprint ? `v${activeBlueprint.version} · ${activeBlueprint.deleted_at ? 'deleted' : 'active'}` : 'Choose a blueprint to start drawing.'}
          </p>
        </div>
        <div>
          <strong>{draftPoints.length} points</strong>
          <p className="muted">Polygon area is computed in-board and multiplied by the selected quantity multiplier.</p>
        </div>
        <div>
          <strong>{calibrationLength || '0'} {calibrationUnit}</strong>
          <p className="muted">Calibration metadata is saved with each measurement for later refinement.</p>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      <p className="muted takeoffHint">
        Click the board to place vertices. The current draft is highlighted with numbered points and a live crosshair.
      </p>
      <ul className="list compact takeoffMeasurements">
        {blueprintMeasurements.length ? (
          blueprintMeasurements.map((measurement) => (
            <li key={measurement.id}>
              <strong>{measurement.service_item_code}</strong>
              <span>
                {measurement.quantity} {measurement.unit}
                {measurement.notes ? ` · ${measurement.notes}` : ''}
              </span>
            </li>
          ))
        ) : (
          <li>No measurements on this blueprint yet</li>
        )}
      </ul>
    </div>
  )
}

function polygonArea(points: Array<{ x: number; y: number }>) {
  if (points.length < 3) return 0
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (!current || !next) continue
    sum += current.x * next.y - next.x * current.y
  }
  return Math.abs(sum / 2)
}

function polygonCentroid(points: Array<{ x: number; y: number }>) {
  if (points.length < 3) return null
  let areaFactor = 0
  let cx = 0
  let cy = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (!current || !next) continue
    const cross = current.x * next.y - next.x * current.y
    areaFactor += cross
    cx += (current.x + next.x) * cross
    cy += (current.y + next.y) * cross
  }
  const area = areaFactor / 2
  if (area === 0) return null
  return { x: cx / (6 * area), y: cy / (6 * area) }
}

function polygonPointsToString(points: Array<{ x: number; y: number }>) {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
}

function getBlueprintLineageLabel(blueprints: BlueprintRow[], blueprintId: string) {
  const byId = new Map(blueprints.map((blueprint) => [blueprint.id, blueprint]))
  const chain: BlueprintRow[] = []
  const seen = new Set<string>()
  let current = byId.get(blueprintId) ?? null
  while (current && !seen.has(current.id)) {
    chain.push(current)
    seen.add(current.id)
    current = current.replaces_blueprint_document_id ? byId.get(current.replaces_blueprint_document_id) ?? null : null
  }
  const labels = chain
    .slice()
    .reverse()
    .map((blueprint) => `v${blueprint.version}`)
  return labels.length ? labels.join(' → ') : `v${byId.get(blueprintId)?.version ?? 1}`
}

function MutationOutboxWidget({ companySlug, refreshKey }: { companySlug: string; refreshKey: number }) {
  const [data, setData] = useState<{ outbox: Array<{ entity_type: string; entity_id: string; mutation_type: string; status: string; created_at: string }> } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = () =>
    apiGet<{ outbox: Array<{ entity_type: string; entity_id: string; mutation_type: string; status: string; created_at: string }> }>('/api/sync/outbox?limit=5', companySlug)
        .then((next) => {
          if (active) setData(next)
        })
        .catch((caught: unknown) => {
          if (active) setError(caught instanceof Error ? caught.message : 'unknown error')
        })

    void load()
    const timer = window.setInterval(() => void load(), 8000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [companySlug, refreshKey])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading mutation outbox...</p>

  if (!data.outbox.length) {
    return <p className="muted">No pending local mutations yet.</p>
  }

  return (
    <ul className="list compact">
      {data.outbox.map((entry) => (
        <li key={`${entry.entity_type}:${entry.entity_id}:${entry.created_at}`}>
          <strong>{entry.entity_type}</strong>
          <span>
            {entry.mutation_type} · {entry.status} · {entry.created_at}
          </span>
        </li>
      ))}
    </ul>
  )
}

function OfflineQueueWidget({ companySlug, queue }: { companySlug: string; queue: OfflineMutation[] }) {
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshTick((current) => current + 1), 6000)
    const handleStorage = () => setRefreshTick((current) => current + 1)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const scopedQueue = queue.filter((mutation) => mutation.companySlug === companySlug)

  return (
    <div className="offlineQueue">
      <div className="rowBetween">
        <h3>Local Offline Queue</h3>
        <span className="muted">refresh {refreshTick}</span>
      </div>
      {scopedQueue.length ? (
        <ul className="list compact">
          {scopedQueue.map((mutation) => (
            <li key={mutation.id}>
              <strong>{mutation.method} {mutation.path}</strong>
              <span>{mutation.createdAt} · {mutation.userId}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No queued offline mutations.</p>
      )}
    </div>
  )
}
