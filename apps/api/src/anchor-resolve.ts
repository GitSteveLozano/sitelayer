import {
  applyEventLog,
  getWorkflow,
  matchesWorkflowEventRef,
  parseWorkflowEventRef,
  type ReplayResult,
  type WorkflowEventLogEntry,
} from '@sitelayer/workflows'
import type { LedgerExecutor } from './mutation-tx.js'

/** A single replayed snapshot shape — the loosest bound applyEventLog needs. */
type ReplaySnapshot = { state: string; state_version: number }
/** One per-step divergence the deterministic replay surfaces. */
export type ReplayIssue = ReplayResult<ReplaySnapshot>['issues'][number]

/**
 * Statechart-anchor resolution helpers — extracted from routes/anchors.ts so
 * BOTH the GET /api/anchors/:eventRef surface AND the in-process capture-session
 * finalize path can resolve a one-string transition anchor + re-run the
 * deterministic replay without going back over the network.
 *
 * Every helper here takes a plain `{ query }` executor + `companyId` instead of
 * opening its own `withCompanyClient` tx. That keeps anchors.ts behaviour
 * identical (it passes a `withCompanyClient` client) while letting finalize pass
 * the SAME PoolClient that the surrounding `withMutationTx` already bound to
 * `app.company_id`, so the anchor reads run inside that mutation tx.
 *
 * The anchor string is `workflow_event:<name>:<digest16>:<state_version>`.
 * The digest is a one-way SHA-256 over `<name>:<entity_id>:<state_version>`, so
 * we can't reverse it — we select candidate rows by (workflow_name,
 * state_version) and confirm each with matchesWorkflowEventRef.
 */

const WORKFLOW_EVENT_LOG_BRACKET_LIMIT = 500
const CAPTURE_ARTIFACT_LIMIT = 100

export type EventLogRow = {
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

export type CaptureSessionRow = {
  id: string
  mode: string
  status: string
  route_path: string | null
  started_at: string
  last_seen_at: string
  stopped_at: string | null
}

export type CaptureArtifactRow = {
  id: string
  kind: string
  content_type: string | null
  byte_size: string | null
  duration_ms: number | null
  pii_level: string | null
  access_policy: string | null
  created_at: string
}

export type CaptureMarkRow = {
  id: string
  capture_session_id: string
  event_type: string
  occurred_at: string
  route_path: string | null
}

export type ResolvedAnchor = {
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

export type ResolvedAnchorCapture = {
  session: CaptureSessionRow
  artifacts: CaptureArtifactRow[]
  session_id: string
}

export type ResolveAnchorResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true
      anchor: ResolvedAnchor
      row: EventLogRow
      capture: ResolvedAnchorCapture | null
    }

/**
 * Resolve the workflow_event_log row a single anchor names. The digest is a
 * one-way hash over the entity_id, so we can't reverse it; instead we select
 * the candidate rows by (workflow_name, state_version) and confirm each one by
 * recomputing the anchor (matchesWorkflowEventRef). state_version on the row is
 * the PRE-transition version the event was dispatched against, which is exactly
 * the value the anchor encodes.
 */
export async function resolveAnchorRow(
  client: LedgerExecutor,
  companyId: string,
  ref: string,
  parsed: { workflow_name: string; state_version: number },
): Promise<EventLogRow | null> {
  const result = await client.query<EventLogRow>(
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
export async function loadEntityBracket(
  client: LedgerExecutor,
  companyId: string,
  workflowName: string,
  entityType: string,
  entityId: string,
): Promise<EventLogRow[]> {
  const result = await client.query<EventLogRow>(
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
  )
  return result.rows
}

/** Re-run the deterministic reducer over the entity bracket and report the
 * first divergence (replay.ts applyEventLog). Returns null when the workflow
 * isn't registered in this process (so callers can surface that distinctly). */
export function replayBracket(rows: EventLogRow[]): ReplayResult<ReplaySnapshot> | { unregistered: true } {
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

async function loadCaptureSession(
  client: LedgerExecutor,
  companyId: string,
  captureSessionId: string,
): Promise<CaptureSessionRow | null> {
  const result = await client.query<CaptureSessionRow>(
    `select id::text as id, mode, status, route_path,
            started_at, last_seen_at, stopped_at
       from capture_sessions
      where company_id = $1 and id = $2::uuid
      limit 1`,
    [companyId, captureSessionId],
  )
  return result.rows[0] ?? null
}

async function loadCaptureArtifacts(
  client: LedgerExecutor,
  companyId: string,
  captureSessionId: string,
): Promise<CaptureArtifactRow[]> {
  const result = await client.query<CaptureArtifactRow>(
    `select id::text as id, kind, content_type, byte_size::text as byte_size,
            duration_ms, pii_level, access_policy, created_at
       from capture_artifacts
      where company_id = $1
        and capture_session_id = $2::uuid
        and deleted_at is null
      order by created_at asc
      limit $3`,
    [companyId, captureSessionId, CAPTURE_ARTIFACT_LIMIT],
  )
  return result.rows
}

/** The recorder timeline mark(s) the frontend stamped for this anchor (step 3),
 * matched by the event_ref carried in the capture_session_event payload. */
async function loadAnchorMarks(client: LedgerExecutor, companyId: string, ref: string): Promise<CaptureMarkRow[]> {
  const result = await client.query<CaptureMarkRow>(
    `select id::text as id, capture_session_id::text as capture_session_id,
            event_type, occurred_at, route_path
       from capture_session_events
      where company_id = $1
        and payload->>'event_ref' = $2
      order by occurred_at asc`,
    [companyId, ref],
  )
  return result.rows
}

export async function resolveAnchor(
  client: LedgerExecutor,
  companyId: string,
  ref: string,
): Promise<ResolveAnchorResult> {
  const parsed = parseWorkflowEventRef(ref)
  if (!parsed) return { ok: false, status: 400, error: 'event_ref is not a workflow_event anchor' }

  const row = await resolveAnchorRow(client, companyId, ref, parsed)
  if (!row) return { ok: false, status: 404, error: 'no workflow_event_log row matches this anchor' }

  const marks = await loadAnchorMarks(client, companyId, ref)

  // Prefer the session the event-log row was stamped against; fall back to the
  // session a recorder mark referenced (the frontend mark carries it).
  const captureSessionId = row.capture_session_id ?? marks[0]?.capture_session_id ?? null
  let capture: ResolvedAnchorCapture | null = null
  if (captureSessionId) {
    const session = await loadCaptureSession(client, companyId, captureSessionId)
    if (session) {
      const artifacts = await loadCaptureArtifacts(client, companyId, captureSessionId)
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

export type ReplayView =
  | { available: false; reason: string; ok: null; first_divergence: null }
  | {
      available: true
      ok: boolean
      entries_replayed: number
      first_divergence: ReplayIssue | null
      issues: ReplayIssue[]
    }

export function replayView(rows: EventLogRow[]): ReplayView {
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

/** The default cap on how many recent transition marks finalize anchors. */
const CAPTURE_SESSION_ANCHOR_LIMIT = 10

/**
 * The compact per-anchor summary persisted into a support packet's
 * `server_context.anchors`. It pins the exact broken/most-recent statechart
 * transition plus the deterministic replay's first divergence so the LLM
 * agent_prompt reads the precise transition that broke.
 */
export type CaptureSessionAnchor = {
  event_ref: string
  workflow_name: string
  entity_type: string
  entity_id: string
  state_version: number
  event_type: string
  from_state: string | null
  to_state: string
  applied_at: string
  sentry_trace: string | null
  /** The deterministic replay over the entity's full bracket. */
  replay_ok: boolean | null
  replay_available: boolean
  /** First per-step divergence the replay surfaced, if any. */
  first_divergence: ReplayIssue | null
}

/**
 * In-process anchor + replay weave for a finalized capture session.
 *
 * Reads the recent `workflow.transition` recorder marks the frontend stamped on
 * this capture session (their `payload->>'event_ref'` is the transition anchor),
 * caps at the most recent N, resolves each through the same statechart-anchor
 * logic the GET /api/anchors surface uses, and re-runs the deterministic replay
 * over the entity bracket — all on the SAME tx client the surrounding
 * withMutationTx already bound to `app.company_id`. No network, no new tables.
 *
 * Defensive by construction: a transition whose anchor doesn't resolve (404,
 * not-an-anchor, malformed) is simply skipped, never thrown. Finalize must not
 * break because a single anchor couldn't be pinned.
 */
export async function buildCaptureSessionAnchors(
  client: LedgerExecutor,
  companyId: string,
  captureSessionId: string,
  limit = CAPTURE_SESSION_ANCHOR_LIMIT,
): Promise<CaptureSessionAnchor[]> {
  // The workflow transition marks carry the anchor in payload.event_ref. Pull
  // the most-recent distinct refs for this capture session (event_type is the
  // 'workflow.transition' mark the headless-workflow machine stamps).
  const marks = await client.query<{ event_ref: string }>(
    `select distinct on (payload->>'event_ref') payload->>'event_ref' as event_ref
       from capture_session_events
      where company_id = $1
        and capture_session_id = $2::uuid
        and event_type = 'workflow.transition'
        and payload->>'event_ref' is not null
      order by payload->>'event_ref', occurred_at desc, received_at desc`,
    [companyId, captureSessionId],
  )
  // distinct on returns one row per ref; re-order by recency via a second query
  // would be one more round trip — instead bound the candidate set then sort by
  // the resolved applied_at below. Cap the candidate refs first so a noisy
  // session can't fan out unbounded resolves.
  const refs = marks.rows
    .map((row) => row.event_ref)
    .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)

  const anchors: CaptureSessionAnchor[] = []
  for (const ref of refs) {
    try {
      const resolved = await resolveAnchor(client, companyId, ref)
      if (!resolved.ok) continue
      const bracket = await loadEntityBracket(
        client,
        companyId,
        resolved.row.workflow_name,
        resolved.row.entity_type,
        resolved.row.entity_id,
      )
      const replay = replayView(bracket)
      anchors.push({
        event_ref: resolved.anchor.event_ref,
        workflow_name: resolved.anchor.workflow_name,
        entity_type: resolved.anchor.entity_type,
        entity_id: resolved.anchor.entity_id,
        state_version: resolved.anchor.state_version,
        event_type: resolved.anchor.event_type,
        from_state: resolved.anchor.from_state,
        to_state: resolved.anchor.to_state,
        applied_at: resolved.anchor.applied_at,
        sentry_trace: resolved.anchor.sentry_trace,
        replay_ok: replay.available ? replay.ok : null,
        replay_available: replay.available,
        first_divergence: replay.available ? replay.first_divergence : null,
      })
    } catch {
      // A single anchor that fails to resolve must never break finalize.
    }
  }
  // Most-recent transition first, and never persist more than the cap.
  anchors.sort((a, b) => Date.parse(b.applied_at) - Date.parse(a.applied_at))
  return anchors.slice(0, limit)
}
