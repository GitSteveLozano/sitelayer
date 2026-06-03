import type { PoolClient } from 'pg'
import { appendWorkflowEvent, type QueueClient } from '@sitelayer/queue'
import { splitStraightAndOt } from '@sitelayer/domain'
import { withFreshToken, type IntegrationConnectionTokens, type RefreshDeps } from './qbo-token-refresh.js'

// QBO TimeActivity push for the labor-payroll workflow.
//
// Pattern mirrors apps/worker/src/qbo-invoice-push.ts and the existing
// rental-billing invoice drain in @sitelayer/queue. The route's
// POST_REQUESTED event enqueues a mutation_outbox row with
// mutation_type='post_qbo_time_activities' and idempotency key
// `labor_payroll_run:post:<run_id>`. This module:
//
//   1. Claims those rows (FOR UPDATE SKIP LOCKED, 5-min lease).
//   2. Locks the labor_payroll_run row, refuses if state != 'posting'.
//   3. If qbo_payroll_batch_ref is already populated, skips the QBO call
//      and emits POST_SUCCEEDED with the existing ids — covers crash-
//      after-push retries and the "RETRY_POST replays the same outbox row"
//      contract the route relies on.
//   4. Otherwise, calls the supplied push fn (real QBO in live mode, stub
//      otherwise), collects the array of QBO TimeActivity ids, and emits
//      POST_SUCCEEDED.
//   5. On failure: rolls back the per-row tx, emits POST_FAILED in a
//      fresh tx, and marks the outbox row 'failed' with a 15-minute
//      backoff so a transient flake recovers without spamming Intuit.
//
// Each row runs in its own per-row transaction so a stuck row can't strand
// earlier work or hold the lease.
//
// Live gating: only call real QBO when QBO_LIVE_LABOR_PAYROLL=1. Otherwise
// use the stub which returns synthetic ids so dev/preview/fixtures still
// exercise the deterministic plumbing end-to-end.
//
// Env knobs (live mode):
//   QBO_BASE_URL                  sandbox or production base
//   QBO_LIVE_LABOR_PAYROLL        '1' to enable real Intuit POSTs
//
// Idempotency: see point 3 — the qbo_payroll_batch_ref column is the
// authoritative "we already pushed this batch" marker. Worker retries
// against the same idempotency key are safe.
//
// OT-typed push: when companies.ot_service_item_code is set, each
// labor_entry whose hours exceed splitStraightAndOt's 8h/day threshold
// produces TWO TimeActivities — one for straight hours against the
// entry's existing service_item_code, one for OT hours against the
// company's OT ItemRef. When the column is NULL (default) the worker
// posts one TimeActivity per entry with the full hours value — today's
// pre-OT behavior. See decideTimeActivityPayloads() for the split
// decision logic (unit-tested in labor-payroll-push.test.ts).

export type LaborPayrollPushInput = {
  client: QueueClient
  companyId: string
  runId: string
  payload: Record<string, unknown>
}

export type LaborPayrollPushResult = {
  qbo_timeactivity_ids: string[]
}

export type LaborPayrollPushFn = (input: LaborPayrollPushInput) => Promise<LaborPayrollPushResult>

export type LaborPayrollPushSummary = {
  processed: number
  posted: number
  failed: number
  skipped: number
}

type ClaimedPushRow = {
  id: string
  entity_id: string
  payload: Record<string, unknown>
  attempt_count: number
}

type LaborPayrollRunStateRow = {
  id: string
  state: string
  state_version: number
  qbo_payroll_batch_ref: string[] | null
  approved_at: string | null
  approved_by_user_id: string | null
  posted_at: string | null
  failed_at: string | null
  error_message: string | null
  auto_posted: boolean
}

type LaborEntryPushRow = {
  id: string
  worker_id: string | null
  project_id: string
  hours: string
  occurred_on: string
  service_item_code: string | null
}

const LABOR_PAYROLL_WORKFLOW_NAME = 'labor_payroll_run'
const LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION = 1

function rowToWorkflowSnapshot(row: LaborPayrollRunStateRow): Record<string, unknown> {
  return {
    state: row.state,
    state_version: row.state_version,
    approved_at: row.approved_at,
    approved_by: row.approved_by_user_id,
    posted_at: row.posted_at,
    failed_at: row.failed_at,
    error: row.error_message,
    qbo_timeactivity_ids: row.qbo_payroll_batch_ref,
    auto_posted: row.auto_posted,
  }
}

async function applyLaborPayrollWorkerEvent(
  client: QueueClient,
  companyId: string,
  runId: string,
  outcome: { kind: 'succeeded'; qbo_timeactivity_ids: string[] } | { kind: 'failed'; error: string },
): Promise<LaborPayrollRunStateRow | null> {
  const lockResult = await client.query<LaborPayrollRunStateRow>(
    `select id, state, state_version, qbo_payroll_batch_ref,
            approved_at, approved_by_user_id, posted_at, failed_at, error_message, auto_posted
     from labor_payroll_runs
     where company_id = $1 and id = $2 and deleted_at is null
     for update`,
    [companyId, runId],
  )
  const current = lockResult.rows[0]
  if (!current) return null
  if (current.state !== 'posting') {
    // Race: a human VOID landed first, or the run already moved off
    // 'posting'. Worker MUST NOT overwrite — the human event is
    // authoritative. Return current so the caller can mark the outbox
    // applied without changing state.
    return current
  }
  const beforeVersion = current.state_version
  const nextVersion = beforeVersion + 1
  if (outcome.kind === 'succeeded') {
    const postedAt = new Date().toISOString()
    const updated = await client.query<LaborPayrollRunStateRow>(
      `update labor_payroll_runs
         set state = 'posted',
             state_version = $3,
             posted_at = $4,
             qbo_payroll_batch_ref = $5::jsonb,
             error_message = null,
             failed_at = null,
             version = version + 1,
             updated_at = now()
       where company_id = $1 and id = $2
       returning id, state, state_version, qbo_payroll_batch_ref,
                 approved_at, approved_by_user_id, posted_at, failed_at, error_message, auto_posted`,
      [companyId, runId, nextVersion, postedAt, JSON.stringify(outcome.qbo_timeactivity_ids)],
    )
    const row = updated.rows[0] ?? null
    if (row) {
      await appendWorkflowEvent(client, {
        companyId,
        workflowName: LABOR_PAYROLL_WORKFLOW_NAME,
        schemaVersion: LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION,
        entityType: 'labor_payroll_run',
        entityId: runId,
        stateVersion: beforeVersion,
        eventType: 'POST_SUCCEEDED',
        eventPayload: {
          type: 'POST_SUCCEEDED',
          posted_at: postedAt,
          qbo_timeactivity_ids: outcome.qbo_timeactivity_ids,
        },
        snapshotAfter: rowToWorkflowSnapshot(row),
      })
    }
    return row
  }
  const failedAt = new Date().toISOString()
  const errorMessage = outcome.error.slice(0, 1000)
  const updated = await client.query<LaborPayrollRunStateRow>(
    `update labor_payroll_runs
       set state = 'failed',
           state_version = $3,
           failed_at = $4,
           error_message = $5,
           version = version + 1,
           updated_at = now()
     where company_id = $1 and id = $2
     returning id, state, state_version, qbo_payroll_batch_ref,
               approved_at, approved_by_user_id, posted_at, failed_at, error_message, auto_posted`,
    [companyId, runId, nextVersion, failedAt, errorMessage],
  )
  const row = updated.rows[0] ?? null
  if (row) {
    await appendWorkflowEvent(client, {
      companyId,
      workflowName: LABOR_PAYROLL_WORKFLOW_NAME,
      schemaVersion: LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION,
      entityType: 'labor_payroll_run',
      entityId: runId,
      stateVersion: beforeVersion,
      eventType: 'POST_FAILED',
      eventPayload: { type: 'POST_FAILED', failed_at: failedAt, error: errorMessage },
      snapshotAfter: rowToWorkflowSnapshot(row),
    })
  }
  return row
}

async function recordLaborPayrollSyncEvent(
  client: QueueClient,
  companyId: string,
  runId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into sync_events (company_id, integration_connection_id, direction, entity_type, entity_id, payload, status)
     values ($1, null, 'outbound', 'labor_payroll_run', $2, $3::jsonb, 'applied')`,
    [companyId, runId, JSON.stringify(payload)],
  )
}

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

/**
 * Stub push fn for dev/preview/fixtures. Returns synthetic ids — one per
 * covered labor entry — so the deterministic plumbing (route → outbox →
 * worker → POST_SUCCEEDED → state=posted) can be exercised end-to-end
 * without QBO.
 */
export const stubLaborPayrollPush: LaborPayrollPushFn = async ({ runId, payload }) => {
  const ids = Array.isArray((payload as { covered_labor_entry_ids?: unknown[] }).covered_labor_entry_ids)
    ? ((payload as { covered_labor_entry_ids: string[] }).covered_labor_entry_ids ?? [])
    : []
  const ts = Date.now()
  const synthetic =
    ids.length > 0
      ? ids.map((_, i) => `STUB-TA-${runId.slice(0, 8)}-${ts}-${i}`)
      : [`STUB-TA-${runId.slice(0, 8)}-${ts}`]
  return { qbo_timeactivity_ids: synthetic }
}

type QboTimeActivityCreateResponse = {
  TimeActivity?: { Id?: string }
}

function n(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}

/**
 * Per-TimeActivity payload values needed to construct a QBO POST body.
 *
 * Kind 'straight' uses the labor_entry's existing service_item_code
 * (resolved to the QBO Item id by the caller). Kind 'ot' uses the
 * company-level ot_service_item_code (only emitted when both the
 * company has the column set AND splitStraightAndOt produces
 * ot_hours > 0).
 */
export type DecidedTimeActivityPayload = {
  kind: 'straight' | 'ot'
  hours: number
  /**
   * service_items.code to resolve to a QBO Item external_id. Null for
   * straight payloads when the entry has no service_item_code (today's
   * behavior — caller decides how to handle).
   */
  serviceItemCode: string | null
}

/**
 * Pure helper deciding whether to emit one or two QBO TimeActivity
 * payloads for a single labor_entry.
 *
 * Two-payload (OT-typed) path requires BOTH:
 *   - otServiceItemCode is a non-empty string (per-company opt-in)
 *   - splitStraightAndOt(hours) produces ot_hours > 0
 *
 * Otherwise: one-payload path. The caller posts a single TimeActivity
 * with the full hours value against the entry's existing
 * service_item_code (today's pre-OT-split behavior).
 *
 * Edge cases worth pinning in tests:
 *   - hours <= 0 → empty payload list (caller skips the entry; QBO
 *     rejects 0-hour TimeActivities anyway)
 *   - hours below 8h threshold → single 'straight' payload regardless
 *     of OT opt-in (no OT hours produced)
 *   - hours above threshold but otServiceItemCode null → single
 *     payload with full hours, no split (opt-out path)
 */
export function decideTimeActivityPayloads(
  entry: { hours: number; service_item_code: string | null },
  otServiceItemCode: string | null,
): DecidedTimeActivityPayload[] {
  const totalHours = n(entry.hours)
  if (totalHours <= 0) return []

  // Opt-out path: no per-company OT mapping → single payload with full
  // hours against the entry's existing service_item_code.
  if (!otServiceItemCode) {
    return [
      {
        kind: 'straight',
        hours: totalHours,
        serviceItemCode: entry.service_item_code,
      },
    ]
  }

  const { straight_hours, ot_hours } = splitStraightAndOt(totalHours)
  if (ot_hours <= 0) {
    return [
      {
        kind: 'straight',
        hours: totalHours,
        serviceItemCode: entry.service_item_code,
      },
    ]
  }

  const payloads: DecidedTimeActivityPayload[] = []
  if (straight_hours > 0) {
    payloads.push({
      kind: 'straight',
      hours: straight_hours,
      serviceItemCode: entry.service_item_code,
    })
  }
  payloads.push({
    kind: 'ot',
    hours: ot_hours,
    serviceItemCode: otServiceItemCode,
  })
  return payloads
}

/**
 * Build a deterministic Intuit `requestid` for a single TimeActivity within a
 * labor-payroll batch.
 *
 * A payroll batch posts MANY TimeActivities to the same /timeactivity endpoint,
 * so they CANNOT share one requestid (Intuit would dedupe all but the first).
 * Each must be unique within the batch BUT stable across a whole-batch retry,
 * so a crash mid-batch (some TimeActivities already accepted by Intuit) replays
 * with the SAME per-line requestid and Intuit returns the originals instead of
 * minting duplicates. The tuple (runId, labor_entry id, straight|ot) uniquely
 * and deterministically identifies one TimeActivity: the worker emits at most
 * one 'straight' and one 'ot' part per entry (see decideTimeActivityPayloads).
 *
 * Sanitized to URL-safe chars and capped at Intuit's 50-char requestid limit.
 * Because UUIDs alone already consume 36 chars, we hash-fold the composite into
 * a compact, collision-resistant token rather than naively concatenating
 * (which would overflow 50 chars and get truncated to a non-unique prefix).
 */
export function laborTimeActivityRequestId(runId: string, entryId: string, kind: 'straight' | 'ot'): string {
  const composite = `${runId}:${entryId}:${kind}`
  // FNV-1a 32-bit — small, dependency-free, deterministic. Combined with the
  // short kind suffix it keeps the token well under 50 chars and unique per
  // (run, entry, kind) tuple.
  let hash = 0x811c9dc5
  for (let i = 0; i < composite.length; i += 1) {
    hash ^= composite.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0')
  return `ta-${runId.slice(0, 8)}-${entryId.slice(0, 8)}-${kind}-${hex}`
}

/**
 * Build the live QBO TimeActivity push fn for the labor-payroll workflow.
 * Returned fn loads the connection + employee mappings via the supplied tx
 * client (so the row locks held during the worker tx apply), then POSTs
 * one TimeActivity per covered labor_entry to QBO.
 *
 * Idempotency: the caller (processLaborPayrollPush) checks
 * labor_payroll_runs.qbo_payroll_batch_ref BEFORE invoking this fn — if
 * it's set we never hit QBO. So this fn is allowed to throw on any
 * partial failure; the handler converts the throw into POST_FAILED and
 * the outbox row is retried after the 15-minute backoff (whole batch
 * re-pushed; QBO TimeActivity has no upsert semantics, so a partial
 * batch will produce duplicates on QBO's side until an admin reconciles).
 *
 * Mirrors apps/api/src/qbo-material-bill-sync.ts for the Intuit REST
 * integration shape (same /v3/company/<realm>/<entity> paths and Bearer
 * token handling, threaded through withFreshToken for refresh-on-401).
 */
export function createQboLaborPayrollPush(refreshDeps: RefreshDeps = {}): LaborPayrollPushFn {
  const baseUrl = process.env.QBO_BASE_URL ?? 'https://sandbox-quickbooks.api.intuit.com'

  return async ({ client, companyId, runId, payload }) => {
    // 1. Resolve QBO connection (locked for refresh inside withFreshToken).
    const conn = await client.query<IntegrationConnectionTokens>(
      `select id, provider_account_id, access_token, refresh_token, status, access_token_expires_at
       from integration_connections
       where company_id = $1 and provider = 'qbo' and deleted_at is null
       limit 1`,
      [companyId],
    )
    const connection = conn.rows[0]
    if (!connection?.provider_account_id) {
      throw new Error('qbo connection missing realm id')
    }
    if (connection.status !== 'connected') {
      throw new Error(`qbo connection status is ${connection.status}, refusing to push`)
    }
    if (!connection.access_token && !connection.refresh_token) {
      throw new Error('qbo connection has neither access_token nor refresh_token; operator must reconnect')
    }

    // 1b. Load the per-company OT mapping. NULL = no OT split (fall
    // back to today's single-TimeActivity behavior). When set, the
    // worker will emit two TimeActivities for any entry whose hours
    // exceed splitStraightAndOt's 8h threshold.
    const settingsResult = await client.query<{ ot_service_item_code: string | null }>(
      `select ot_service_item_code from companies where id = $1 limit 1`,
      [companyId],
    )
    const otServiceItemCode = settingsResult.rows[0]?.ot_service_item_code ?? null

    // 1c. Pre-resolve the OT service item's QBO Item id (once per
    // batch). Throwing here rather than mid-loop keeps the error
    // surface narrow: "configure the mapping" is one fix, not a
    // retry-with-partial-batch puzzle.
    let otQboItemId: string | null = null
    if (otServiceItemCode) {
      const otItemMap = await client.query<{ external_id: string }>(
        `select external_id from integration_mappings
         where company_id = $1 and provider = 'qbo' and entity_type = 'service_item'
           and local_ref = $2 and deleted_at is null
         limit 1`,
        [companyId, otServiceItemCode],
      )
      if (!otItemMap.rows[0]) {
        throw new Error(
          `companies.ot_service_item_code is set to "${otServiceItemCode}" but no QBO service_item mapping exists for that code — map it via /api/integrations/qbo/mappings or clear the OT setting before retrying`,
        )
      }
      otQboItemId = otItemMap.rows[0].external_id
    }

    // 2. Load every covered labor_entry. Re-read from the table inside
    // the worker tx rather than trusting payload.covered_labor_entry_ids
    // alone, so any concurrent edits (admin justification + PATCH) land
    // on the freshest data.
    const ids = Array.isArray((payload as { covered_labor_entry_ids?: unknown[] }).covered_labor_entry_ids)
      ? ((payload as { covered_labor_entry_ids: string[] }).covered_labor_entry_ids ?? [])
      : []
    if (ids.length === 0) {
      throw new Error('labor payroll run has no covered_labor_entry_ids; cannot push empty TimeActivity batch')
    }
    const entries = await client.query<LaborEntryPushRow>(
      `select id, worker_id, project_id, hours,
              to_char(occurred_on, 'YYYY-MM-DD') as occurred_on,
              service_item_code
       from labor_entries
       where company_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
      [companyId, ids],
    )
    if (entries.rows.length === 0) {
      throw new Error(`labor payroll run ${runId} covered_labor_entry_ids resolved to zero rows`)
    }

    const fetchImpl = refreshDeps.fetchImpl ?? fetch
    const timeActivityUrl = `${baseUrl}/v3/company/${connection.provider_account_id}/timeactivity`
    const postedIds: string[] = []

    // Cache for per-entry service_item_code → QBO Item id lookups. The
    // OT code's id is already resolved above; non-OT codes are
    // resolved on first sight.
    const itemIdCache = new Map<string, string | null>()
    if (otServiceItemCode && otQboItemId) itemIdCache.set(otServiceItemCode, otQboItemId)

    const resolveItemId = async (code: string | null): Promise<string | null> => {
      if (!code) return null
      if (itemIdCache.has(code)) return itemIdCache.get(code) ?? null
      const row = await client.query<{ external_id: string }>(
        `select external_id from integration_mappings
         where company_id = $1 and provider = 'qbo' and entity_type = 'service_item'
           and local_ref = $2 and deleted_at is null
         limit 1`,
        [companyId, code],
      )
      const external = row.rows[0]?.external_id ?? null
      itemIdCache.set(code, external)
      return external
    }

    // 3. Per-entry POST. Each call is its own withFreshToken block so a
    // 401 in the middle of the batch refreshes once and continues.
    for (const entry of entries.rows) {
      // Resolve QBO Employee mapping for the worker. NULL worker_id is
      // tolerated only if QBO accepts an unattributed TimeActivity
      // (varies by account); we throw to surface the missing mapping
      // explicitly rather than silently dropping the entry.
      let employeeRef: { value: string } | null = null
      if (entry.worker_id) {
        const empMap = await client.query<{ external_id: string }>(
          `select external_id from integration_mappings
           where company_id = $1 and provider = 'qbo' and entity_type = 'qbo_employee'
             and local_ref = $2 and deleted_at is null
           limit 1`,
          [companyId, entry.worker_id],
        )
        if (empMap.rows[0]) employeeRef = { value: empMap.rows[0].external_id }
      }
      if (!employeeRef) {
        throw new Error(
          `no QBO employee mapping for worker ${entry.worker_id ?? '(none)'} on labor_entry ${entry.id} — map via /api/integrations/qbo/mappings before retrying`,
        )
      }

      const decided = decideTimeActivityPayloads(
        { hours: n(entry.hours), service_item_code: entry.service_item_code },
        otServiceItemCode,
      )
      if (decided.length === 0) continue

      for (const part of decided) {
        const wholeHours = Math.floor(part.hours)
        const minutes = Math.round((part.hours - wholeHours) * 60)

        // ItemRef resolution: OT parts always hit the pre-resolved id;
        // straight parts only need an ItemRef when service_item_code
        // is set on the entry (today's path tolerated missing codes —
        // QBO accepts a TimeActivity without ItemRef as long as the
        // EmployeeRef is present, so we preserve that behavior).
        let itemRef: { value: string } | undefined
        if (part.kind === 'ot') {
          itemRef = otQboItemId ? { value: otQboItemId } : undefined
        } else if (part.serviceItemCode) {
          const external = await resolveItemId(part.serviceItemCode)
          if (external) itemRef = { value: external }
        }

        const description =
          part.kind === 'ot'
            ? `Sitelayer labor entry ${entry.id} OT (run ${runId})`
            : `Sitelayer labor entry ${entry.id} (run ${runId})`

        const timeActivityPayload: Record<string, unknown> = {
          NameOf: 'Employee',
          EmployeeRef: employeeRef,
          TxnDate: entry.occurred_on,
          Hours: wholeHours,
          Minutes: minutes,
          Description: description,
        }
        if (itemRef) timeActivityPayload.ItemRef = itemRef

        // Intuit idempotency: unique-per-line, stable-across-retry requestid.
        const requestId = laborTimeActivityRequestId(runId, entry.id, part.kind)
        const url = `${timeActivityUrl}?requestid=${encodeURIComponent(requestId)}`
        const parsed = await withFreshToken<QboTimeActivityCreateResponse>(
          connection,
          client,
          async (token) => {
            const response = await fetchImpl(url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(timeActivityPayload),
            })
            if (response.status === 401) {
              await response.text().catch(() => '')
              return { unauthorized: true }
            }
            if (!response.ok) {
              const errBody = await response.text()
              throw new Error(
                `qbo timeactivity POST returned ${response.status}: ${errBody.slice(0, 500)} (entry ${entry.id}, kind ${part.kind})`,
              )
            }
            return { unauthorized: false, value: (await response.json()) as QboTimeActivityCreateResponse }
          },
          refreshDeps,
        )
        const taId = parsed.TimeActivity?.Id
        if (!taId) {
          throw new Error(
            `qbo timeactivity POST succeeded but TimeActivity.Id missing for entry ${entry.id} (kind ${part.kind})`,
          )
        }
        postedIds.push(taId)
      }
    }
    return { qbo_timeactivity_ids: postedIds }
  }
}

/**
 * Resolve which push fn to use based on env. Mirrors the
 * createQboRentalInvoicePush / stub selection in worker.ts.
 *
 * Live mode (QBO_LIVE_LABOR_PAYROLL=1): real QBO TimeActivity POSTs.
 * Otherwise: stub returns synthetic ids so end-to-end plumbing works
 * in dev/preview without an Intuit account.
 */
export function selectLaborPayrollPush(refreshDeps: RefreshDeps = {}): LaborPayrollPushFn {
  if (process.env.QBO_LIVE_LABOR_PAYROLL === '1') {
    return createQboLaborPayrollPush(refreshDeps)
  }
  return stubLaborPayrollPush
}

/**
 * Drain mutation_outbox rows with mutation_type='post_qbo_time_activities'.
 *
 * Phase 1: claim a batch (FOR UPDATE SKIP LOCKED, 5-min lease) in its
 * own tx so the 'processing' marker is durable even if every per-row
 * work tx fails.
 *
 * Phase 2: per-row work in independent transactions so a failure in
 * one row's body or recovery path can't strand earlier rows or hold
 * the lease.
 *
 * Same idempotency contract as processRentalBillingInvoicePush:
 * if labor_payroll_runs.qbo_payroll_batch_ref is already set, skip
 * the QBO call and emit POST_SUCCEEDED with the existing ids.
 */
export async function processLaborPayrollPush(
  client: PoolClient,
  companyId: string,
  push: LaborPayrollPushFn,
  limit = 5,
): Promise<LaborPayrollPushSummary> {
  await client.query('begin')
  let claimed: { rows: ClaimedPushRow[]; rowCount: number | null }
  try {
    const result = await client.query<ClaimedPushRow>(
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
          and entity_type = 'labor_payroll_run'
          and mutation_type = 'post_qbo_time_activities'
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

  let posted = 0
  let failed = 0
  let skipped = 0

  for (const row of claimed.rows) {
    const runId = row.entity_id
    await client.query('begin')
    try {
      // Idempotency check: if qbo_payroll_batch_ref already populated,
      // skip the QBO call and emit POST_SUCCEEDED with the stored ids.
      const existing = await client.query<{ qbo_payroll_batch_ref: string[] | null; state: string }>(
        `select qbo_payroll_batch_ref, state from labor_payroll_runs
         where company_id = $1 and id = $2 and deleted_at is null limit 1`,
        [companyId, runId],
      )
      const existingRow = existing.rows[0]
      if (!existingRow) {
        await client.query(
          `update mutation_outbox set status = 'failed', error = $3, applied_at = now()
           where company_id = $1 and id = $2`,
          [companyId, row.id, 'labor_payroll_run not found'],
        )
        await client.query('commit')
        failed += 1
        continue
      }
      if (
        Array.isArray(existingRow.qbo_payroll_batch_ref) &&
        existingRow.qbo_payroll_batch_ref.length > 0 &&
        existingRow.state === 'posting'
      ) {
        // Replay-safe: previous push succeeded but outbox row never marked
        // applied. Emit POST_SUCCEEDED with the existing ids — no second QBO call.
        await applyLaborPayrollWorkerEvent(client, companyId, runId, {
          kind: 'succeeded',
          qbo_timeactivity_ids: existingRow.qbo_payroll_batch_ref,
        })
        await recordLaborPayrollSyncEvent(client, companyId, runId, {
          action: 'post_succeeded',
          provider: 'qbo',
          external_ids: existingRow.qbo_payroll_batch_ref,
          idempotent_replay: true,
        })
        await client.query(
          `update mutation_outbox set status = 'applied', applied_at = now(), error = null
           where company_id = $1 and id = $2`,
          [companyId, row.id],
        )
        await client.query('commit')
        skipped += 1
        continue
      }

      const result = await push({ client, companyId, runId, payload: row.payload })
      const updated = await applyLaborPayrollWorkerEvent(client, companyId, runId, {
        kind: 'succeeded',
        qbo_timeactivity_ids: result.qbo_timeactivity_ids,
      })
      await recordLaborPayrollSyncEvent(client, companyId, runId, {
        action: 'post_succeeded',
        provider: 'qbo',
        external_ids: result.qbo_timeactivity_ids,
        state_version: updated?.state_version ?? null,
      })
      await client.query(
        `update mutation_outbox set status = 'applied', applied_at = now(), error = null
         where company_id = $1 and id = $2`,
        [companyId, row.id],
      )
      await client.query('commit')
      posted += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      await client.query('rollback').catch(() => {})

      // Best-effort recovery in fresh tx: emit POST_FAILED, sync event.
      try {
        await client.query('begin')
        await applyLaborPayrollWorkerEvent(client, companyId, row.entity_id, {
          kind: 'failed',
          error: message,
        })
        await recordLaborPayrollSyncEvent(client, companyId, row.entity_id, {
          action: 'post_failed',
          provider: 'qbo',
          error: message,
        })
        await client.query('commit')
      } catch (recoveryErr) {
        await client.query('rollback').catch(() => {})
        ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
          '[queue] labor-payroll recovery path threw',
          { runId: row.entity_id, originalError: message, recoveryError: recoveryErr },
        )
      }

      try {
        await markOutboxRowFailedFresh(client, companyId, row.id, message)
        failed += 1
      } catch (markErr) {
        ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
          '[queue] labor-payroll failed to mark outbox row failed; will be re-claimed after lease',
          { outboxId: row.id, error: markErr },
        )
      }
    }
  }

  return { processed: claimed.rowCount ?? 0, posted, failed, skipped }
}

// ---------------------------------------------------------------------------
// generate_labor_payroll_run drain
//
// Bridges time-review APPROVE → labor-payroll without touching the
// time-review reducer. The flow:
//
//   1. time-review APPROVE enqueues 'lock_labor_entries' (existing —
//      see packages/workflows/src/time-review.ts).
//   2. The lock_labor_entries handler stamps review_locked_at on every
//      covered labor_entry (existing — see
//      packages/queue/src/lock-labor-entries.ts).
//   3. THIS drain runs. It picks up time_review_runs in state='approved'
//      where ALL covered_entry_ids are locked AND none have been
//      enrolled in a labor_payroll_run yet. For each such run it
//      creates one labor_payroll_run row in 'generated' state and
//      stamps payroll_run_id on every entry it claims.
//
// Step 3 is idempotent at two levels:
//   - The (company_id, period_start, period_end) UNIQUE constraint on
//     labor_payroll_runs means a duplicate insert 23505s — the drain
//     catches it and skips the time_review_run.
//   - The labor_entries.payroll_run_id back-reference IS NULL filter
//     ensures a concurrent run can't double-claim entries.
//
// Why poll-based and not outbox-driven? lock_labor_entries already runs
// in the worker; chaining a sibling outbox row from inside its handler
// would require editing @sitelayer/queue which the scope forbids. The
// poll is cheap (indexed query, runs once per heartbeat per company)
// and the unique-constraint guard means duplicate enqueues are safe.
// ---------------------------------------------------------------------------

export type GenerateLaborPayrollRunSummary = {
  processed: number
  generated: number
  skipped: number
  failed: number
}

type ApprovedTimeReviewRow = {
  id: string
  period_start: string
  period_end: string
  covered_entry_ids: string[]
}

/**
 * Find approved time_review_runs whose covered entries are all locked
 * and not yet on any payroll run, then materialise a labor_payroll_run
 * for each.
 *
 * Per-row work happens in its own transaction so a stuck row can't
 * strand earlier work.
 */
export async function processGenerateLaborPayrollRun(
  client: PoolClient,
  companyId: string,
  limit = 10,
): Promise<GenerateLaborPayrollRunSummary> {
  let generated = 0
  let skipped = 0
  let failed = 0
  let processed = 0

  // Candidate selection: approved time_review_runs whose period doesn't
  // already have a labor_payroll_run. The covered_entry_ids check is
  // re-validated inside each per-row tx (the candidate query is just a
  // cheap pre-filter).
  const candidates = await client.query<ApprovedTimeReviewRow>(
    `select tr.id,
            to_char(tr.period_start, 'YYYY-MM-DD') as period_start,
            to_char(tr.period_end, 'YYYY-MM-DD') as period_end,
            tr.covered_entry_ids
       from time_review_runs tr
      where tr.company_id = $1
        and tr.state = 'approved'
        and not exists (
          select 1 from labor_payroll_runs lpr
          where lpr.company_id = tr.company_id
            and lpr.period_start = tr.period_start
            and lpr.period_end = tr.period_end
            and lpr.deleted_at is null
        )
      order by tr.approved_at asc nulls last
      limit $2`,
    [companyId, limit],
  )

  for (const candidate of candidates.rows) {
    processed++
    await client.query('begin')
    try {
      // Verify every covered entry is locked. If any aren't (race with
      // lock_labor_entries handler), defer this candidate to a future
      // tick. Skip rather than fail so a transient gap doesn't park
      // the row at status='failed'.
      const ids = Array.isArray(candidate.covered_entry_ids) ? candidate.covered_entry_ids : []
      if (ids.length === 0) {
        await client.query('commit')
        skipped++
        continue
      }
      const entries = await client.query<{
        id: string
        review_locked_at: string | null
        payroll_run_id: string | null
        worker_id: string | null
        hours: string
        base_hourly_cents: number | null
        insurance_pct: string | null
        benefits_pct: string | null
      }>(
        `select le.id, le.review_locked_at, le.payroll_run_id,
                le.worker_id, le.hours,
                w.base_hourly_cents, w.insurance_pct, w.benefits_pct
           from labor_entries le
           left join workers w on w.id = le.worker_id and w.company_id = le.company_id
          where le.company_id = $1
            and le.id = any($2::uuid[])
            and le.deleted_at is null`,
        [companyId, ids],
      )
      const allLocked = entries.rows.every((r) => r.review_locked_at !== null)
      const anyClaimed = entries.rows.some((r) => r.payroll_run_id !== null)
      if (!allLocked || anyClaimed) {
        // Deferral or already-claimed-by-another-batch — skip.
        await client.query('commit')
        skipped++
        continue
      }

      const claimedIds = entries.rows.map((r) => r.id)
      const totalHoursNum = entries.rows.reduce((sum, r) => sum + Number(r.hours || 0), 0)
      let totalCents = 0
      for (const r of entries.rows) {
        const base = Number(r.base_hourly_cents || 0)
        const insurance = Number(r.insurance_pct || 0)
        const benefits = Number(r.benefits_pct || 0)
        const hours = Number(r.hours || 0)
        const loaded = base * (1 + insurance / 100 + benefits / 100)
        totalCents += Math.round(loaded * hours)
      }

      const insert = await client.query<{ id: string }>(
        `insert into labor_payroll_runs (
           company_id, period_start, period_end,
           covered_labor_entry_ids, total_hours, total_cents,
           time_review_run_id
         )
         values ($1, $2::date, $3::date, $4::uuid[], $5, $6, $7)
         on conflict (company_id, period_start, period_end) do nothing
         returning id`,
        [
          companyId,
          candidate.period_start,
          candidate.period_end,
          claimedIds,
          totalHoursNum.toFixed(2),
          String(totalCents),
          candidate.id,
        ],
      )
      const newRunId = insert.rows[0]?.id ?? null
      if (!newRunId) {
        // Unique-constraint hit — another worker created this run between
        // candidate selection and insert. Skip cleanly.
        await client.query('commit')
        skipped++
        continue
      }

      // Stamp payroll_run_id on every entry we claimed. Filter on
      // payroll_run_id IS NULL so a concurrent claim path can't
      // double-stamp.
      await client.query(
        `update labor_entries
           set payroll_run_id = $2
         where company_id = $1
           and id = any($3::uuid[])
           and payroll_run_id is null`,
        [companyId, newRunId, claimedIds],
      )

      await client.query('commit')
      generated++
    } catch (err) {
      await client.query('rollback').catch(() => {})
      failed++
      ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
        '[labor-payroll] generate_labor_payroll_run failed for time_review_run',
        { time_review_run_id: candidate.id, error: err instanceof Error ? err.message : String(err) },
      )
    }
  }

  return { processed, generated, skipped, failed }
}
