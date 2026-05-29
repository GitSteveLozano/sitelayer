import { createHash, createHmac } from 'node:crypto'
import type { Pool } from 'pg'

/**
 * Mesh trace forwarder — the SERVER lane of the observability spectrum (T3,
 * records-nothing). Ships sitelayer's own deterministic workflow transitions
 * (workflow_event_log) to the mesh product-trace ingest, where the
 * flow-conformance keeper types them against sitelayer's statechart-ologs and
 * clusters failures into deduped issues — finding bugs for users who recorded
 * nothing.
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
  }
}

// Terminal/failure workflow states + events → outcome=failed (the keeper's
// strongest issue signal). Everything else is succeeded.
const FAILURE_STATES = new Set(['failed', 'voided', 'declined', 'failed_provider', 'failed_clerk_unreachable', 'failed_clerk_not_found'])
const FAILURE_EVENTS = new Set(['POST_FAILED', 'SYNC_FAILED', 'FAILED'])

type Row = {
  workflow_name: string
  entity_id: string
  state_version: number
  event_type: string
  state_after: string | null
  applied_at: string
}

function toTraceEvent(r: Row) {
  const stateAfter = (r.state_after ?? '').toString()
  const failed = FAILURE_STATES.has(stateAfter) || FAILURE_EVENTS.has(r.event_type)
  return {
    session_id: r.entity_id,
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
  const { rows } = await pool.query<Row>(
    `SELECT workflow_name, entity_id::text AS entity_id, state_version, event_type,
            snapshot_after->>'state' AS state_after, applied_at
       FROM workflow_event_log
      WHERE applied_at > now() - ($1 || ' minutes')::interval
      ORDER BY applied_at
      LIMIT 500`,
    [cfg.windowMinutes],
  )
  if (rows.length === 0) return
  const events = rows.map(toTraceEvent)
  const path = '/api/product-trace/ingest'
  const body = JSON.stringify({ project_key: cfg.projectKey, tier: 3, events })
  const base = cfg.url.replace(/\/$/, '')
  const res = await fetch(base + path, { method: 'POST', headers: signedHeaders(cfg, path, body), body })
  if (!res.ok) {
    log(`mesh-trace-forward: ingest HTTP ${res.status}`)
    return
  }
  log(`mesh-trace-forward: forwarded ${events.length} workflow event(s)`)
}

/**
 * Start the forwarder. Returns a stop() handle. No-op (logs once) when env is
 * not configured. Never throws into the caller — all errors are swallowed +
 * logged so the worker's critical path is unaffected.
 */
export function startMeshTraceForwarder(deps: { pool: Pool; logger?: { info: (m: string) => void; warn?: (m: string) => void } }): { stop: () => void } {
  const log = (m: string) => (deps.logger?.info ? deps.logger.info(m) : console.log(m))
  const cfg = readConfig()
  if (!cfg) {
    log('mesh-trace-forward: disabled (set MESH_TRACE_FORWARD_URL + MESH_TRACE_HMAC_COMPONENT + MESH_TRACE_HMAC_SECRET to enable)')
    return { stop: () => {} }
  }
  log(`mesh-trace-forward: enabled → ${cfg.url} (project=${cfg.projectKey}, every ${cfg.intervalMs}ms)`)
  const timer = setInterval(() => {
    forwardOnce(deps.pool, cfg, log).catch((err) => log(`mesh-trace-forward: tick error: ${err?.message ?? err}`))
  }, cfg.intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return { stop: () => clearInterval(timer) }
}
