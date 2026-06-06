import type { LedgerExecutor } from './mutation-tx.js'

/**
 * Incident timeline correlation — the "events leading up to the issue" the
 * incident bundle (scripts/incident.ts) and the capture-session finalize path
 * both want: a single chronological, source-tagged merge of the audit /
 * mutation-outbox / sync-events / capture-session / work-item rows in a time
 * window, with the error rows flagged and the candidate request_ids / trace_ids
 * surfaced.
 *
 * Extracted here so the in-process finalize path can weave the timeline into
 * `server_context.timeline` WITHOUT going back over the network: every helper
 * takes a plain `{ query }` executor + `companyId`, so finalize can pass the
 * SAME PoolClient the surrounding `withMutationTx` already bound to
 * `app.company_id` and the reads run inside that mutation tx. The CLI passes a
 * raw pg Client instead — same contract.
 *
 * The audit / queue SQL is intentionally the same shape support-packets.ts
 * fetchAuditContext / fetchQueueContext reads (window-bounded here rather than
 * id-bounded); the merge + error flagging is the same one the incident CLI did
 * inline.
 *
 * Pure-ish + defensive by construction: a failing query is skipped (returns no
 * rows), never thrown, so a finalize can't break on one bad table read. No
 * sanitization is done here — the finalize path runs the merged rows back
 * through support-packets' sanitizeSupportJson before persisting.
 */

/** One source-tagged event on the merged timeline. */
export type TimelineEvent = {
  /** ISO timestamp the row carries (created_at / started_at). */
  at: string
  /** Which table the row came from. */
  source: 'audit' | 'mutation_outbox' | 'sync_events' | 'capture' | 'work_item'
  /** A short human-readable one-liner describing the row. */
  line: string
  /** True when the row represents a failure (status='failed' or non-empty error). */
  is_error: boolean
  /** The row's error text, when it is an error row. */
  error?: string
  /** The row's request_id, when present (a candidate to focus on). */
  request_id?: string
  /** The row's short trace_id (the head of sentry_trace), when present. */
  trace_id?: string
}

export type IncidentTimeline = {
  /** The window the timeline was correlated over. */
  window: { since: string; until: string }
  /** All merged rows, chronological (oldest first), capped at `limit`. */
  events: TimelineEvent[]
  /** Just the error rows, chronological — a convenience slice of `events`. */
  errors: TimelineEvent[]
  /** Candidate request_ids seen in the window, ranked by error count. */
  candidate_request_ids: string[]
  /** Candidate (short) trace_ids seen in the window. */
  candidate_trace_ids: string[]
  /** True when any source query failed and was skipped. */
  truncated: boolean
}

export type BuildIncidentTimelineInput = {
  companyId: string
  since: string
  until: string
  /** Optional focus ids — when present, candidate ranking prefers them. */
  requestIds?: string[]
  traceIds?: string[]
  /** Cap on the merged event count persisted/returned (default 200). */
  limit?: number
  /** Per-table row cap (default 1000). */
  perTableLimit?: number
}

const DEFAULT_LIMIT = 200
const DEFAULT_PER_TABLE_LIMIT = 1000

type Row = Record<string, unknown>

const fmt = (value: unknown): string => (value === null || value === undefined ? '' : String(value))

/** The short trace id is the first dash-delimited segment of the sentry_trace. */
function traceOf(sentryTrace: unknown): string | undefined {
  const s = fmt(sentryTrace).trim()
  if (!s) return undefined
  return s.split('-')[0] || undefined
}

function isErrorRow(row: Row): boolean {
  return row.status === 'failed' || Boolean(fmt(row.error))
}

/**
 * One window-bounded read that never throws the whole timeline: a failing query
 * is skipped (the bundle is more useful partial than empty). Returns the rows
 * plus whether it failed so the caller can flag the timeline truncated.
 */
async function safeQuery(
  client: LedgerExecutor,
  sql: string,
  params: unknown[],
): Promise<{ rows: Row[]; failed: boolean }> {
  try {
    const result = await client.query<Row>(sql, params)
    return { rows: result.rows, failed: false }
  } catch {
    return { rows: [], failed: true }
  }
}

/**
 * Build the merged chronological incident timeline for a company over a window.
 *
 * Reads audit_events + mutation_outbox + sync_events + capture_sessions +
 * context_work_items in [since, until], tags each row by source, flags the
 * error rows, and surfaces the candidate request/trace ids — all on the passed
 * executor (a tx PoolClient from finalize, or a raw Client from the CLI).
 */
export async function buildIncidentTimeline(
  client: LedgerExecutor,
  input: BuildIncidentTimelineInput,
): Promise<IncidentTimeline> {
  const { companyId, since, until } = input
  const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT)
  const perTableLimit = Math.max(1, input.perTableLimit ?? DEFAULT_PER_TABLE_LIMIT)

  const events: TimelineEvent[] = []
  let truncated = false
  // request_id -> error count seen in window (ranking key for candidates).
  const requestErrorCounts = new Map<string, number>()
  const traceIds = new Set<string>()

  const noteCandidates = (row: Row, isErr: boolean): void => {
    const requestId = fmt(row.request_id).trim()
    if (requestId) {
      requestErrorCounts.set(requestId, (requestErrorCounts.get(requestId) ?? 0) + (isErr ? 1 : 0))
    }
    const trace = traceOf(row.sentry_trace)
    if (trace) traceIds.add(trace)
  }

  const pushEvent = (event: TimelineEvent): void => {
    events.push(event)
  }

  // 1) audit_events — the human/system action trail.
  const audit = await safeQuery(
    client,
    `select created_at, action, entity_type, entity_id, actor_user_id, request_id, sentry_trace
       from audit_events
      where company_id = $1 and created_at between $2 and $3
      order by created_at asc
      limit $4`,
    [companyId, since, until, perTableLimit],
  )
  truncated = truncated || audit.failed
  for (const row of audit.rows) {
    noteCandidates(row, false)
    const event: TimelineEvent = {
      at: fmt(row.created_at),
      source: 'audit',
      line: `${fmt(row.action)} ${fmt(row.entity_type)} ${fmt(row.entity_id)} by ${fmt(row.actor_user_id)}`.trim(),
      is_error: false,
    }
    const requestId = fmt(row.request_id).trim()
    if (requestId) event.request_id = requestId
    const trace = traceOf(row.sentry_trace)
    if (trace) event.trace_id = trace
    pushEvent(event)
  }

  // 2) the two leased queue tables — these carry the error rows.
  for (const table of ['mutation_outbox', 'sync_events'] as const) {
    const kindCol = table === 'mutation_outbox' ? 'mutation_type' : 'direction'
    const queue = await safeQuery(
      client,
      `select created_at, status, entity_type, entity_id, ${kindCol} as kind, error, request_id, sentry_trace
         from ${table}
        where company_id = $1 and created_at between $2 and $3
        order by created_at asc
        limit $4`,
      [companyId, since, until, perTableLimit],
    )
    truncated = truncated || queue.failed
    for (const row of queue.rows) {
      const isErr = isErrorRow(row)
      noteCandidates(row, isErr)
      const event: TimelineEvent = {
        at: fmt(row.created_at),
        source: table,
        line: `${fmt(row.kind)} ${fmt(row.entity_type)} ${fmt(row.entity_id)} ${fmt(row.status)}`.trim(),
        is_error: isErr,
      }
      if (isErr) event.error = fmt(row.error) || '(status failed)'
      const requestId = fmt(row.request_id).trim()
      if (requestId) event.request_id = requestId
      const trace = traceOf(row.sentry_trace)
      if (trace) event.trace_id = trace
      pushEvent(event)
    }
  }

  // 3) capture sessions in the window — the route/session context.
  const captures = await safeQuery(
    client,
    `select started_at, route_path, mode, status, app_build_sha
       from capture_sessions
      where company_id = $1 and started_at between $2 and $3
      order by started_at asc
      limit $4`,
    [companyId, since, until, perTableLimit],
  )
  truncated = truncated || captures.failed
  for (const row of captures.rows) {
    pushEvent({
      at: fmt(row.started_at),
      source: 'capture',
      line: `session ${fmt(row.mode)} on ${fmt(row.route_path)} (${fmt(row.status)}, build ${fmt(row.app_build_sha)})`,
      is_error: false,
    })
  }

  // 4) context work items in the window — filed issues bracketing the incident.
  const workItems = await safeQuery(
    client,
    `select created_at, route, title, status, lane, severity, entity_type, entity_id
       from context_work_items
      where company_id = $1 and created_at between $2 and $3
      order by created_at asc
      limit $4`,
    [companyId, since, until, perTableLimit],
  )
  truncated = truncated || workItems.failed
  for (const row of workItems.rows) {
    pushEvent({
      at: fmt(row.created_at),
      source: 'work_item',
      line: `[${fmt(row.severity)}/${fmt(row.lane)}] "${fmt(row.title)}" on ${fmt(row.route)} (${fmt(row.status)})`,
      is_error: false,
    })
  }

  // Merge: chronological, oldest first (the "leading up to it" order).
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const capped = events.slice(0, limit)

  // Candidate request_ids, ranked by error count (the focus list incident.ts
  // surfaces). Prefer the explicit focus ids the caller passed.
  const focusRequestIds = new Set((input.requestIds ?? []).filter((id) => typeof id === 'string' && id.length > 0))
  const candidateRequestIds = [...requestErrorCounts.entries()]
    .sort((a, b) => {
      const aFocus = focusRequestIds.has(a[0]) ? 1 : 0
      const bFocus = focusRequestIds.has(b[0]) ? 1 : 0
      if (aFocus !== bFocus) return bFocus - aFocus
      return b[1] - a[1]
    })
    .map(([id]) => id)
    .slice(0, 25)

  for (const id of input.traceIds ?? []) {
    if (typeof id === 'string' && id.length > 0) traceIds.add(id)
  }

  return {
    window: { since, until },
    events: capped,
    errors: capped.filter((event) => event.is_error),
    candidate_request_ids: candidateRequestIds,
    candidate_trace_ids: [...traceIds].slice(0, 25),
    truncated,
  }
}
