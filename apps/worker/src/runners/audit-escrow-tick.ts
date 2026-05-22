// Audit Escrow tick runner — Wedge 2 of PROVING_GROUND_PLAN.md.
//
// Hourly (configurable via AUDIT_ESCROW_TICK_INTERVAL_MS), per-company:
//   1. Find the last anchored window_end for (company_id, action).
//   2. Select the rows in (window_end, now()] up to AUDIT_ESCROW_BATCH_SIZE.
//   3. Build the redacted payload, append a signed entry to the chain.
//   4. Back-fill escrow_anchor_id on the source rows.
//   5. Best-effort external sealing (DO Spaces Object Lock + OpenTimestamps).
//      Failures here do NOT roll back the chain insert — the local signed
//      chain is the legally-meaningful primitive; external sealing is a
//      cherry-on-top defense-in-depth.
//
// The runner forward-anchors only. Historical backfill is a follow-up.
//
// Lane: `audit_escrow_tick`. The worker wraps the call in `runIfLaneActive`
// so an operator can pause the runner from the admin UI (post-Wedge-5).

import type { Pool, PoolClient } from 'pg'
import type { Logger } from '@sitelayer/logger'
import {
  AUDIT_ESCROW_ALGORITHM,
  appendAuditEscrowEntry as appendEntry,
  sealAuditEscrowEntry as sealEntry,
  type AuditEscrowEntry,
} from '@sitelayer/queue'

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000 // 1h
const DEFAULT_BATCH_SIZE = 10_000

const ACTIONS = {
  AUDIT_EVENTS: 'audit_event_batch',
  CONTEXT_HANDOFF: 'context_handoff_event_batch',
} as const

export interface AuditEscrowTickSummary {
  ran: boolean
  audit_event_entries_created: number
  audit_events_anchored: number
  context_handoff_entries_created: number
  context_handoff_events_anchored: number
  failed: number
}

export interface AuditEscrowTickRunner {
  maybeTick(companyId: string): Promise<AuditEscrowTickSummary>
  forceTick(companyId: string): Promise<AuditEscrowTickSummary>
}

export function createAuditEscrowTickRunner(deps: { pool: Pool; logger: Logger }): AuditEscrowTickRunner {
  const { pool, logger } = deps

  const intervalMs = readPositiveInt('AUDIT_ESCROW_TICK_INTERVAL_MS', DEFAULT_INTERVAL_MS)
  const batchSize = Math.min(readPositiveInt('AUDIT_ESCROW_BATCH_SIZE', DEFAULT_BATCH_SIZE), 50_000)

  // Process-local last-run timestamp; rule matches queue-prune (a
  // restart costs one extra tick which is idempotent).
  let lastRunAt = 0

  async function runTick(companyId: string): Promise<AuditEscrowTickSummary> {
    const summary: AuditEscrowTickSummary = {
      ran: true,
      audit_event_entries_created: 0,
      audit_events_anchored: 0,
      context_handoff_entries_created: 0,
      context_handoff_events_anchored: 0,
      failed: 0,
    }

    try {
      const auditResult = await anchorAuditEvents(pool, logger, companyId, batchSize)
      if (auditResult.entryCreated) summary.audit_event_entries_created++
      summary.audit_events_anchored += auditResult.anchored
    } catch (err) {
      summary.failed++
      logger.error(
        { err, company_id: companyId, action: ACTIONS.AUDIT_EVENTS },
        '[audit-escrow] audit_event anchor failed',
      )
    }

    try {
      const handoffResult = await anchorContextHandoffEvents(pool, logger, companyId, batchSize)
      if (handoffResult.entryCreated) summary.context_handoff_entries_created++
      summary.context_handoff_events_anchored += handoffResult.anchored
    } catch (err) {
      summary.failed++
      logger.error(
        { err, company_id: companyId, action: ACTIONS.CONTEXT_HANDOFF },
        '[audit-escrow] context_handoff anchor failed',
      )
    }

    lastRunAt = Date.now()
    if (summary.audit_event_entries_created > 0 || summary.context_handoff_entries_created > 0 || summary.failed > 0) {
      logger.info({ company_id: companyId, ...summary }, '[audit-escrow] tick')
    }
    return summary
  }

  return {
    async maybeTick(companyId) {
      if (Date.now() - lastRunAt < intervalMs) {
        return {
          ran: false,
          audit_event_entries_created: 0,
          audit_events_anchored: 0,
          context_handoff_entries_created: 0,
          context_handoff_events_anchored: 0,
          failed: 0,
        }
      }
      return runTick(companyId)
    },
    forceTick: runTick,
  }
}

/**
 * Anchor the next batch of audit_events for a company. Returns the count
 * anchored and whether an entry was created (skipped when no new events).
 */
async function anchorAuditEvents(
  pool: Pool,
  logger: Logger,
  companyId: string,
  batchSize: number,
): Promise<{ entryCreated: boolean; anchored: number }> {
  // Find the last window_end we anchored for this (company, action). On
  // the first ever tick this returns null and we use `now() - interval '1
  // hour'` as the window start.
  const windowEndQuery = await pool.query<{ window_end: Date | null }>(
    `select window_end
       from audit_escrow_entries
      where action = $1
        and company_id IS NOT DISTINCT FROM $2::uuid
      order by id desc
      limit 1`,
    [ACTIONS.AUDIT_EVENTS, companyId],
  )
  const lastWindowEnd = windowEndQuery.rows[0]?.window_end ?? null
  const windowStart = lastWindowEnd ?? new Date(Date.now() - 60 * 60 * 1000)
  const windowEnd = new Date()

  if (windowEnd <= windowStart) {
    return { entryCreated: false, anchored: 0 }
  }

  // Pull the event rows. RLS is FORCE on audit_events (migration 085);
  // we run via an explicit tx with setCompanyGuc so the SELECT passes.
  const events = await selectAuditEventsForCompany(pool, companyId, windowStart, windowEnd, batchSize)
  if (events.length === 0) {
    return { entryCreated: false, anchored: 0 }
  }

  // Minimal redacted projection — only the fields a third-party auditor
  // needs to verify "this entity_id had action X at time Y". `before`/
  // `after` JSON is INTENTIONALLY EXCLUDED at this layer; the source row
  // still holds them in the primary DB. The escrow chain is the
  // tamper-evident anchor, not a full evidence dump.
  const payload = {
    schema: 'sitelayer.audit_events.minimal.v1',
    count: events.length,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    events: events.map((row) => ({
      id: row.id,
      created_at: row.created_at.toISOString(),
      action: row.action,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      actor_user_id: row.actor_user_id,
      actor_role: row.actor_role,
      sentry_trace: row.sentry_trace,
      request_id: row.request_id,
    })),
  }

  const entry = await appendEntry(pool, {
    action: ACTIONS.AUDIT_EVENTS,
    companyId,
    windowStart,
    windowEnd,
    sourceCount: events.length,
    payload,
  })

  // Back-fill escrow_anchor_id on the rows we just anchored. Done in a
  // separate tx so a back-fill failure leaves the chain entry intact —
  // a future tick will re-anchor (rows still have escrow_anchor_id IS
  // NULL). The chain is forward-only; double-anchoring is fine.
  const ids = events.map((row) => row.id)
  await backfillAnchorIds(pool, companyId, 'audit_events', ids, entry.id)

  // Best-effort external sealing. Failures logged + swallowed.
  await trySealExternal(logger, pool, entry, 'audit_events')

  return { entryCreated: true, anchored: ids.length }
}

/** Mirror of anchorAuditEvents for context_handoff_events. */
async function anchorContextHandoffEvents(
  pool: Pool,
  logger: Logger,
  companyId: string,
  batchSize: number,
): Promise<{ entryCreated: boolean; anchored: number }> {
  const windowEndQuery = await pool.query<{ window_end: Date | null }>(
    `select window_end
       from audit_escrow_entries
      where action = $1
        and company_id IS NOT DISTINCT FROM $2::uuid
      order by id desc
      limit 1`,
    [ACTIONS.CONTEXT_HANDOFF, companyId],
  )
  const lastWindowEnd = windowEndQuery.rows[0]?.window_end ?? null
  const windowStart = lastWindowEnd ?? new Date(Date.now() - 60 * 60 * 1000)
  const windowEnd = new Date()
  if (windowEnd <= windowStart) {
    return { entryCreated: false, anchored: 0 }
  }

  const events = await selectContextHandoffEventsForCompany(pool, companyId, windowStart, windowEnd, batchSize)
  if (events.length === 0) {
    return { entryCreated: false, anchored: 0 }
  }

  const payload = {
    schema: 'sitelayer.context_handoff_events.minimal.v1',
    count: events.length,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    events: events.map((row) => ({
      id: row.id,
      occurred_at: row.occurred_at.toISOString(),
      event_type: row.event_type,
      work_item_id: row.work_item_id,
      actor_kind: row.actor_kind,
      actor_user_id: row.actor_user_id,
      actor_ref: row.actor_ref,
      source_system: row.source_system,
      sentry_trace: row.sentry_trace,
      request_id: row.request_id,
      redaction_version: row.redaction_version,
    })),
  }

  const entry = await appendEntry(pool, {
    action: ACTIONS.CONTEXT_HANDOFF,
    companyId,
    windowStart,
    windowEnd,
    sourceCount: events.length,
    payload,
  })

  const ids = events.map((row) => row.id)
  await backfillAnchorIds(pool, companyId, 'context_handoff_events', ids, entry.id)
  await trySealExternal(logger, pool, entry, 'context_handoff_events')

  return { entryCreated: true, anchored: ids.length }
}

// -----------------------------------------------------------------------------
// SELECT helpers — run inside a transaction with setCompanyGuc so the
// RLS-enforced source tables let us read.
// -----------------------------------------------------------------------------

interface AuditEventRow {
  id: string
  created_at: Date
  action: string
  entity_type: string
  entity_id: string
  actor_user_id: string
  actor_role: string | null
  sentry_trace: string | null
  request_id: string | null
}

async function selectAuditEventsForCompany(
  pool: Pool,
  companyId: string,
  windowStart: Date,
  windowEnd: Date,
  limit: number,
): Promise<AuditEventRow[]> {
  return withCompanyTx(pool, companyId, async (client) => {
    const result = await client.query<AuditEventRow>(
      `select id, created_at, action, entity_type, entity_id, actor_user_id,
              actor_role, sentry_trace, request_id
         from audit_events
        where company_id = $1
          and escrow_anchor_id is null
          and created_at >  $2
          and created_at <= $3
        order by created_at asc, id asc
        limit $4`,
      [companyId, windowStart, windowEnd, limit],
    )
    return result.rows
  })
}

interface ContextHandoffEventRow {
  id: string
  occurred_at: Date
  event_type: string
  work_item_id: string
  actor_kind: string
  actor_user_id: string | null
  actor_ref: string | null
  source_system: string
  sentry_trace: string | null
  request_id: string | null
  redaction_version: string
}

async function selectContextHandoffEventsForCompany(
  pool: Pool,
  companyId: string,
  windowStart: Date,
  windowEnd: Date,
  limit: number,
): Promise<ContextHandoffEventRow[]> {
  return withCompanyTx(pool, companyId, async (client) => {
    const result = await client.query<ContextHandoffEventRow>(
      `select id, occurred_at, event_type, work_item_id, actor_kind,
              actor_user_id, actor_ref, source_system,
              sentry_trace, request_id, redaction_version
         from context_handoff_events
        where company_id = $1
          and escrow_anchor_id is null
          and occurred_at >  $2
          and occurred_at <= $3
        order by occurred_at asc, id asc
        limit $4`,
      [companyId, windowStart, windowEnd, limit],
    )
    return result.rows
  })
}

async function backfillAnchorIds(
  pool: Pool,
  companyId: string,
  table: 'audit_events' | 'context_handoff_events',
  ids: string[],
  entryId: number,
): Promise<void> {
  if (ids.length === 0) return
  await withCompanyTx(pool, companyId, async (client) => {
    // Whitelist-driven SQL: only `audit_events` or `context_handoff_events`
    // can land here per the type signature. The column name is identical
    // across both tables.
    const sql = `update ${table}
                    set escrow_anchor_id = $1
                  where company_id = $2
                    and id = ANY($3::uuid[])`
    await client.query(sql, [entryId, companyId, ids])
  })
}

async function withCompanyTx<T>(pool: Pool, companyId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// -----------------------------------------------------------------------------
// Best-effort external sealing
// -----------------------------------------------------------------------------

/**
 * Try DO Spaces (S3 Object Lock GOVERNANCE) + OpenTimestamps. Both are
 * gated on env vars; both swallow errors after logging. The local
 * signed chain is the legally-meaningful primitive.
 *
 * S3 path: `<bucket>/escrow/sitelayer/<YYYY>/<MM>/<DD>/<entry_id>.json`
 * Retention: 7 years (configurable via AUDIT_ESCROW_S3_RETAIN_YEARS).
 *
 * OTS: TODO stub only — wiring the OpenTimestamps client requires either
 * a fresh dependency (`javascript-opentimestamps`) or rolling our own
 * calendar HTTP client. Leaving as ots_status='pending' + the env gate
 * so the chain row records intent without making this PR a multi-dep
 * undertaking. Follow-up tracked in PROVING_GROUND_PLAN.md.
 */
async function trySealExternal(
  logger: Logger,
  pool: Pool,
  entry: AuditEscrowEntry,
  scope: 'audit_events' | 'context_handoff_events',
): Promise<void> {
  await trySealS3(logger, pool, entry, scope)
  await trySealOTS(logger, pool, entry)
}

async function trySealS3(
  logger: Logger,
  pool: Pool,
  entry: AuditEscrowEntry,
  scope: 'audit_events' | 'context_handoff_events',
): Promise<void> {
  const bucket = process.env.AUDIT_ESCROW_S3_BUCKET?.trim()
  if (!bucket) return
  const retainYears = readPositiveInt('AUDIT_ESCROW_S3_RETAIN_YEARS', 7)
  const created = entry.createdAt
  const yyyy = String(created.getUTCFullYear()).padStart(4, '0')
  const mm = String(created.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(created.getUTCDate()).padStart(2, '0')
  const objectKey = `escrow/sitelayer/${yyyy}/${mm}/${dd}/${entry.id}.json`
  const retainUntil = new Date(created.getTime())
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + retainYears)

  try {
    // Lazy-import the AWS SDK so a worker that doesn't set
    // AUDIT_ESCROW_S3_BUCKET pays nothing at boot.
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
    const region = process.env.AUDIT_ESCROW_S3_REGION ?? process.env.AWS_REGION ?? 'us-east-1'
    const endpoint = process.env.AUDIT_ESCROW_S3_ENDPOINT?.trim() || ''
    const accessKeyId = process.env.AUDIT_ESCROW_S3_ACCESS_KEY_ID?.trim()
    const secretAccessKey = process.env.AUDIT_ESCROW_S3_SECRET_ACCESS_KEY?.trim()
    // Build the config object piece-by-piece so exactOptionalPropertyTypes
    // is happy — we drop optional fields entirely rather than setting
    // them to undefined.
    const s3Config: ConstructorParameters<typeof S3Client>[0] = { region }
    if (endpoint) {
      s3Config.endpoint = endpoint
      s3Config.forcePathStyle = true // DO Spaces is path-style-friendly.
    }
    if (accessKeyId && secretAccessKey) {
      s3Config.credentials = { accessKeyId, secretAccessKey }
    }
    const client = new S3Client(s3Config)
    const body = JSON.stringify({
      entry_id: entry.id,
      entry_hash: entry.entryHash,
      previous_entry_hash: entry.previousEntryHash,
      action: entry.action,
      company_id: entry.companyId,
      window_start: entry.windowStart.toISOString(),
      window_end: entry.windowEnd.toISOString(),
      source_count: entry.sourceCount,
      payload_hash: entry.payloadHash,
      context_hash: entry.contextHash,
      key_id: entry.keyId,
      public_key_b64: entry.publicKeyB64,
      signature_b64: entry.signatureB64,
      algorithm: AUDIT_ESCROW_ALGORITHM,
      material: entry.material,
      payload: entry.payload,
    })
    const put = new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: 'application/json',
      ObjectLockMode: 'GOVERNANCE',
      ObjectLockRetainUntilDate: retainUntil,
    })
    const result = await client.send(put)
    await sealEntry(pool, {
      entryId: entry.id,
      s3Bucket: bucket,
      s3Key: objectKey,
      s3VersionId: result.VersionId ?? '',
      s3ObjectLocked: true,
    })
  } catch (err) {
    logger.warn(
      { err, scope, entry_id: entry.id, bucket, key: objectKey },
      '[audit-escrow] S3 seal failed (non-fatal; chain row intact)',
    )
  }
}

async function trySealOTS(_logger: Logger, _pool: Pool, _entry: AuditEscrowEntry): Promise<void> {
  // Stub: env-gated so operators see the intent in config without the
  // dependency footprint. The local Ed25519 chain is the legally-binding
  // primitive; OpenTimestamps would add Bitcoin-blockchain attestation
  // for entries that survive past the operator's signing-key custody.
  //
  // To wire: submit entry.entryHash bytes (sha256 raw) to
  // https://a.pool.opentimestamps.org/digest per the OpenTimestamps
  // calendar protocol; store proof bytes + `ots_status='pending'`. A
  // separate reconciliation step (out of scope for this wedge) upgrades
  // to `confirmed` once OTS bundles in a Bitcoin block.
  //
  // TODO(wedge2 follow-up): add javascript-opentimestamps dep + wire
  // submit + reconcile. Track in PROVING_GROUND_PLAN.md.
  if (process.env.AUDIT_ESCROW_OTS_ENABLED !== '1') return
  // Intentionally a no-op even when enabled — flagged in runbook.
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
