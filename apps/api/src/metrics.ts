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

const queueOldestPendingAge = new client.Gauge({
  name: 'sitelayer_queue_oldest_pending_age_seconds',
  help: 'Age in seconds of the oldest pending row, by queue table',
  labelNames: ['queue'],
  registers: [registry],
})

const queueDeadCount = new client.Gauge({
  name: 'sitelayer_queue_dead_count',
  help: 'Count of rows with status=dead/failed (terminal), by queue table',
  labelNames: ['queue'],
  registers: [registry],
})

const circuitBreakerState = new client.Gauge({
  name: 'sitelayer_circuit_breaker_state',
  help: 'Circuit breaker state per integration (0=closed, 1=open)',
  labelNames: ['integration'],
  registers: [registry],
})

const auditEventsTotal = new client.Counter({
  name: 'sitelayer_audit_events_total',
  help: 'Audit events written to audit_events table',
  labelNames: ['entity_type', 'action'],
  registers: [registry],
})

const supportPacketsTotal = new client.Counter({
  name: 'sitelayer_support_packets_total',
  help: 'Support/debug packets created by users or support staff',
  labelNames: ['action'],
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

export function observeSupportPacket(action: string): void {
  supportPacketsTotal.inc({ action })
}

// Queue tables whose pending depth / dead-letter count we surface.
//
// `mutation_outbox` and `sync_events` have a `status` column with terminal
// values 'failed' (worker dead-letter sweep) and 'dead' (kept for forward
// compat).  `notifications` uses status='failed' for permanent failures.
const QUEUE_TABLES: ReadonlyArray<{ queue: string; table: string; deadStatuses: ReadonlyArray<string> }> = [
  { queue: 'mutation_outbox', table: 'mutation_outbox', deadStatuses: ['dead', 'failed'] },
  { queue: 'sync_events', table: 'sync_events', deadStatuses: ['dead', 'failed'] },
  { queue: 'notifications', table: 'notifications', deadStatuses: ['failed'] },
]

let lastQueueRefreshAt = 0
async function refreshQueueGauges(): Promise<void> {
  if (!attachedPool) return
  const now = Date.now()
  if (now - lastQueueRefreshAt < 5_000) return
  lastQueueRefreshAt = now
  try {
    // Per queue table: pending depth, oldest pending row age, dead-letter
    // count. We do all three in one query per table so the lookup count is
    // bounded (3 round trips total for the three queues) and the gauges
    // stay consistent across the scrape window.
    await Promise.all(
      QUEUE_TABLES.map(async ({ queue, table, deadStatuses }) => {
        // Notifications has no 'processing' status — only 'pending' / 'sent' /
        // 'failed'. The other queues add 'processing' for leased rows. We
        // include both in pending depth so a stuck row under lease still
        // counts as backlog.
        const pendingStatuses = queue === 'notifications' ? `'pending'` : `'pending','processing'`
        const deadList = deadStatuses.map((s) => `'${s}'`).join(',')
        const result = await attachedPool!.query<{
          pending_count: string | null
          oldest_age_seconds: string | null
          dead_count: string | null
        }>(
          `select
             (select count(*)::text from ${table} where status in (${pendingStatuses})) as pending_count,
             (select extract(epoch from (now() - min(created_at)))::text from ${table}
              where status in (${pendingStatuses})) as oldest_age_seconds,
             (select count(*)::text from ${table} where status in (${deadList})) as dead_count`,
        )
        const row = result.rows[0] ?? null
        queueDepth.set({ queue }, Number(row?.pending_count ?? 0))
        const ageRaw = row?.oldest_age_seconds
        queueOldestPendingAge.set({ queue }, ageRaw === null || ageRaw === undefined ? 0 : Math.max(0, Number(ageRaw)))
        queueDeadCount.set({ queue }, Number(row?.dead_count ?? 0))
      }),
    )

    // Circuit breaker state is written by the worker via
    // `integration_circuit_state` (migration 074). The API reads the
    // latest snapshot here and republishes as a gauge so the same
    // /api/metrics scrape catches it. Missing rows mean the worker has
    // never tripped the breaker — emit 0 (closed) for the known
    // integrations so the gauge is present after the first scrape.
    try {
      const cbResult = await attachedPool.query<{ integration: string; state: string }>(
        `select integration, state from integration_circuit_state`,
      )
      const seen = new Set<string>()
      for (const row of cbResult.rows) {
        seen.add(row.integration)
        circuitBreakerState.set({ integration: row.integration }, row.state === 'open' ? 1 : 0)
      }
      // Seed known integrations so the gauge is non-absent on first scrape.
      for (const integration of ['qbo']) {
        if (!seen.has(integration)) {
          circuitBreakerState.set({ integration }, 0)
        }
      }
    } catch {
      // Migration 074 may not yet be applied; tolerate missing table.
    }
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
