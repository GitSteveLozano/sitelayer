import client from 'prom-client'

// Worker-side metrics registry.
//
// KNOWN GAP (2026-05-17): the worker doesn't currently expose a
// `/metrics` HTTP listener — there's no scrape surface here. These
// counters increment correctly and are kept in a separate Registry
// instance from the API, but Prometheus can't pull them until a
// listener is wired in `worker.ts` (or the counters are persisted to a
// row that the API can read).
//
// The increments stay in the code so the wiring is mechanical and the
// metric appears the moment a scrape surface exists. Until then, the
// authoritative success/fail counts come from the API-side increments
// (route handlers that dispatch START_SYNC, POST_REQUESTED, VOID,
// RETRY_POST, etc.) and from workflow_event_log replay.

const registry = new client.Registry()

const workflowEventTotal = new client.Counter({
  name: 'sitelayer_workflow_event_total',
  help: 'Workflow events dispatched by workflow + outcome (worker-side increments)',
  labelNames: ['workflow', 'outcome'] as const,
  registers: [registry],
})

// Tracks queue pruning + storage GC outcomes. `queue` is one of
// 'mutation_outbox' | 'sync_events' | 'blueprint_storage_gc'; outcome
// is one of 'pruned' | 'deleted' | 'skipped' | 'failed'. Cardinality
// is bounded at <= 12 series. Counters survive across heartbeats so
// the daily prune total accrues until process restart (matching the
// pattern of the other counters here).
const queuePrunedTotal = new client.Counter({
  name: 'sitelayer_queue_pruned_total',
  help: 'Queue prune + storage GC outcomes by queue and outcome',
  labelNames: ['queue', 'outcome'] as const,
  registers: [registry],
})

/**
 * Record a queue-prune or storage-GC outcome. `count` increments the
 * counter by that many (default 1) — the prune runner reports a row
 * count, the GC runner reports per-row outcomes.
 */
export function observeQueuePruneOrGc(queue: string, outcome: string, count = 1): void {
  try {
    queuePrunedTotal.inc({ queue, outcome }, count)
  } catch {
    // never surface metric errors into the worker
  }
}

// Adaptive-backoff visibility. `level=base|max` are set once at boot;
// `level=current` updates every time the scheduler changes intervals.
// Useful as a Prometheus gauge to graph how often the worker is sitting
// at max vs base in production.
const workerTickIntervalMs = new client.Gauge({
  name: 'sitelayer_worker_tick_interval_ms',
  help: 'Worker tick interval (ms) by level: base, max, or current backoff state',
  labelNames: ['level'] as const,
  registers: [registry],
})

/**
 * Record the worker tick interval for a given level (base | max | current).
 * Called by `lifecycle.ts` at boot and every time the backoff changes.
 */
export function observeWorkerTickInterval(level: 'base' | 'max' | 'current', ms: number): void {
  try {
    workerTickIntervalMs.set({ level }, ms)
  } catch {
    // never surface metric errors into the worker
  }
}

/**
 * Mirror of `observeWorkflowEvent` in apps/api/src/metrics.ts. Same
 * outcome label set (`requested|succeeded|failed|voided|retried`),
 * same workflow names. Best-effort: must not throw into the worker
 * tick.
 */
export function observeWorkflowEvent(workflow: string, outcome: string): void {
  try {
    workflowEventTotal.inc({ workflow, outcome })
  } catch {
    // never surface metric errors into the worker
  }
}

export function metricsRegistry(): client.Registry {
  return registry
}
