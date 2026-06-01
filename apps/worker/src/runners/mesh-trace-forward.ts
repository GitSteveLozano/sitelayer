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
 *    runners. A failure here logs and is recorded for retry/proof.
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
 *    (derived from entity_id + state_version), and Sitelayer records forwarded
 *    event_refs in mesh_trace_forward_state so successful sends are locally
 *    provable and skipped on future windows.
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

export type MeshTraceForwardSummary = {
  ran: boolean
  reason?: string
  workflow_events: number
  capture_session_events: number
  forwarded_events: number
  skipped_forwarded_events?: number
  status: number | null
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
  id?: string
  company_id?: string
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
  company_id?: string
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

type WorkflowForwardRow = Row & {
  id: string
  company_id: string
}

type CaptureForwardRow = CaptureEventRow & {
  company_id: string
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

type ProductTraceEvent = ReturnType<typeof toTraceEvent> | ReturnType<typeof toCaptureTraceEvent>

type ForwardableTraceEvent = {
  company_id: string
  event_ref: string
  source_kind: 'workflow_event_log' | 'capture_session_event'
  source_id: string
  capture_session_id: string | null
  event: ProductTraceEvent
}

type ForwardStateStatus = 'forwarded' | 'failed'

type ForwardStateRecord = {
  company_id: string
  event_ref: string
  source_kind: ForwardableTraceEvent['source_kind']
  source_id: string
  capture_session_id: string | null
  project_key: string
  status: ForwardStateStatus
  last_status: number | null
  last_error: string | null
  payload: ProductTraceEvent
}

function toWorkflowForwardable(row: WorkflowForwardRow): ForwardableTraceEvent {
  const event = toTraceEvent(row)
  return {
    company_id: row.company_id,
    event_ref: event.event_ref,
    source_kind: 'workflow_event_log',
    source_id: row.id,
    capture_session_id: row.capture_session_id,
    event,
  }
}

function toCaptureForwardable(row: CaptureForwardRow): ForwardableTraceEvent {
  const event = toCaptureTraceEvent(row)
  return {
    company_id: row.company_id,
    event_ref: event.event_ref,
    source_kind: 'capture_session_event',
    source_id: row.id,
    capture_session_id: row.capture_session_id,
    event,
  }
}

function filterUnforwardedEvents(events: ForwardableTraceEvent[], forwardedRefs: Set<string>): ForwardableTraceEvent[] {
  return events.filter((event) => !forwardedRefs.has(event.event_ref))
}

function toForwardStateRecords(
  events: ForwardableTraceEvent[],
  args: {
    projectKey: string
    status: ForwardStateStatus
    httpStatus: number | null
    error: string | null
  },
): ForwardStateRecord[] {
  const lastError = args.error ? args.error.slice(0, 1000) : null
  return events.map((event) => ({
    company_id: event.company_id,
    event_ref: event.event_ref,
    source_kind: event.source_kind,
    source_id: event.source_id,
    capture_session_id: event.capture_session_id,
    project_key: args.projectKey,
    status: args.status,
    last_status: args.httpStatus,
    last_error: lastError,
    payload: event.event,
  }))
}

async function loadForwardedEventRefs(pool: Pool, events: ForwardableTraceEvent[]): Promise<Set<string>> {
  const refs = Array.from(new Set(events.map((event) => event.event_ref)))
  if (refs.length === 0) return new Set()
  const rows = await pool.query<{ event_ref: string }>(
    `select event_ref
       from mesh_trace_forward_state
      where event_ref = any($1::text[])
        and status = 'forwarded'`,
    [refs],
  )
  return new Set(rows.rows.map((row) => row.event_ref))
}

async function recordTraceForwardState(
  pool: Pool,
  events: ForwardableTraceEvent[],
  args: {
    projectKey: string
    status: ForwardStateStatus
    httpStatus: number | null
    error: string | null
  },
): Promise<void> {
  if (events.length === 0) return
  const records = toForwardStateRecords(events, args)
  await pool.query(
    `insert into mesh_trace_forward_state (
       company_id,
       event_ref,
       source_kind,
       source_id,
       capture_session_id,
       project_key,
       status,
       attempt_count,
       last_attempt_at,
       forwarded_at,
       last_status,
       last_error,
       payload
     )
     select x.company_id::uuid,
            x.event_ref,
            x.source_kind,
            x.source_id,
            x.capture_session_id::uuid,
            x.project_key,
            x.status,
            1,
            now(),
            case when x.status = 'forwarded' then now() else null end,
            x.last_status,
            x.last_error,
            x.payload
       from jsonb_to_recordset($1::jsonb) as x(
         company_id text,
         event_ref text,
         source_kind text,
         source_id text,
         capture_session_id text,
         project_key text,
         status text,
         last_status integer,
         last_error text,
         payload jsonb
       )
     on conflict (company_id, event_ref) do update
       set source_kind = excluded.source_kind,
           source_id = excluded.source_id,
           capture_session_id = coalesce(excluded.capture_session_id, mesh_trace_forward_state.capture_session_id),
           project_key = excluded.project_key,
           status = excluded.status,
           attempt_count = mesh_trace_forward_state.attempt_count + 1,
           last_attempt_at = now(),
           forwarded_at = case
             when excluded.status = 'forwarded'
               then coalesce(mesh_trace_forward_state.forwarded_at, now())
             else mesh_trace_forward_state.forwarded_at
           end,
           last_status = excluded.last_status,
           last_error = excluded.last_error,
           payload = excluded.payload`,
    [JSON.stringify(records)],
  )
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

async function forwardOnce(
  pool: Pool,
  cfg: ForwarderConfig,
  log: (m: string) => void,
): Promise<MeshTraceForwardSummary> {
  const [workflowRows, captureRows] = await Promise.all([
    pool.query<WorkflowForwardRow>(
      `SELECT id::text AS id,
              company_id::text AS company_id,
              workflow_name,
              entity_id::text AS entity_id,
              capture_session_id::text AS capture_session_id,
              state_version,
              event_type,
              snapshot_after->>'state' AS state_after, applied_at
         FROM workflow_event_log
        WHERE applied_at > now() - ($1 || ' minutes')::interval
        ORDER BY applied_at
        LIMIT 500`,
      [cfg.windowMinutes],
    ),
    pool.query<CaptureForwardRow>(
      `SELECT id::text AS id,
              company_id::text AS company_id,
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
  if (workflowRows.rows.length === 0 && captureRows.rows.length === 0) {
    return {
      ran: true,
      reason: 'no_events',
      workflow_events: 0,
      capture_session_events: 0,
      forwarded_events: 0,
      status: null,
    }
  }
  const candidates = [...workflowRows.rows.map(toWorkflowForwardable), ...captureRows.rows.map(toCaptureForwardable)]
  const forwardedRefs = await loadForwardedEventRefs(pool, candidates)
  const unforwarded = filterUnforwardedEvents(candidates, forwardedRefs)
  if (unforwarded.length === 0) {
    return {
      ran: true,
      reason: 'already_forwarded',
      workflow_events: workflowRows.rows.length,
      capture_session_events: captureRows.rows.length,
      forwarded_events: 0,
      skipped_forwarded_events: candidates.length,
      status: null,
    }
  }
  const events = unforwarded.map((candidate) => candidate.event)
  const path = '/api/product-trace/ingest'
  const body = JSON.stringify({ project_key: cfg.projectKey, tier: 3, events })
  const base = cfg.url.replace(/\/$/, '')
  let res: Response
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: signedHeaders(cfg, path, body),
      body,
      // Fail fast if the operator stack is unreachable/hanging — never block on a dead host.
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    })
  } catch (error) {
    await recordTraceForwardState(pool, unforwarded, {
      projectKey: cfg.projectKey,
      status: 'failed',
      httpStatus: null,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  if (!res.ok) {
    log(`mesh-trace-forward: ingest HTTP ${res.status}`)
    await recordTraceForwardState(pool, unforwarded, {
      projectKey: cfg.projectKey,
      status: 'failed',
      httpStatus: res.status,
      error: `HTTP ${res.status}`,
    })
    return {
      ran: true,
      workflow_events: workflowRows.rows.length,
      capture_session_events: captureRows.rows.length,
      forwarded_events: 0,
      skipped_forwarded_events: candidates.length - unforwarded.length,
      status: res.status,
    }
  }
  await recordTraceForwardState(pool, unforwarded, {
    projectKey: cfg.projectKey,
    status: 'forwarded',
    httpStatus: res.status,
    error: null,
  })
  log(`mesh-trace-forward: forwarded ${events.length} trace event(s)`)
  return {
    ran: true,
    workflow_events: workflowRows.rows.length,
    capture_session_events: captureRows.rows.length,
    forwarded_events: events.length,
    skipped_forwarded_events: candidates.length - unforwarded.length,
    status: res.status,
  }
}

export async function forwardMeshTraceOnce(deps: {
  pool: Pool
  logger?: { info: (m: string) => void; warn?: (m: string) => void }
}): Promise<MeshTraceForwardSummary> {
  const log = (m: string) => (deps.logger?.info ? deps.logger.info(m) : console.log(m))
  const cfg = readConfig()
  if (!cfg) {
    log(
      'mesh-trace-forward: disabled (set MESH_TRACE_FORWARD_URL + MESH_TRACE_HMAC_COMPONENT + MESH_TRACE_HMAC_SECRET to enable)',
    )
    return {
      ran: false,
      reason: 'disabled',
      workflow_events: 0,
      capture_session_events: 0,
      forwarded_events: 0,
      status: null,
    }
  }
  return forwardOnce(deps.pool, cfg, log)
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
  filterUnforwardedEvents,
  forwardOnce,
  toCaptureTraceEvent,
  toForwardStateRecords,
  toTraceEvent,
  workflowEventRef,
}
