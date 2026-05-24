type TraceSeverity = 'debug' | 'info' | 'warn' | 'error'
type SitelayerTraceEventType = `sitelayer.${string}`

type ControlPlaneTraceBridge = {
  active?: () => (Record<string, unknown> & { trace_id?: unknown }) | null
  emit?: (event: Record<string, unknown>) => unknown
  capabilities?: () => Record<string, unknown>
}

const REDACTION = {
  status: 'summary_only',
  reason: 'sitelayer_client_trace_tap',
} as const

export function readActiveControlPlaneTrace(): { trace_id: string } | null {
  const bridge = readTraceBridge()
  if (typeof bridge?.active !== 'function') return null

  try {
    const active = bridge.active()
    const traceId = typeof active?.trace_id === 'string' ? active.trace_id.trim() : ''
    return traceId ? { trace_id: traceId } : null
  } catch {
    return null
  }
}

export function readControlPlaneTraceCapabilitiesWhenActive(): Record<string, unknown> | null {
  if (!readActiveControlPlaneTrace()) return null

  try {
    const capabilities = readTraceBridge()?.capabilities?.()
    return isRecord(capabilities) ? capabilities : null
  } catch {
    return null
  }
}

export function emitControlPlaneTrace(
  eventType: SitelayerTraceEventType,
  payload: Record<string, unknown> = {},
  severity: TraceSeverity = 'debug',
): boolean {
  const bridge = readTraceBridge()
  if (typeof bridge?.emit !== 'function') return false

  const activeTrace = readActiveControlPlaneTrace()
  if (!activeTrace) return false

  try {
    void Promise.resolve(
      bridge.emit({
        trace_id: activeTrace.trace_id,
        event_type: eventType,
        severity,
        payload: compactTracePayload({
          route_path: readRoutePath(),
          ...payload,
        }),
        redaction: REDACTION,
      }),
    ).catch(() => {})
    return true
  } catch {
    return false
  }
}

export function compactTraceValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return truncate(value)
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      length: value.length,
      items: value.slice(0, 5).map(compactTraceArrayItem),
    }
  }
  if (isRecord(value)) return compactTraceRecord(value)
  return typeof value
}

export function compactTraceEventType(event: unknown): string | null {
  if (typeof event === 'string' && event.trim()) return truncate(event.trim())
  if (!isRecord(event)) return null
  const type = event.type
  return typeof type === 'string' && type.trim() ? truncate(type.trim()) : null
}

export function compactWorkflowSnapshot(snapshot: unknown): Record<string, unknown> | null {
  if (!isRecord(snapshot)) return null
  const out: Record<string, unknown> = {}
  copyScalar(snapshot, out, 'state')
  copyScalar(snapshot, out, 'status')
  copyScalar(snapshot, out, 'state_version')
  if (Array.isArray(snapshot.next_events)) {
    out.next_events = snapshot.next_events.map(compactTraceArrayItem).slice(0, 10)
  }
  return Object.keys(out).length > 0 ? out : null
}

function compactTracePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || isSensitiveKey(key)) continue
    out[key] = compactTraceValue(value)
  }
  return out
}

function compactTraceRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: 'object' }
  for (const key of [
    'key',
    'value',
    'state',
    'status',
    'state_version',
    'event_type',
    'type',
    'workflow_id',
    'entity_id',
    'entity_type',
    'project_id',
    'run_id',
    'company_slug',
    'lane',
    'severity',
    'category',
    'client_request_id',
    'route_path',
    'out_of_sync',
    'has_error',
  ]) {
    copyScalar(record, out, key)
  }
  if (Array.isArray(record.next_events)) {
    out.next_events = record.next_events.map(compactTraceArrayItem).slice(0, 10)
  }
  out.keys = Object.keys(record)
    .filter((key) => !isSensitiveKey(key))
    .slice(0, 10)
  return out
}

function compactTraceArrayItem(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  const eventType = compactTraceEventType(value)
  if (eventType) return eventType
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    copyScalar(value, out, 'state')
    copyScalar(value, out, 'status')
    copyScalar(value, out, 'state_version')
    return Object.keys(out).length > 0 ? out : { kind: 'object', keys: Object.keys(value).slice(0, 5) }
  }
  return typeof value
}

function copyScalar(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (!(key in source) || isSensitiveKey(key)) return
  const value = source[key]
  if (value === null || typeof value === 'boolean') {
    target[key] = value
  } else if (typeof value === 'number') {
    target[key] = Number.isFinite(value) ? value : null
  } else if (typeof value === 'string') {
    target[key] = truncate(value)
  }
}

function readTraceBridge(): ControlPlaneTraceBridge | null {
  if (typeof window === 'undefined') return null
  return (
    (
      window as Window & {
        __controlPlaneTrace?: ControlPlaneTraceBridge
      }
    ).__controlPlaneTrace ?? null
  )
}

function readRoutePath(): string | null {
  if (typeof window === 'undefined') return null
  return window.location.pathname || null
}

function truncate(value: string, limit = 120): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|cookie|email|phone|summary|title|body|message|reason|url|href|search/i.test(
    key,
  )
}
