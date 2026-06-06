import type http from 'node:http'
import type { Pool } from 'pg'
import type { AppTier } from '@sitelayer/config'
import { createLogger } from '@sitelayer/logger'
// Importing the workflows index pulls in every reducer module's top-level
// registerWorkflow() side effect, so getWorkflow(name) inside applyEventLog
// resolves the registered definition even if no other route touched it first.
import {
  applyEventLog,
  getWorkflow,
  matchesWorkflowEventRef,
  parseWorkflowEventRef,
  type WorkflowEventLogEntry,
} from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'
import { authorizeDebugTraceRequest } from '../debug-trace.js'
import { withCompanyClient } from '../mutation-tx.js'

const logger = createLogger('api:anchors')

/**
 * Statechart-anchor lookup surface — step 5 of the follow-ons.
 *
 *   GET /api/anchors/:eventRef            (single anchor)
 *   GET /api/anchors/:eventRef?to=<ref>   (from/to anchor pair → clip/still range)
 *
 * Given the one-string transition anchor a frontend trace + the server
 * forwarder both stamp (`workflow_event:<name>:<digest>:<version>`), resolve:
 *   - the workflow_event_log row(s) that transition produced,
 *   - the linked capture_session + its durable artifacts,
 *   - the recorder timeline mark(s) (capture_session_events with the event_ref
 *     in payload — written by the frontend on each commit, step 3),
 *   - the sentry_trace stamped on the event-log row, and
 *   - the deterministic replay.ts result over the entity's full event bracket
 *     (applyEventLog re-runs the reducer and reports the first divergence).
 *
 * With a `to` anchor on the SAME workflow+entity, also resolve the audio/screen
 * artifact SUB-RANGE between the two recorder marks (a clip) — or, when from ==
 * to, a single mark frame (a still). This is a read-only RANGE-SELECTION wrapper
 * over the existing capture artifacts + rrweb replay player, NOT a new capture
 * pipeline.
 *
 * Auth: this is the incident-tracking surface, so it is gated like
 * /api/debug/traces/:id — Bearer DEBUG_TRACE_TOKEN, prod-gated unless
 * DEBUG_ALLOW_PROD=1. It also runs after the standard active-company resolution
 * and reads strictly company-scoped via withCompanyClient.
 */

export type AnchorRouteCtx = {
  pool: Pool
  company: ActiveCompany
  tier: AppTier
  requestId: string
  req: http.IncomingMessage
  url: URL
  sendJson: (status: number, body: unknown) => void
  setHeader: (name: string, value: string) => void
}

const WORKFLOW_EVENT_LOG_BRACKET_LIMIT = 500
const CAPTURE_ARTIFACT_LIMIT = 100

type EventLogRow = {
  id: string
  workflow_name: string
  schema_version: number
  entity_type: string
  entity_id: string
  state_version: number
  event_type: string
  event_payload: { type: string; [k: string]: unknown }
  snapshot_after: { state: string; state_version: number; [k: string]: unknown }
  actor_user_id: string | null
  applied_at: string
  request_id: string | null
  sentry_trace: string | null
  sentry_baggage: string | null
  capture_session_id: string | null
}

type CaptureSessionRow = {
  id: string
  mode: string
  status: string
  route_path: string | null
  started_at: string
  last_seen_at: string
  stopped_at: string | null
}

type CaptureArtifactRow = {
  id: string
  kind: string
  content_type: string | null
  byte_size: string | null
  duration_ms: number | null
  pii_level: string | null
  access_policy: string | null
  created_at: string
}

type CaptureMarkRow = {
  id: string
  capture_session_id: string
  event_type: string
  occurred_at: string
  route_path: string | null
}

/**
 * Resolve the workflow_event_log row a single anchor names. The digest is a
 * one-way hash over the entity_id, so we can't reverse it; instead we select
 * the candidate rows by (workflow_name, state_version) and confirm each one by
 * recomputing the anchor (matchesWorkflowEventRef). state_version on the row is
 * the PRE-transition version the event was dispatched against, which is exactly
 * the value the anchor encodes.
 */
async function resolveAnchorRow(
  companyId: string,
  ref: string,
  parsed: { workflow_name: string; state_version: number },
): Promise<EventLogRow | null> {
  const result = await withCompanyClient(companyId, (c) =>
    c.query<EventLogRow>(
      `select id, workflow_name, schema_version, entity_type, entity_id::text as entity_id,
              state_version, event_type, event_payload, snapshot_after,
              actor_user_id, applied_at, request_id, sentry_trace, sentry_baggage,
              capture_session_id::text as capture_session_id
         from workflow_event_log
        where company_id = $1
          and workflow_name = $2
          and state_version = $3
        order by applied_at asc`,
      [companyId, parsed.workflow_name, parsed.state_version],
    ),
  )
  return (
    result.rows.find((row) =>
      matchesWorkflowEventRef(ref, {
        workflow_name: row.workflow_name,
        entity_id: row.entity_id,
        state_version: row.state_version,
      }),
    ) ?? null
  )
}

/** The full ordered event bracket for an entity, used by the replay re-run. */
async function loadEntityBracket(
  companyId: string,
  workflowName: string,
  entityType: string,
  entityId: string,
): Promise<EventLogRow[]> {
  const result = await withCompanyClient(companyId, (c) =>
    c.query<EventLogRow>(
      `select id, workflow_name, schema_version, entity_type, entity_id::text as entity_id,
              state_version, event_type, event_payload, snapshot_after,
              actor_user_id, applied_at, request_id, sentry_trace, sentry_baggage,
              capture_session_id::text as capture_session_id
         from workflow_event_log
        where company_id = $1
          and workflow_name = $2
          and entity_type = $3
          and entity_id = $4::uuid
        order by state_version asc
        limit $5`,
      [companyId, workflowName, entityType, entityId, WORKFLOW_EVENT_LOG_BRACKET_LIMIT],
    ),
  )
  return result.rows
}

/** Re-run the deterministic reducer over the entity bracket and report the
 * first divergence (replay.ts applyEventLog). Returns null when the workflow
 * isn't registered in this process (so callers can surface that distinctly). */
function replayBracket(rows: EventLogRow[]): ReturnType<typeof applyEventLog> | { unregistered: true } {
  if (rows.length === 0) {
    return { ok: true, finalSnapshot: null, issues: [] }
  }
  const definition = getWorkflow(rows[0]!.workflow_name)
  if (!definition) return { unregistered: true }
  const initial = { state: definition.initialState, state_version: rows[0]!.state_version }
  const log: WorkflowEventLogEntry[] = rows.map((row) => ({
    workflow_name: row.workflow_name,
    schema_version: row.schema_version,
    entity_id: row.entity_id,
    state_version: row.state_version,
    event_payload: row.event_payload,
    snapshot_after: row.snapshot_after,
  }))
  return applyEventLog(initial, log)
}

async function loadCaptureSession(companyId: string, captureSessionId: string): Promise<CaptureSessionRow | null> {
  const result = await withCompanyClient(companyId, (c) =>
    c.query<CaptureSessionRow>(
      `select id::text as id, mode, status, route_path,
              started_at, last_seen_at, stopped_at
         from capture_sessions
        where company_id = $1 and id = $2::uuid
        limit 1`,
      [companyId, captureSessionId],
    ),
  )
  return result.rows[0] ?? null
}

async function loadCaptureArtifacts(companyId: string, captureSessionId: string): Promise<CaptureArtifactRow[]> {
  const result = await withCompanyClient(companyId, (c) =>
    c.query<CaptureArtifactRow>(
      `select id::text as id, kind, content_type, byte_size::text as byte_size,
              duration_ms, pii_level, access_policy, created_at
         from capture_artifacts
        where company_id = $1
          and capture_session_id = $2::uuid
          and deleted_at is null
        order by created_at asc
        limit $3`,
      [companyId, captureSessionId, CAPTURE_ARTIFACT_LIMIT],
    ),
  )
  return result.rows
}

/** The recorder timeline mark(s) the frontend stamped for this anchor (step 3),
 * matched by the event_ref carried in the capture_session_event payload. */
async function loadAnchorMarks(companyId: string, ref: string): Promise<CaptureMarkRow[]> {
  const result = await withCompanyClient(companyId, (c) =>
    c.query<CaptureMarkRow>(
      `select id::text as id, capture_session_id::text as capture_session_id,
              event_type, occurred_at, route_path
         from capture_session_events
        where company_id = $1
          and payload->>'event_ref' = $2
        order by occurred_at asc`,
      [companyId, ref],
    ),
  )
  return result.rows
}

type ResolvedAnchor = {
  event_ref: string
  workflow_name: string
  schema_version: number
  entity_type: string
  entity_id: string
  state_version: number
  event_type: string
  from_state: string | null
  to_state: string
  to_state_version: number
  actor_user_id: string | null
  applied_at: string
  request_id: string | null
  sentry_trace: string | null
  capture_session_id: string | null
  marks: Array<{
    id: string
    capture_session_id: string
    event_type: string
    occurred_at: string
    route_path: string | null
  }>
}

async function resolveAnchor(
  companyId: string,
  ref: string,
): Promise<
  | { ok: false; status: number; error: string }
  | {
      ok: true
      anchor: ResolvedAnchor
      row: EventLogRow
      capture: { session: CaptureSessionRow; artifacts: CaptureArtifactRow[]; session_id: string } | null
    }
> {
  const parsed = parseWorkflowEventRef(ref)
  if (!parsed) return { ok: false, status: 400, error: 'event_ref is not a workflow_event anchor' }

  const row = await resolveAnchorRow(companyId, ref, parsed)
  if (!row) return { ok: false, status: 404, error: 'no workflow_event_log row matches this anchor' }

  const marks = await loadAnchorMarks(companyId, ref)

  // Prefer the session the event-log row was stamped against; fall back to the
  // session a recorder mark referenced (the frontend mark carries it).
  const captureSessionId = row.capture_session_id ?? marks[0]?.capture_session_id ?? null
  let capture: { session: CaptureSessionRow; artifacts: CaptureArtifactRow[]; session_id: string } | null = null
  if (captureSessionId) {
    const session = await loadCaptureSession(companyId, captureSessionId)
    if (session) {
      const artifacts = await loadCaptureArtifacts(companyId, captureSessionId)
      capture = { session, artifacts, session_id: captureSessionId }
    }
  }

  const anchor: ResolvedAnchor = {
    event_ref: ref,
    workflow_name: row.workflow_name,
    schema_version: row.schema_version,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    state_version: row.state_version,
    event_type: row.event_type,
    from_state: typeof row.event_payload?.from_state === 'string' ? row.event_payload.from_state : null,
    to_state: String(row.snapshot_after?.state ?? ''),
    to_state_version: Number(row.snapshot_after?.state_version ?? row.state_version + 1),
    actor_user_id: row.actor_user_id,
    applied_at: row.applied_at,
    request_id: row.request_id,
    sentry_trace: row.sentry_trace,
    capture_session_id: captureSessionId,
    marks: marks.map((m) => ({
      id: m.id,
      capture_session_id: m.capture_session_id,
      event_type: m.event_type,
      occurred_at: m.occurred_at,
      route_path: m.route_path,
    })),
  }
  return { ok: true, anchor, row, capture }
}

function captureSessionView(
  capture: { session: CaptureSessionRow; artifacts: CaptureArtifactRow[]; session_id: string } | null,
) {
  if (!capture) return null
  return {
    id: capture.session.id,
    mode: capture.session.mode,
    status: capture.session.status,
    route_path: capture.session.route_path,
    started_at: capture.session.started_at,
    last_seen_at: capture.session.last_seen_at,
    stopped_at: capture.session.stopped_at,
    artifacts: capture.artifacts.map((row) => ({
      id: row.id,
      kind: row.kind,
      content_type: row.content_type,
      byte_size: row.byte_size,
      duration_ms: row.duration_ms,
      pii_level: row.pii_level,
      access_policy: row.access_policy,
      created_at: row.created_at,
      // The authed file route the existing rrweb replay player + media panel use.
      file_url: `/api/capture-sessions/${capture.session_id}/artifacts/${row.id}/file`,
    })),
  }
}

function replayView(rows: EventLogRow[]) {
  const result = replayBracket(rows)
  if ('unregistered' in result) {
    return { available: false, reason: 'workflow_not_registered', ok: null, first_divergence: null }
  }
  return {
    available: true,
    ok: result.ok,
    entries_replayed: rows.length,
    first_divergence: result.issues[0] ?? null,
    issues: result.issues,
  }
}

/**
 * Compute the clip/still artifact sub-range between two marks on the same
 * workflow+entity. Read-only range selection: it returns the occurred_at window
 * and the media artifacts that fall on the recorded session(s), leaving the
 * actual frame extraction to the existing rrweb replay player which already
 * seeks by timestamp.
 */
function buildRange(
  from: ResolvedAnchor,
  to: ResolvedAnchor,
  fromCapture: ReturnType<typeof captureSessionView>,
  toCapture: ReturnType<typeof captureSessionView>,
) {
  const fromMark = from.marks[0] ?? null
  const toMark = to.marks[0] ?? null
  const fromAt = fromMark?.occurred_at ?? from.applied_at
  const toAt = toMark?.occurred_at ?? to.applied_at
  const fromMs = Date.parse(fromAt)
  const toMs = Date.parse(toAt)
  const ordered = Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs <= toMs
  const startAt = ordered ? fromAt : toAt
  const endAt = ordered ? toAt : fromAt
  const isStill = from.event_ref === to.event_ref
  const sameSession = from.capture_session_id !== null && from.capture_session_id === to.capture_session_id
  // Media artifacts (audio / screen video / rrweb) the range plays over. Use the
  // from-anchor's session when both marks share it, else surface both.
  const mediaKinds = new Set(['audio', 'video', 'rrweb', 'repro_bracket'])
  const sessionForMedia = sameSession ? fromCapture : (fromCapture ?? toCapture)
  const media = (sessionForMedia?.artifacts ?? []).filter((a) => mediaKinds.has(a.kind))
  return {
    kind: isStill ? 'still' : 'clip',
    same_session: sameSession,
    duration_ms: ordered ? Math.max(0, toMs - fromMs) : null,
    start_at: startAt,
    end_at: endAt,
    from: { event_ref: from.event_ref, occurred_at: fromAt, has_mark: Boolean(fromMark) },
    to: { event_ref: to.event_ref, occurred_at: toAt, has_mark: Boolean(toMark) },
    capture_session_id: sameSession ? from.capture_session_id : null,
    media_artifacts: media,
  }
}

function anchorIdFromPath(pathname: string): string | null {
  const prefix = '/api/anchors/'
  if (!pathname.startsWith(prefix)) return null
  const raw = pathname.slice(prefix.length)
  if (!raw || raw.includes('/')) return null
  return decodeURIComponent(raw)
}

export async function handleAnchorRoutes(ctx: AnchorRouteCtx): Promise<boolean> {
  const { req, url, requestId, sendJson, pool, company, tier } = ctx
  if (req.method !== 'GET' || !url.pathname.startsWith('/api/anchors/')) {
    return false
  }

  // Incident-tracking surface — gated exactly like /api/debug/traces/:id.
  const authResult = authorizeDebugTraceRequest({
    debugToken: process.env.DEBUG_TRACE_TOKEN,
    tier,
    allowProd: process.env.DEBUG_ALLOW_PROD,
    authorizationHeader: req.headers['authorization'],
    requestId,
  })
  if (!authResult.ok) {
    if (authResult.authenticate) {
      ctx.setHeader('www-authenticate', 'Bearer realm="sitelayer-debug"')
    }
    sendJson(authResult.status, authResult.body)
    return true
  }

  const fromRef = anchorIdFromPath(url.pathname)
  if (!fromRef) {
    sendJson(400, { error: 'invalid anchor', request_id: requestId })
    return true
  }
  const toRefRaw = url.searchParams.get('to')
  const toRef = toRefRaw ? toRefRaw.trim() : null

  logger.info({ scope: 'anchor_lookup', from: fromRef, to: toRef }, 'anchor lookup')

  try {
    const fromResolved = await resolveAnchor(company.id, fromRef)
    if (!fromResolved.ok) {
      sendJson(fromResolved.status, { error: fromResolved.error, request_id: requestId })
      return true
    }

    const fromBracket = await loadEntityBracket(
      company.id,
      fromResolved.row.workflow_name,
      fromResolved.row.entity_type,
      fromResolved.row.entity_id,
    )

    // Single-anchor lookup.
    if (!toRef) {
      sendJson(200, {
        request_id: requestId,
        anchor: fromResolved.anchor,
        capture_session: captureSessionView(fromResolved.capture),
        replay: replayView(fromBracket),
      })
      return true
    }

    // From/to pair → resolve the second anchor and the clip/still range.
    const toResolved = await resolveAnchor(company.id, toRef)
    if (!toResolved.ok) {
      sendJson(toResolved.status, { error: `to: ${toResolved.error}`, request_id: requestId })
      return true
    }

    const sameStream =
      fromResolved.row.workflow_name === toResolved.row.workflow_name &&
      fromResolved.row.entity_type === toResolved.row.entity_type &&
      fromResolved.row.entity_id === toResolved.row.entity_id
    if (!sameStream) {
      sendJson(409, {
        error: 'from and to anchors must be on the same workflow + entity',
        request_id: requestId,
      })
      return true
    }

    const fromCaptureView = captureSessionView(fromResolved.capture)
    const toCaptureView = captureSessionView(toResolved.capture)
    sendJson(200, {
      request_id: requestId,
      from: fromResolved.anchor,
      to: toResolved.anchor,
      from_capture_session: fromCaptureView,
      to_capture_session: toCaptureView,
      range: buildRange(fromResolved.anchor, toResolved.anchor, fromCaptureView, toCaptureView),
      replay: replayView(fromBracket),
    })
    return true
  } catch (err) {
    logger.error({ err, scope: 'anchor_lookup' }, 'anchor lookup failed')
    const message = err instanceof Error ? err.message : 'anchor lookup failed'
    if (/invalid input syntax for type uuid/i.test(message)) {
      sendJson(400, { error: 'anchor entity is not a uuid', request_id: requestId })
      return true
    }
    sendJson(500, { error: message, request_id: requestId })
    return true
  }
}
