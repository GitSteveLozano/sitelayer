type SupportLevel = 'debug' | 'info' | 'warning' | 'error'

type SupportEvent = {
  at: string
  category: string
  name: string
  level: SupportLevel
  data?: unknown
}

export type SupportRequestRecord = {
  id: string
  started_at: string
  finished_at?: string
  method: string
  path: string
  company_slug?: string
  request_id?: string
  response_request_id?: string
  status?: number
  ok?: boolean
  duration_ms?: number
  error?: string
  offline?: boolean
}

type SupportSnapshot = {
  captured_at: string
  name: string
  data: unknown
}

export type SupportPacketClient = {
  recorder_version: string
  captured_at: string
  page: {
    href: string
    path: string
    search: string
    title: string
    visibility_state: string
  }
  browser: {
    user_agent: string
    language: string
    timezone: string
    online: boolean
    viewport: { width: number; height: number; device_pixel_ratio: number }
  }
  build: {
    mode: string
    release: string
  }
  problem?: string
  timeline: SupportEvent[]
  requests: SupportRequestRecord[]
  state_snapshots: SupportSnapshot[]
  offline_queue: {
    depth: number
    entries: Array<{
      id?: string
      method?: string
      path?: string
      companySlug?: string
      createdAt?: string
      clientUpdatedAt?: string
      entityLabel?: string
    }>
  }
}

const RECORDER_VERSION = 'support-recorder-v1'
const STORAGE_KEY = 'sitelayer.supportRecorder'
const OFFLINE_QUEUE_KEY = 'sitelayer.offlineQueue'
const MAX_EVENTS = 120
const MAX_REQUESTS = 80
const MAX_SNAPSHOTS = 20
const MAX_STRING_LENGTH = 800
const MAX_ARRAY_LENGTH = 40
const MAX_OBJECT_KEYS = 80
const SENSITIVE_KEY =
  /authorization|cookie|password|passwd|secret|token|jwt|session|csrf|api[-_]?key|access[-_]?token|refresh[-_]?token/i

const state: {
  installed: boolean
  timeline: SupportEvent[]
  requests: SupportRequestRecord[]
  stateSnapshots: SupportSnapshot[]
} = {
  installed: false,
  timeline: [],
  requests: [],
  stateSnapshots: [],
}

function nowIso(): string {
  return new Date().toISOString()
}

function pushBounded<T>(items: T[], item: T, max: number): void {
  items.push(item)
  if (items.length > max) {
    items.splice(0, items.length - max)
  }
}

function redactString(value: string, maxLength = MAX_STRING_LENGTH): string {
  const redacted = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[phone]')
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...[truncated]` : redacted
}

export function sanitizeForSupport(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max_depth]'
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack, 2000) : null,
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeForSupport(entry, depth + 1))
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeForSupport(entry, depth + 1)
    }
    return output
  }
  return String(value)
}

function persist(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        timeline: state.timeline,
        requests: state.requests,
        stateSnapshots: state.stateSnapshots,
      }),
    )
  } catch {
    // Support telemetry is best-effort and must never affect app behavior.
  }
}

function hydrate(): void {
  if (typeof window === 'undefined') return
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<typeof state>
    if (Array.isArray(parsed.timeline)) state.timeline = parsed.timeline.slice(-MAX_EVENTS)
    if (Array.isArray(parsed.requests)) state.requests = parsed.requests.slice(-MAX_REQUESTS)
    if (Array.isArray(parsed.stateSnapshots)) state.stateSnapshots = parsed.stateSnapshots.slice(-MAX_SNAPSHOTS)
  } catch {
    // Ignore corrupt support-recorder storage.
  }
}

export function recordSupportEvent(input: {
  category: string
  name: string
  level?: SupportLevel
  data?: unknown
}): void {
  const event: SupportEvent = {
    at: nowIso(),
    category: input.category,
    name: input.name,
    level: input.level ?? 'info',
    ...(input.data !== undefined ? { data: sanitizeForSupport(input.data) } : {}),
  }
  pushBounded(state.timeline, event, MAX_EVENTS)
  persist()
}

export function recordSupportRoute(path: string, search: string): void {
  recordSupportEvent({
    category: 'route',
    name: 'route.changed',
    data: { path, search: redactString(search, 256) },
  })
}

export function recordSupportState(name: string, data: unknown): void {
  const snapshot: SupportSnapshot = {
    captured_at: nowIso(),
    name,
    data: sanitizeForSupport(data),
  }
  const existingIndex = state.stateSnapshots.findIndex((entry) => entry.name === name)
  if (existingIndex >= 0) {
    state.stateSnapshots.splice(existingIndex, 1)
  }
  pushBounded(state.stateSnapshots, snapshot, MAX_SNAPSHOTS)
  persist()
}

export function startSupportRequest(input: {
  method: string
  path: string
  companySlug?: string
  requestId?: string
  offline?: boolean
}): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `request-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const record: SupportRequestRecord = {
    id,
    started_at: nowIso(),
    method: input.method,
    path: input.path,
    ...(input.companySlug ? { company_slug: input.companySlug } : {}),
    ...(input.requestId ? { request_id: input.requestId } : {}),
    ...(input.offline !== undefined ? { offline: input.offline } : {}),
  }
  pushBounded(state.requests, record, MAX_REQUESTS)
  persist()
  return id
}

export function finishSupportRequest(
  id: string,
  input: {
    status?: number
    ok?: boolean
    responseRequestId?: string | null
    error?: unknown
  },
): void {
  const record = state.requests.find((entry) => entry.id === id)
  if (!record) return
  const finishedAt = Date.now()
  const startedAt = Date.parse(record.started_at)
  record.finished_at = new Date(finishedAt).toISOString()
  if (Number.isFinite(startedAt)) record.duration_ms = finishedAt - startedAt
  if (input.status !== undefined) record.status = input.status
  if (input.ok !== undefined) record.ok = input.ok
  if (input.responseRequestId) record.response_request_id = input.responseRequestId
  if (input.error !== undefined) {
    record.error =
      typeof input.error === 'string' ? redactString(input.error) : JSON.stringify(sanitizeForSupport(input.error))
  }
  persist()
}

function readOfflineQueueSummary(): SupportPacketClient['offline_queue'] {
  if (typeof window === 'undefined') return { depth: 0, entries: [] }
  try {
    const raw = window.localStorage.getItem(OFFLINE_QUEUE_KEY)
    if (!raw) return { depth: 0, entries: [] }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return { depth: 0, entries: [] }
    return {
      depth: parsed.length,
      entries: parsed.slice(-25).map((entry) => {
        const row = sanitizeForSupport(entry) as Record<string, unknown>
        return {
          ...(typeof row.id === 'string' ? { id: row.id } : {}),
          ...(typeof row.method === 'string' ? { method: row.method } : {}),
          ...(typeof row.path === 'string' ? { path: row.path } : {}),
          ...(typeof row.companySlug === 'string' ? { companySlug: row.companySlug } : {}),
          ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
          ...(typeof row.clientUpdatedAt === 'string' ? { clientUpdatedAt: row.clientUpdatedAt } : {}),
          ...(typeof row.entityLabel === 'string' ? { entityLabel: row.entityLabel } : {}),
        }
      }),
    }
  } catch {
    return { depth: 0, entries: [] }
  }
}

export function buildSupportPacket(problem?: string): SupportPacketClient {
  const viewport =
    typeof window === 'undefined'
      ? { width: 0, height: 0, device_pixel_ratio: 1 }
      : {
          width: window.innerWidth,
          height: window.innerHeight,
          device_pixel_ratio: window.devicePixelRatio || 1,
        }
  const page =
    typeof window === 'undefined'
      ? { href: '', path: '', search: '', title: '', visibility_state: 'visible' }
      : {
          href: redactString(window.location.href, 1200),
          path: window.location.pathname,
          search: redactString(window.location.search, 600),
          title: redactString(document.title, 200),
          visibility_state: document.visibilityState,
        }
  const browser =
    typeof navigator === 'undefined'
      ? { user_agent: '', language: '', timezone: 'unknown', online: true, viewport }
      : {
          user_agent: redactString(navigator.userAgent, 600),
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown',
          online: navigator.onLine,
          viewport,
        }

  return {
    recorder_version: RECORDER_VERSION,
    captured_at: nowIso(),
    page,
    browser,
    build: {
      mode: import.meta.env.MODE || 'local',
      release: import.meta.env.VITE_SENTRY_RELEASE || import.meta.env.MODE || 'local',
    },
    ...(problem?.trim() ? { problem: redactString(problem.trim(), 4000) } : {}),
    timeline: state.timeline.slice(-MAX_EVENTS),
    requests: state.requests.slice(-MAX_REQUESTS),
    state_snapshots: state.stateSnapshots.slice(-MAX_SNAPSHOTS),
    offline_queue: readOfflineQueueSummary(),
  }
}

function readElementLabel(element: Element): string | null {
  const aria =
    element.getAttribute('aria-label') || element.getAttribute('data-testid') || element.getAttribute('title')
  if (aria?.trim()) return redactString(aria.trim(), 120)
  const text = element.textContent?.replace(/\s+/g, ' ').trim()
  return text ? redactString(text, 120) : null
}

function installActionListeners(): void {
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target : null
      const actionable = target?.closest('button,a,[role="button"],input[type="submit"],input[type="button"]')
      if (!actionable) return
      recordSupportEvent({
        category: 'ui',
        name: 'action.clicked',
        data: {
          tag: actionable.tagName.toLowerCase(),
          role: actionable.getAttribute('role'),
          label: readElementLabel(actionable),
          href: actionable instanceof HTMLAnchorElement ? actionable.pathname : null,
        },
      })
    },
    { capture: true },
  )

  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target instanceof HTMLFormElement ? event.target : null
      recordSupportEvent({
        category: 'ui',
        name: 'form.submitted',
        data: {
          id: form?.id || null,
          name: form?.getAttribute('name') || null,
          action: form?.getAttribute('action') || null,
        },
      })
    },
    { capture: true },
  )
}

function installErrorListeners(): void {
  window.addEventListener('error', (event) => {
    recordSupportEvent({
      category: 'browser',
      name: 'window.error',
      level: 'error',
      data: {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error,
      },
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    recordSupportEvent({
      category: 'browser',
      name: 'promise.unhandled_rejection',
      level: 'error',
      data: { reason: event.reason },
    })
  })
  window.addEventListener('online', () => recordSupportEvent({ category: 'browser', name: 'network.online' }))
  window.addEventListener('offline', () =>
    recordSupportEvent({ category: 'browser', name: 'network.offline', level: 'warning' }),
  )
}

export function installSupportRecorder(): void {
  if (typeof window === 'undefined' || state.installed) return
  state.installed = true
  hydrate()
  installActionListeners()
  installErrorListeners()
  recordSupportEvent({
    category: 'browser',
    name: 'recorder.installed',
    data: { version: RECORDER_VERSION },
  })
}
