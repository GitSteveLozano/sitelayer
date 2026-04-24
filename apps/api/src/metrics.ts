import client from 'prom-client'
import type { Pool } from 'pg'

const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

const requestCounter = new client.Counter({
  name: 'sitelayer_http_requests_total',
  help: 'Total HTTP requests handled by the API',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
})

const requestDuration = new client.Histogram({
  name: 'sitelayer_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
})

const requestErrors = new client.Counter({
  name: 'sitelayer_http_request_errors_total',
  help: 'HTTP requests that produced an error response (status >= 500)',
  labelNames: ['method', 'route'],
  registers: [registry],
})

const queueDepth = new client.Gauge({
  name: 'sitelayer_queue_pending_count',
  help: 'Pending rows awaiting worker apply, by queue table',
  labelNames: ['queue'],
  registers: [registry],
})

const auditEventsTotal = new client.Counter({
  name: 'sitelayer_audit_events_total',
  help: 'Audit events written to audit_events table',
  labelNames: ['entity_type', 'action'],
  registers: [registry],
})

const dbPoolGauge = new client.Gauge({
  name: 'sitelayer_db_pool_state',
  help: 'pg Pool client counts (total / idle / waiting)',
  labelNames: ['state'],
  registers: [registry],
  collect() {},
})

let attachedPool: Pool | null = null

export function attachPool(pool: Pool): void {
  attachedPool = pool
}

export function observeRequest(method: string, route: string, status: number, durationMs: number): void {
  const labels = { method, route, status: String(status) }
  requestCounter.inc(labels)
  requestDuration.observe(labels, durationMs / 1000)
  if (status >= 500) {
    requestErrors.inc({ method, route })
  }
}

export function observeAudit(entityType: string, action: string): void {
  auditEventsTotal.inc({ entity_type: entityType, action })
}

let lastQueueRefreshAt = 0
async function refreshQueueGauges(): Promise<void> {
  if (!attachedPool) return
  const now = Date.now()
  if (now - lastQueueRefreshAt < 5_000) return
  lastQueueRefreshAt = now
  try {
    const [outbox, sync] = await Promise.all([
      attachedPool.query<{ count: string }>(
        `select count(*)::text as count from mutation_outbox where status in ('pending', 'processing')`,
      ),
      attachedPool.query<{ count: string }>(
        `select count(*)::text as count from sync_events where status in ('pending', 'processing')`,
      ),
    ])
    queueDepth.set({ queue: 'mutation_outbox' }, Number(outbox.rows[0]?.count ?? 0))
    queueDepth.set({ queue: 'sync_events' }, Number(sync.rows[0]?.count ?? 0))
  } catch {
    // best-effort; metrics scrape must not throw
  }
}

function refreshDbPoolGauge(): void {
  if (!attachedPool) return
  dbPoolGauge.set({ state: 'total' }, attachedPool.totalCount ?? 0)
  dbPoolGauge.set({ state: 'idle' }, attachedPool.idleCount ?? 0)
  dbPoolGauge.set({ state: 'waiting' }, attachedPool.waitingCount ?? 0)
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  refreshDbPoolGauge()
  await refreshQueueGauges()
  const body = await registry.metrics()
  return { contentType: registry.contentType, body }
}

export function metricsRegistry(): client.Registry {
  return registry
}
