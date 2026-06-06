import type { QueueClient } from '../index.js'

// Inlined (rather than imported from ../index.js) to keep this module out of the
// index.ts → pusher → index.ts value-import cycle: a runtime import of a value
// defined later in index.ts can resolve as `undefined` under Vite's circular-
// module evaluation. Behaviourally identical to index.ts:markOutboxRowFailedFresh.
async function markOutboxRowFailedFresh(
  client: QueueClient,
  companyId: string,
  outboxId: string,
  errorMessage: string,
  retryDelayMinutes = 15,
): Promise<void> {
  try {
    await client.query('begin')
    await client.query(
      `update mutation_outbox
         set status = 'failed', error = $3, next_attempt_at = now() + ($4 || ' minutes')::interval
       where company_id = $1 and id = $2`,
      [companyId, outboxId, errorMessage.slice(0, 1000), String(retryDelayMinutes)],
    )
    await client.query('commit')
  } catch (markErr) {
    await client.query('rollback').catch(() => {})
    throw markErr
  }
}

// ---------------------------------------------------------------------------
// Async debug-bundle enrichment handler — tier-2 of issue-context.
//
// Tier 0/1 (synchronous, at finalize): the API weaves server_context.anchors
// (statechart transitions) + server_context.timeline (the in-window event
// merge) into the support packet before it returns.
//
// Tier 2 (this, async): the worker pulls the EXTERNAL evidence the API can't
// block a request on — the Sentry trace spans + the Axiom log lines — around
// the trace_ids / request_ids the support packet ALREADY PINNED, and writes the
// merged blob as a `capture_artifact` kind='debug_bundle' on the capture
// session. Mirrors scripts/incident.ts §6/§6b fetches (8s timeout, both blocks
// silently no-op when their env is unset, so a local/dev box still exercises
// the plumbing without external creds).
//
// This is NOT a workflow reducer (no entity state machine to transition) — it
// is a one-shot enrichment side effect: claim → fetch → write artifact → mark
// the outbox row applied. The outbox row IS the at-least-once durability +
// retry primitive; the capture_artifact insert is idempotent on
// (capture_session_id, kind='debug_bundle') so a re-claim after a crash
// upserts rather than duplicating.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 8000
const MAX_TRACE_IDS = 8
const MAX_REQUEST_IDS = 12
const MAX_SENTRY_JSON_CHARS = 6000
const MAX_AXIOM_LINES = 300

export type AssembleDebugBundlePayload = {
  support_packet_id?: string | null
  capture_session_id?: string | null
  trace_ids?: unknown
  request_ids?: unknown
  /** Escalation re-runs (STEP6) pin an explicit event_ref to enrich around. */
  event_ref?: string | null
  /** Escalation tier ('2' | '3'); absent for the at-finalize enrichment. */
  tier?: string | null
}

export type AssembleDebugBundleInput = {
  client: QueueClient
  companyId: string
  /** The mutation_outbox entity_id — the work_item id the bundle enriches. */
  workItemId: string
  payload: Record<string, unknown>
}

export type DebugBundleSummary = {
  processed: number
  assembled: number
  failed: number
  skipped: number
}

type ClaimedDebugBundleRow = {
  id: string
  entity_id: string
  payload: Record<string, unknown>
  attempt_count: number
}

/** A trace_id is the first dash-delimited segment of a W3C sentry-trace. */
function shortTrace(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const head = value.trim().split('-')[0]
  return head && head.length > 0 ? head : null
}

function stringArray(value: unknown, limit: number, normalizeTrace = false): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    // trace_ids: tolerate either a full W3C sentry-trace or an already-short id
    // and normalize to the short head. request_ids are opaque (they legitimately
    // contain dashes, e.g. a UUID) — keep them verbatim.
    const normalized = normalizeTrace && trimmed.includes('-') ? (shortTrace(trimmed) ?? trimmed) : trimmed
    if (!out.includes(normalized)) out.push(normalized)
    if (out.length >= limit) break
  }
  return out
}

export type SentryEnrichment =
  | { status: 'unconfigured' }
  | { status: 'no_trace' }
  | { status: 'ok'; trace_id: string; node_count: number; data: unknown }
  | { status: 'http_error'; trace_id: string; http_status: number }
  | { status: 'error'; trace_id: string; error: string }

/**
 * Pull the Sentry trace spans for the first pinned trace_id. Gated on
 * SENTRY_ORG + SENTRY_AUTH_TOKEN (+ optional SENTRY_HOST) — unset = silent
 * unconfigured (the local/dev case). Mirrors scripts/incident.ts §6.
 */
export async function fetchSentryEnrichment(
  traceIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<SentryEnrichment> {
  const org = process.env.SENTRY_ORG
  const token = process.env.SENTRY_AUTH_TOKEN
  if (!org || !token) return { status: 'unconfigured' }
  const traceId = traceIds[0]
  if (!traceId) return { status: 'no_trace' }
  const host = process.env.SENTRY_HOST || 'sentry.io'
  try {
    const res = await fetchImpl(`https://${host}/api/0/organizations/${org}/events-trace/${traceId}/`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return { status: 'http_error', trace_id: traceId, http_status: res.status }
    const data = (await res.json()) as unknown
    const spans = Array.isArray(data) ? data : ((data as { transactions?: unknown[] })?.transactions ?? [])
    // Bound the persisted blob so a huge trace can't bloat the artifact.
    const serialized = JSON.stringify(data)
    const bounded = serialized.length > MAX_SENTRY_JSON_CHARS ? JSON.parse(serialized.slice(0, 0) || '{}') : data
    return {
      status: 'ok',
      trace_id: traceId,
      node_count: Array.isArray(spans) ? spans.length : 0,
      // Keep the raw data when it fits, else the truncation-safe empty object;
      // node_count still records the real span count.
      data: serialized.length > MAX_SENTRY_JSON_CHARS ? bounded : data,
    }
  } catch (err) {
    return { status: 'error', trace_id: traceId, error: err instanceof Error ? err.message : 'sentry fetch failed' }
  }
}

export type AxiomEnrichment =
  | { status: 'unconfigured' }
  | { status: 'no_ids' }
  | { status: 'ok'; line_count: number; lines: string[] }
  | { status: 'http_error'; http_status: number }
  | { status: 'error'; error: string }

/**
 * Pull the matching Pino log lines from Axiom (the durable warehouse) for the
 * pinned trace_id / request_ids. Gated on AXIOM_TOKEN + AXIOM_DATASET — unset =
 * silent unconfigured. Mirrors scripts/incident.ts §6b.
 */
export async function fetchAxiomEnrichment(
  traceIds: string[],
  requestIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<AxiomEnrichment> {
  const token = process.env.AXIOM_TOKEN
  const dataset = process.env.AXIOM_DATASET
  if (!token || !dataset) return { status: 'unconfigured' }
  const filters: string[] = []
  const traceId = traceIds[0]
  if (traceId) filters.push(`trace_id == "${traceId}"`)
  for (const rid of requestIds.slice(0, 5)) filters.push(`request_id == "${rid}"`)
  if (!filters.length) return { status: 'no_ids' }
  const apl = `['${dataset}'] | where ${filters.join(' or ')} | sort by _time asc | limit ${MAX_AXIOM_LINES}`
  try {
    const res = await fetchImpl('https://api.axiom.co/v1/datasets/_apl?format=tabular', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ apl }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return { status: 'http_error', http_status: res.status }
    const data = (await res.json()) as {
      tables?: Array<{ columns?: unknown[][]; fields?: Array<{ name: string }> }>
    }
    const table = data.tables?.[0]
    const fields = (table?.fields ?? []).map((f) => f.name)
    const cols = table?.columns ?? []
    const rowCount = cols[0]?.length ?? 0
    const timeIdx = fields.indexOf('_time')
    const msgIdx = fields.findIndex((f) => f === 'message' || f === 'msg')
    const levelIdx = fields.indexOf('level')
    const lines: string[] = []
    for (let i = 0; i < Math.min(rowCount, MAX_AXIOM_LINES); i += 1) {
      const t = timeIdx >= 0 ? String(cols[timeIdx]?.[i] ?? '') : ''
      const level = levelIdx >= 0 ? String(cols[levelIdx]?.[i] ?? '') : ''
      const msg = msgIdx >= 0 ? String(cols[msgIdx]?.[i] ?? '') : ''
      lines.push(`${t} ${level} ${msg}`.trim())
    }
    return { status: 'ok', line_count: rowCount, lines }
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : 'axiom fetch failed' }
  }
}

export type DebugBundle = {
  schema: 'sitelayer.debug_bundle.v1'
  assembled_at: string
  support_packet_id: string | null
  capture_session_id: string | null
  event_ref: string | null
  tier: string | null
  trace_ids: string[]
  request_ids: string[]
  sentry: SentryEnrichment
  axiom: AxiomEnrichment
}

/**
 * Assemble the bundle blob from a payload (pure orchestration over the two
 * env-gated fetches). Exported so STEP6 escalate + tests can re-use the exact
 * same enrichment around an already-pinned trace/request set without
 * re-deriving anything.
 */
export async function assembleDebugBundle(
  payload: AssembleDebugBundlePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<DebugBundle> {
  const traceIds = stringArray(payload.trace_ids, MAX_TRACE_IDS, true)
  const requestIds = stringArray(payload.request_ids, MAX_REQUEST_IDS)
  const [sentry, axiom] = await Promise.all([
    fetchSentryEnrichment(traceIds, fetchImpl),
    fetchAxiomEnrichment(traceIds, requestIds, fetchImpl),
  ])
  return {
    schema: 'sitelayer.debug_bundle.v1',
    assembled_at: new Date().toISOString(),
    support_packet_id: typeof payload.support_packet_id === 'string' ? payload.support_packet_id : null,
    capture_session_id: typeof payload.capture_session_id === 'string' ? payload.capture_session_id : null,
    event_ref: typeof payload.event_ref === 'string' ? payload.event_ref : null,
    tier: typeof payload.tier === 'string' ? payload.tier : null,
    trace_ids: traceIds,
    request_ids: requestIds,
    sentry,
    axiom,
  }
}

/**
 * Upsert the assembled bundle as a `capture_artifact` kind='debug_bundle' on
 * the capture session. Idempotent on (company_id, capture_session_id, kind):
 * the partial unique index (migration 010 / runtime) means a re-claim after a
 * crash overwrites the prior bundle blob rather than appending a duplicate. The
 * bundle is internal app-issue evidence — pii_level='internal',
 * access_policy='support_only', uri=null (no stored object; the blob lives in
 * metadata). Returns null when the capture session row is gone.
 */
async function writeDebugBundleArtifact(
  client: QueueClient,
  companyId: string,
  captureSessionId: string,
  bundle: DebugBundle,
): Promise<string | null> {
  const sessionExists = await client.query<{ id: string; retention_expires_at: string | null }>(
    `select id::text as id, retention_expires_at
       from capture_sessions
      where company_id = $1 and id = $2::uuid
      limit 1`,
    [companyId, captureSessionId],
  )
  const session = sessionExists.rows[0]
  if (!session) return null
  const result = await client.query<{ id: string }>(
    `insert into capture_artifacts (
       company_id, capture_session_id, kind, content_type, pii_level,
       access_policy, metadata, retention_expires_at, redaction_version
     ) values (
       $1, $2::uuid, 'debug_bundle', 'application/json', 'internal',
       'support_only', $3::jsonb, $4::timestamptz, 'capture-session-v1'
     )
     on conflict (company_id, capture_session_id) where kind = 'debug_bundle' and deleted_at is null
       do update set metadata = excluded.metadata, content_type = excluded.content_type
     returning id::text as id`,
    [
      companyId,
      captureSessionId,
      JSON.stringify({ bundle, source: 'assemble_debug_bundle' }),
      session.retention_expires_at,
    ],
  )
  return result.rows[0]?.id ?? null
}

export async function processAssembleDebugBundle(
  client: QueueClient,
  companyId: string,
  limit = 5,
  fetchImpl: typeof fetch = fetch,
): Promise<DebugBundleSummary> {
  // Phase 1: claim. Own tx so the 'processing' marker is durable even if every
  // per-row work tx fails. 5-minute lease keeps a row off the claim list until a
  // per-row tx commits a final state OR the lease elapses (watchdog path).
  // Mirrors processRentalInvoicePush.
  await client.query('begin')
  let claimed: { rows: ClaimedDebugBundleRow[]; rowCount: number | null }
  try {
    const result = await client.query<ClaimedDebugBundleRow>(
      `
      update mutation_outbox
      set
        status = 'processing',
        attempt_count = attempt_count + 1,
        next_attempt_at = now() + interval '5 minutes',
        error = null
      where id in (
        select id
        from mutation_outbox
        where company_id = $1
          and entity_type = 'app_issue'
          and mutation_type = 'assemble_debug_bundle'
          and (
            (status = 'pending' and next_attempt_at <= now())
            or (status = 'processing' and next_attempt_at <= now())
          )
        order by next_attempt_at asc, created_at asc
        limit $2
        for update skip locked
      )
      returning id, entity_id, payload, attempt_count
      `,
      [companyId, limit],
    )
    claimed = { rows: result.rows, rowCount: result.rowCount ?? null }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }

  let assembled = 0
  let failed = 0
  let skipped = 0

  // Phase 2: per-row work, each in its own tx.
  for (const row of claimed.rows) {
    await client.query('begin')
    try {
      const payload = (row.payload ?? {}) as AssembleDebugBundlePayload
      const captureSessionId = typeof payload.capture_session_id === 'string' ? payload.capture_session_id.trim() : ''
      if (!captureSessionId) {
        // Nothing to attach the bundle to — mark applied (not a retryable error;
        // a re-claim would never find a session id) and move on.
        await client.query(
          `update mutation_outbox set status = 'applied', applied_at = now(), error = null
           where company_id = $1 and id = $2`,
          [companyId, row.id],
        )
        await client.query('commit')
        skipped += 1
        continue
      }
      const bundle = await assembleDebugBundle(payload, fetchImpl)
      const artifactId = await writeDebugBundleArtifact(client, companyId, captureSessionId, bundle)
      if (!artifactId) {
        // Capture session vanished (discarded/redacted GC). Idempotent skip.
        await client.query(
          `update mutation_outbox set status = 'applied', applied_at = now(), error = null
           where company_id = $1 and id = $2`,
          [companyId, row.id],
        )
        await client.query('commit')
        skipped += 1
        continue
      }
      await client.query(
        `update mutation_outbox set status = 'applied', applied_at = now(), error = null
         where company_id = $1 and id = $2`,
        [companyId, row.id],
      )
      await client.query('commit')
      assembled += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      await client.query('rollback').catch(() => {})
      try {
        await markOutboxRowFailedFresh(client, companyId, row.id, message)
        failed += 1
      } catch (markErr) {
        ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
          '[queue] debug-bundle failed to mark outbox row failed; will be re-claimed after lease',
          { outboxId: row.id, error: markErr },
        )
      }
    }
  }

  return { processed: claimed.rowCount ?? 0, assembled, failed, skipped }
}
