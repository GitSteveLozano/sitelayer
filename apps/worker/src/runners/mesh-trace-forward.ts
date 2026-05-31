import { createHash, createHmac } from 'node:crypto'
import type { Pool } from 'pg'

/**
 * Mesh trace forwarder — the SERVER lane of the observability spectrum (T3,
 * records-nothing). Ships sitelayer's own deterministic workflow transitions
 * (workflow_event_log) to the mesh product-trace ingest, where the
 * flow-conformance keeper types them against sitelayer's statechart-ologs and
 * clusters failures into deduped issues — finding bugs for users who recorded
 * nothing. Capture-session events are forwarded as the same low-PII product
 * trace shape so public-link/mobile/browser behavior reaches the learning
 * pipeline even when no deterministic workflow row fired.
 *
 * Design constraints (deliberate):
 *  - ISOLATED: a standalone interval loop, NOT wired into the lifecycle/queue
 *    heartbeat, so it can never stall or break the critical rental-invoice / QBO
 *    runners. A failure here logs and is dropped.
 *  - OPT-IN / OFF BY DEFAULT: no-ops unless MESH_TRACE_FORWARD_URL +
 *    MESH_TRACE_HMAC_COMPONENT + MESH_TRACE_HMAC_SECRET are all set. This honors
 *    the collaborator-workstation rule (no Mesh dependency) and means merging it
 *    is inert until the operator sets the env in the GitHub production environment.
 *  - SECRET FROM ENV ONLY: the HMAC secret is never committed; it is minted in
 *    mesh (component_auth_secrets) and injected via the GitHub `production` env,
 *    per sitelayer's secret rules.
 *  - LOW-PII: forwards only typed flow shape (workflow_name, state, outcome,
 *    state_version), never event_payload bodies. mesh additionally templates +
 *    redacts on ingest.
 *  - IDEMPOTENT: overlapping window each tick; mesh dedups by event_ref
 *    (derived from entity_id + state_version), so re-sends are no-ops.
 */

type ForwarderConfig = {
  url: string
  component: string
  secretHex: string
  projectKey: string
  intervalMs: number
  windowMinutes: number
  requestTimeoutMs: number
}

function readConfig(): ForwarderConfig | null {
  const url = process.env.MESH_TRACE_FORWARD_URL?.trim()
  const component = process.env.MESH_TRACE_HMAC_COMPONENT?.trim()
  const secretHex = process.env.MESH_TRACE_HMAC_SECRET?.trim()
  if (!url || !component || !secretHex) return null
  return {
    url,
    component,
    secretHex,
    projectKey: process.env.MESH_TRACE_PROJECT_KEY?.trim() || 'sitelayer',
    intervalMs: Number(process.env.MESH_TRACE_FORWARD_INTERVAL_MS ?? '60000') || 60000,
    windowMinutes: Number(process.env.MESH_TRACE_FORWARD_WINDOW_MIN ?? '10') || 10,
    // Hard ceiling on each ingest POST. If mesh/the operator gateway is down or
    // hanging, the fetch aborts fast instead of holding a socket open for the OS
    // TCP timeout (minutes) — which, combined with the overlap guard below,
    // guarantees a dead operator stack can NEVER pile up work in / degrade the
    // sitelayer worker (invoicing / QBO sync stay unaffected).
    requestTimeoutMs: Number(process.env.MESH_TRACE_FORWARD_TIMEOUT_MS ?? '8000') || 8000,
  }
}

// Terminal/failure workflow states + events → outcome=failed (the keeper's
// strongest issue signal). Everything else is succeeded.
const FAILURE_STATES = new Set([
  'failed',
  'voided',
  'declined',
  'failed_provider',
  'failed_clerk_unreachable',
  'failed_clerk_not_found',
])
const FAILURE_EVENTS = new Set(['POST_FAILED', 'SYNC_FAILED', 'FAILED'])

type Row = {
  workflow_name: string
  entity_id: string
  capture_session_id: string | null
  state_version: number
  event_type: string
  state_after: string | null
  applied_at: string
}

type CaptureEventRow = {
  id: string
  capture_session_id: string
  seq: number
  event_type: string
  event_class: string
  route_path: string | null
  workflow_id: string | null
  entity_type: string | null
  entity_id: string | null
  occurred_at: string
}

function workflowEventRef(r: Row): string {
  const digest = createHash('sha256')
    .update(`${r.workflow_name}:${r.entity_id}:${r.state_version}`)
    .digest('hex')
    .slice(0, 16)
  return `workflow_event:${r.workflow_name}:${digest}:${r.state_version}`
}

function toTraceEvent(r: Row) {
  const stateAfter = (r.state_after ?? '').toString()
  const failed = FAILURE_STATES.has(stateAfter) || FAILURE_EVENTS.has(r.event_type)
  return {
    event_ref: workflowEventRef(r),
    session_id: r.capture_session_id ?? r.entity_id,
    capture_session_id: r.capture_session_id ?? undefined,
    seq: r.state_version,
    event_class: 'workflow_event',
    // route_path is a coarse, PII-free flow handle (mesh templates further).
    route_path: `/wf/${r.workflow_name}`,
    state_after: stateAfter,
    outcome: failed ? 'failed' : 'succeeded',
    error_code: failed ? r.event_type : '',
    occurred_at: new Date(r.applied_at).toISOString(),
    payload: { workflow_id: r.workflow_name, event_name: r.event_type },
  }
}

function captureEventRef(r: CaptureEventRow): string {
  return `capture_session_event:${r.id}`
}

function normalizedRoutePath(routePath: string | null): string {
  const trimmed = routePath?.trim()
  if (!trimmed) return '/capture/session'
  const [pathOnly] = trimmed.split(/[?#]/, 1)
  return pathOnly || '/capture/session'
}

function toCaptureTraceEvent(r: CaptureEventRow) {
  const eventType = r.event_type.toString()
  const failed = /\b(error|fail|exception|crash|blocked)\b/i.test(eventType)
  return {
    event_ref: captureEventRef(r),
    session_id: r.capture_session_id,
    capture_session_id: r.capture_session_id,
    seq: Number(r.seq),
    event_class: r.event_class || 'capture_session_event',
    route_path: normalizedRoutePath(r.route_path),
    state_after: '',
    outcome: failed ? 'failed' : 'succeeded',
    error_code: failed ? eventType : '',
    occurred_at: new Date(r.occurred_at).toISOString(),
    payload: {
      event_name: eventType,
      workflow_id: r.workflow_id ?? undefined,
      entity_type: r.entity_type ?? undefined,
      entity_id: r.entity_id ?? undefined,
    },
  }
}

function signedHeaders(cfg: ForwarderConfig, path: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString()
  const bodySha = createHash('sha256').update(body).digest('hex')
  const canonical = `${ts}.POST.${path}.${bodySha}`
  const sig = 'sha256=' + createHmac('sha256', Buffer.from(cfg.secretHex, 'hex')).update(canonical).digest('hex')
  return {
    'Content-Type': 'application/json',
    'X-Mesh-Component': cfg.component,
    'X-Mesh-Timestamp': ts,
    'X-Mesh-Signature': sig,
  }
}

async function forwardOnce(pool: Pool, cfg: ForwarderConfig, log: (m: string) => void): Promise<void> {
  const [workflowRows, captureRows] = await Promise.all([
    pool.query<Row>(
      `SELECT workflow_name, entity_id::text AS entity_id, capture_session_id::text AS capture_session_id, state_version, event_type,
              snapshot_after->>'state' AS state_after, applied_at
         FROM workflow_event_log
        WHERE applied_at > now() - ($1 || ' minutes')::interval
        ORDER BY applied_at
        LIMIT 500`,
      [cfg.windowMinutes],
    ),
    pool.query<CaptureEventRow>(
      `SELECT id::text AS id,
              capture_session_id::text AS capture_session_id,
              seq::int AS seq,
              event_type,
              event_class,
              route_path,
              workflow_id,
              entity_type,
              entity_id,
              occurred_at
         FROM capture_session_events
        WHERE occurred_at > now() - ($1 || ' minutes')::interval
        ORDER BY occurred_at
        LIMIT 500`,
      [cfg.windowMinutes],
    ),
  ])
  if (workflowRows.rows.length === 0 && captureRows.rows.length === 0) return
  const events = [...workflowRows.rows.map(toTraceEvent), ...captureRows.rows.map(toCaptureTraceEvent)]
  const path = '/api/product-trace/ingest'
  const body = JSON.stringify({ project_key: cfg.projectKey, tier: 3, events })
  const base = cfg.url.replace(/\/$/, '')
  const res = await fetch(base + path, {
    method: 'POST',
    headers: signedHeaders(cfg, path, body),
    body,
    // Fail fast if the operator stack is unreachable/hanging — never block on a dead host.
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  })
  if (!res.ok) {
    log(`mesh-trace-forward: ingest HTTP ${res.status}`)
    return
  }
  log(`mesh-trace-forward: forwarded ${events.length} trace event(s)`)
}

/**
 * Start the forwarder. Returns a stop() handle. No-op (logs once) when env is
 * not configured. Never throws into the caller — all errors are swallowed +
 * logged so the worker's critical path is unaffected.
 */
export function startMeshTraceForwarder(deps: {
  pool: Pool
  logger?: { info: (m: string) => void; warn?: (m: string) => void }
}): { stop: () => void } {
  const log = (m: string) => (deps.logger?.info ? deps.logger.info(m) : console.log(m))
  const cfg = readConfig()
  if (!cfg) {
    log(
      'mesh-trace-forward: disabled (set MESH_TRACE_FORWARD_URL + MESH_TRACE_HMAC_COMPONENT + MESH_TRACE_HMAC_SECRET to enable)',
    )
    return { stop: () => {} }
  }
  log(`mesh-trace-forward: enabled → ${cfg.url} (project=${cfg.projectKey}, every ${cfg.intervalMs}ms)`)
  // Overlap guard: if a tick is still in flight (mesh slow/down even within the
  // request timeout), skip the next one rather than stacking concurrent fetches
  // + DB queries. With requestTimeoutMs as the hard ceiling, at most ONE forward
  // is ever in flight, so a dead operator stack can never exhaust the worker's
  // pg pool or memory — sitelayer's critical path is structurally insulated.
  let inFlight = false
  const timer = setInterval(() => {
    if (inFlight) return
    inFlight = true
    forwardOnce(deps.pool, cfg, log)
      .catch((err) => log(`mesh-trace-forward: tick error: ${err?.message ?? err}`))
      .finally(() => {
        inFlight = false
      })
  }, cfg.intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return { stop: () => clearInterval(timer) }
}

export const __meshTraceForwardTestHooks = {
  toCaptureTraceEvent,
  toTraceEvent,
  workflowEventRef,
}
