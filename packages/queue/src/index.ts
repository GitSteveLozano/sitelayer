import type { QueryResult, QueryResultRow } from 'pg'
import { buildWorkflowEventLogInsert } from '@sitelayer/workflows'

export {
  fetchDueRentals,
  processRentalInvoice,
  RENTAL_SELECT_COLUMNS,
  type ProcessRentalInvoiceResult,
  type RentalMaterialBillRow,
  type RentalRow,
} from './rentals.js'

export { recordLedger, type RecordLedgerArgs, type LedgerTraceContext } from './ledger.js'

export {
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  isTrippingError,
  withCircuitBreaker,
  type CircuitBreakerConfig,
} from './circuit-breaker.js'

// Audit Escrow MVP — signed, chained, append-only evidence anchor for
// sitelayer's audit chain. Wedge 2 of docs/PROVING_GROUND_PLAN.md.
// Lives in the queue package because both apps/api (verification routes)
// and apps/worker (hourly tick) need to import it; queue is the
// established shared infrastructure layer for cross-app primitives.
export {
  AUDIT_ESCROW_ALGORITHM,
  AUDIT_ESCROW_VERSION,
  appendEntry as appendAuditEscrowEntry,
  canonicalizeJSON as canonicalizeAuditEscrowJSON,
  getChainHead as getAuditEscrowChainHead,
  getEntryById as getAuditEscrowEntryById,
  getOrCreateActiveSigningKey as getOrCreateAuditEscrowSigningKey,
  hashCanonicalJSON as hashAuditEscrowCanonicalJSON,
  hashSHA256 as hashAuditEscrowSHA256,
  sealEntry as sealAuditEscrowEntry,
  signEd25519 as signAuditEscrowEd25519,
  verifyEd25519 as verifyAuditEscrowEd25519,
  verifyEntry as verifyAuditEscrowEntry,
  type AppendEntryParams as AppendAuditEscrowEntryParams,
  type AuditEscrowEntry,
  type AuditEscrowKey,
  type AuditEscrowMaterial,
  type SealMetadataInput as SealAuditEscrowMetadataInput,
  type VerificationReport as AuditEscrowVerificationReport,
} from './audit-escrow.js'

/**
 * Prune long-applied rows out of `mutation_outbox` and `sync_events`.
 * Both tables grow forever once a row is `applied_at IS NOT NULL`
 * because nothing ever reclaims them — they're an audit trail, not a
 * work queue. After ~30 days they're operationally useless (the trace
 * id has aged out of Sentry, the QBO push has long since reconciled)
 * but they keep bloating the table, slowing autovacuum and chewing
 * managed-Postgres disk.
 *
 * Safe to re-run: the DELETE is gated by `applied_at < now() -
 * interval 'N days'`, so a second run within the same hour is a no-op.
 * Caller is responsible for cadence (the worker's queue-prune runner
 * fires once per day via a last-run-at gate).
 *
 * Returns per-table delete counts so the caller can emit metrics /
 * structured logs.
 */
export async function pruneAppliedQueue(
  client: QueueClient,
  opts: { retentionDays: number },
): Promise<{ mutation_outbox: number; sync_events: number }> {
  const retentionDays = Math.max(1, Math.floor(opts.retentionDays))
  // Use a parameterised interval so a misconfigured env can't inject
  // SQL via the `interval 'N days'` literal. Casting through
  // `make_interval` keeps the value typed as an integer day count.
  const outbox = await client.query<{ count: number }>(
    `with d as (
       delete from mutation_outbox
        where applied_at is not null
          and applied_at < now() - make_interval(days => $1)
        returning 1
     )
     select count(*)::int as count from d`,
    [retentionDays],
  )
  const sync = await client.query<{ count: number }>(
    `with d as (
       delete from sync_events
        where applied_at is not null
          and applied_at < now() - make_interval(days => $1)
        returning 1
     )
     select count(*)::int as count from d`,
    [retentionDays],
  )
  return {
    mutation_outbox: outbox.rows[0]?.count ?? 0,
    sync_events: sync.rows[0]?.count ?? 0,
  }
}

/**
 * Mark outbox rows whose attempt_count has reached the retry cap as
 * 'dead'. Run once per heartbeat at the start of the drain so a stuck
 * row never gets re-claimed. Returns the number of rows dead-lettered.
 *
 * Pairs with the MUTATION_MAX_RETRIES env knob in worker.ts.
 */
export async function deadLetterStaleOutbox(
  client: QueueClient,
  companyId: string,
  maxRetries: number,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `with d as (
       update mutation_outbox
         set status = 'dead', applied_at = now()
         where company_id = $1
           and status in ('pending', 'processing')
           and attempt_count >= $2
         returning 1
     )
     select count(*)::int as count from d`,
    [companyId, maxRetries],
  )
  return result.rows[0]?.count ?? 0
}

export {
  processLockLaborEntries,
  LOCK_LABOR_ENTRIES_MAX_ATTEMPTS,
  type LockLaborEntriesAction,
  type LockLaborEntriesPayload,
  type LockLaborEntriesSummary,
} from './pushers/lock-labor-entries.js'

export {
  processRentalBillingInvoicePush,
  type RentalBillingInvoicePushInput,
  type RentalBillingInvoicePushResult,
  type RentalBillingInvoicePushFn,
  type RentalBillingInvoicePushSummary,
} from './pushers/rental-billing-invoice.js'

export {
  processRentalInvoicePush,
  type RentalInvoicePushInput,
  type RentalInvoicePushResult,
  type RentalInvoicePushFn,
  type RentalInvoicePushSummary,
} from './pushers/rental-cadence-invoice.js'

export {
  processEstimatePush,
  type EstimatePushInput,
  type EstimatePushResult,
  type EstimatePushFn,
  type EstimatePushSummary,
} from './pushers/estimate-push.js'

export {
  processQboPull,
  type QboPullInput,
  type QboPullResult,
  type QboPullFn,
  type QboPullSummary,
} from './pushers/qbo-pull.js'

export interface QueueClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>
}

export interface ReleasableQueueClient extends QueueClient {
  release(): void
}

export interface QueuePool {
  connect(): Promise<ReleasableQueueClient>
}

export interface TraceContext {
  sentry_trace: string | null
  sentry_baggage: string | null
  request_id: string | null
  capture_session_id?: string | null
}

export type ProcessedOutboxRow = {
  id: string
  entity_type: string
  entity_id: string
  mutation_type: string
  attempt_count: number
  created_at: string
} & TraceContext

export type ProcessedSyncEventRow = {
  id: string
  entity_type: string
  entity_id: string
  direction: string
  attempt_count: number
  created_at: string
} & TraceContext

export type QuarantinedOutboxRow = {
  id: string
  entity_type: string
  entity_id: string
  mutation_type: string
}

export type QueueProcessResult = {
  processedOutboxCount: number
  processedSyncEventCount: number
  outbox: ProcessedOutboxRow[]
  syncEvents: ProcessedSyncEventRow[]
  /** Rows parked as 'failed' because NO handler (generic or dedicated) claims their mutation_type. */
  quarantinedOutboxCount: number
  quarantinedOutbox: QuarantinedOutboxRow[]
}

// ---------------------------------------------------------------------------
// OUTBOX CONTRACT (inverted 2026-06-12).
//
// The generic drain (processOutboxBatch) marks rows 'applied' WITHOUT doing
// any work — that is only correct for mutation_types that are pure
// audit-trail / sync-feed anchors. Historically the drain applied EVERYTHING
// except a hand-maintained exclusion list, so any dedicated job type missing
// from that list (takeoff_to_bid, voice_to_log, welcome_email,
// damage_charge_invoice_push were all missing) was silently swallowed with a
// green audit trail whenever its lane was paused, its runner was behind the
// backlog, or the row was enqueued mid-heartbeat.
//
// The contract is now an explicit ALLOWLIST:
//   - GENERIC_APPLY_MUTATION_TYPES (+ prefixes) — genuinely-generic
//     audit-anchor types the generic drain may apply with no work.
//   - DEDICATED_HANDLER_MUTATION_TYPES — claimed only by their dedicated
//     runner; the generic drain never touches them.
//   - Anything else is UNROUTABLE and fails loudly:
//     quarantineUnroutableOutbox() parks the row at status='failed' with an
//     instructive error instead of lying with status='applied'.
//
// The conformance ratchet lives in
// apps/worker/src/outbox-conformance.test.ts: every mutation_type literal
// enqueued anywhere in the repo must be in exactly one of the two lists.
// ---------------------------------------------------------------------------

// Mutation types the generic drain may mark 'applied' with NO work. These are
// audit-trail / sync-feed anchors written by recordMutationLedger (apps/api),
// recordLedger (worker), or direct inserts — the mutation_outbox row IS the
// artifact; no downstream system performs work keyed on it. Enumerated from
// every enqueue site in the repo on 2026-06-12 (see the conformance test).
export const GENERIC_APPLY_MUTATION_TYPES = [
  // recordMutationLedger default (`action`) vocabulary — CRUD-ish ledger
  // anchors emitted by the API route handlers.
  'accepted',
  'apply',
  'approve',
  'bill',
  'calibrate',
  'closeout',
  'closeout:post_mortem',
  'copy_week_clone',
  'create',
  'created',
  'decline',
  'declined',
  'delete',
  'dismiss',
  'freeze',
  'import',
  'invoice',
  'parse_result',
  'photo_add',
  'photo_remove',
  'push-qbo',
  'recompute',
  'replace',
  'reschedule',
  'respond_message',
  'restore',
  'return',
  'revoked',
  'set_margin',
  'stage_message',
  'stage_transcript',
  'submit',
  'sync',
  'transfer',
  'unverify_scale',
  'update',
  'upsert',
  'verify_scale',
  'version',
  // rental_request APPROVE audit anchor — the route creates the rentals
  // inline; the outbox row documents "this APPROVE → these rentals"
  // (apps/api/src/routes/rental-requests.ts).
  'create_rental_from_request',
  // qbo_sync_run START_SYNC anchor — the route still performs the QBO sync
  // inline and emits SYNC_SUCCEEDED/FAILED itself; the outbox row exists so
  // the work can move to a worker drain in a follow-up
  // (packages/workflows/src/qbo-sync-run.ts header). If that drain ships,
  // move 'run_qbo_sync' to DEDICATED_HANDLER_MUTATION_TYPES.
  'run_qbo_sync',
] as const

// Prefix-matched generic types. `event:<rental_event>` rows are per-transition
// audit anchors from apps/api/src/routes/rental-events.ts (action =
// `event:${eventType.toLowerCase()}`).
export const GENERIC_APPLY_MUTATION_TYPE_PREFIXES = ['event:'] as const

/** SQL LIKE patterns for the prefix allowlist (bound as a text[] param). */
function genericPrefixLikePatterns(): string[] {
  return GENERIC_APPLY_MUTATION_TYPE_PREFIXES.map((prefix) => `${prefix}%`)
}

/** True when the generic apply-with-no-work drain is allowed to apply this type. */
export function isGenericApplyMutationType(mutationType: string): boolean {
  if ((GENERIC_APPLY_MUTATION_TYPES as readonly string[]).includes(mutationType)) return true
  return GENERIC_APPLY_MUTATION_TYPE_PREFIXES.some((prefix) => mutationType.startsWith(prefix))
}

// mutation_types claimed by dedicated handlers, NOT by the generic drain.
// Adding a new dedicated handler? Add its mutation_type here AND to the
// runner registry in apps/worker/src/outbox-contract.ts (the conformance
// test keeps the two in lockstep).
export const DEDICATED_HANDLER_MUTATION_TYPES = [
  'post_qbo_invoice',
  // Rental cadence invoice push — drained by apps/worker/src/runners/
  // rental-invoice-push.ts → processRentalInvoicePush (the queue handler lives
  // in pushers/rental-cadence-invoice.ts). Marking it dedicated keeps the
  // generic drain from claiming the row and marking it 'applied' WITHOUT
  // pushing to QBO / dispatching the INVOICE_QUEUED/INVOICE_POSTED cadence
  // transitions — the same silent-data-drop footgun this list guards.
  'post_rental_invoice',
  'post_qbo_estimate',
  'lock_labor_entries',
  'post_qbo_time_activities',
  'notify_worker_resolution',
  'notify_estimator_escalation',
  'notify_foreman_assignment',
  // Owner-denied field request → foreman feedback notification — drained by
  // apps/worker/src/field-event-notifier.ts. Dedicated so the generic drain
  // can't mark the row applied without inserting the notifications row that
  // closes the denial → /foreman/denied/:id feedback loop.
  'notify_field_request_denied',
  // Blueprint storage GC — drained by apps/worker/src/runners/
  // blueprint-storage-gc.ts. Marking it dedicated keeps the generic
  // drain from racing the GC runner (the generic drain just marks
  // applied without actually deleting the Spaces object).
  'delete_blueprint_storage_object',
  // Context handoff dispatch — drained by apps/worker/src/runners/
  // context-work-dispatch.ts so the generic drain cannot mark the
  // Mesh handoff applied before an agent system has actually accepted it.
  'dispatch_mesh_work_request',
  // Crew-schedule confirm side effects — drained by apps/worker/src/runners/
  // crew-schedule-confirm.ts (processCrewScheduleConfirm), which materializes
  // confirmed labor_entries / bumps projects.version and fans out the foreman
  // decline notification. Without these the generic drain would claim the row
  // and mark it 'applied' without doing the work, silently dropping labor
  // materialization — and every auto-confirmed new assignment now enqueues a
  // materialize_labor_entries row, so the race is on the hot path.
  'materialize_labor_entries',
  'notify_foreman_decline',
  // QBO reference-data pull (customers + items + classes backfill) —
  // drained by apps/worker/src/runners/qbo-pull.ts (processQboPull). Without
  // this entry the generic drain (processOutboxBatch) would claim the row and
  // mark it 'applied' WITHOUT performing the pull — a silent data-drop, the
  // exact footgun this exclusion list warns about.
  'pull_qbo_reference',
  // Async debug-bundle enrichment — drained by apps/worker/src/runners/
  // debug-bundle.ts (processAssembleDebugBundle). Enqueued at app-issue capture
  // finalize. Without this entry the generic drain would claim the row and mark
  // it 'applied' WITHOUT running the Sentry/Axiom pulls or writing the
  // debug_bundle capture_artifact — a silent enrichment-drop, the same footgun.
  'assemble_debug_bundle',
  // AI takeoff→bid agent — drained by apps/worker/src/runners/takeoff-to-bid.ts
  // (drainAgentMutations over takeoff-to-bid-agent.ts). Was MISSING from this
  // list until 2026-06-12: the generic drain could mark the row 'applied'
  // without running the agent whenever the takeoff_to_bid lane was paused or
  // the row landed mid-heartbeat.
  'takeoff_to_bid',
  // AI voice→daily-log agent — drained by apps/worker/src/runners/voice-to-log.ts.
  // Same missing-from-the-list silent-drop class as takeoff_to_bid.
  'voice_to_log',
  // Onboarding welcome email — drained by apps/worker/src/runners/welcome-email.ts.
  // Same missing-from-the-list class: a paused welcome_email lane (or a
  // backlogged heartbeat) let the generic drain mark the row 'applied' and the
  // email never sent.
  'welcome_email',
  // Damage-charge → QBO invoice push — drained by apps/worker/src/runners/
  // damage-charges.ts (processDamageChargeInvoicePush). Was MISSING: a QBO
  // circuit-open pause (lane-health-keeper pauses the damage_charges lane)
  // let the generic drain convert queued pushes into falsely-applied no-ops.
  'damage_charge_invoice_push',
  // Estimate-share delivery email — drained by apps/worker/src/runners/
  // estimate-share-email.ts. Enqueued by POST /api/projects/:id/estimate/share
  // (apps/api/src/routes/estimate-shares-admin.ts). Before 2026-06-12 this
  // type had NO handler anywhere and the generic drain stamped it 'applied'
  // while the customer email never sent.
  'send_estimate_share',
  // Async AI blueprint capture — drained by apps/worker/src/runners/
  // takeoff-capture.ts. Enqueued by POST /api/projects/:id/takeoff-drafts/
  // capture for LIVE blueprint_vision runs (the route inserts the draft at
  // capture_status='processing' and the runner executes the Gemini/Anthropic
  // pipeline, writing result + provenance + real token usage, or marking the
  // draft failed). If the generic drain could claim this row the draft would
  // sit at 'processing' forever with a green 'applied' audit trail — the
  // exact silent-drop class this list exists to prevent.
  'takeoff_capture_pipeline',
] as const

/**
 * Append one row to workflow_event_log from inside a worker tx. Used by
 * dedicated handlers when emitting POST_SUCCEEDED / POST_FAILED so the
 * event log captures worker transitions, not just human ones.
 *
 * The unique (entity_id, state_version) constraint protects against
 * duplicate writes if a worker tx retries after partial commit. A
 * caller that hits the constraint should treat the event as already
 * recorded and continue.
 *
 * The `trace` param carries the W3C sentry-trace/baggage + request_id
 * that the originating API request stamped on the outbox row. The
 * dedicated handlers below pull these fields off the claimed outbox row
 * and pass them through so the worker-emitted POST_SUCCEEDED row is
 * linked to the same trace as the SPA → API → outbox → worker chain.
 * Migration 079 adds sentry_baggage so the full W3C pair lands here.
 */
export async function appendWorkflowEvent(
  client: QueueClient,
  args: {
    companyId: string
    workflowName: string
    schemaVersion: number
    entityType: string
    entityId: string
    /** state_version BEFORE the transition. */
    stateVersion: number
    eventType: string
    eventPayload: Record<string, unknown>
    snapshotAfter: Record<string, unknown>
    actorUserId?: string | null
    trace?: TraceContext
  },
): Promise<void> {
  const sentryTrace = args.trace?.sentry_trace ?? null
  const sentryBaggage = args.trace?.sentry_baggage ?? null
  const requestId = args.trace?.request_id ?? null
  const captureSessionId = args.trace?.capture_session_id ?? null
  // Shared INSERT builder — same column list as the API path
  // (recordWorkflowEvent). The worker path differs only in: trace context
  // comes off the claimed outbox row (args.trace), and conflict handling is
  // idempotent `do nothing` so a retried drain is a safe no-op.
  const { text, values } = buildWorkflowEventLogInsert(
    {
      companyId: args.companyId,
      workflowName: args.workflowName,
      schemaVersion: args.schemaVersion,
      entityType: args.entityType,
      entityId: args.entityId,
      stateVersion: args.stateVersion,
      eventType: args.eventType,
      eventPayload: args.eventPayload,
      snapshotAfter: args.snapshotAfter,
      actorUserId: args.actorUserId ?? null,
      requestId,
      sentryTrace,
      sentryBaggage,
      captureSessionId,
    },
    { onConflict: 'do_nothing' },
  )
  await client.query(text, values)
}

export async function processOutboxBatch(
  client: QueueClient,
  companyId: string,
  limit: number,
): Promise<ProcessedOutboxRow[]> {
  const claimed = await client.query<{ id: string }>(
    `
    update mutation_outbox
    set
      status = 'processing',
      attempt_count = attempt_count + 1,
      -- Exponential backoff + jitter (was a flat 5 min for every retry). Delay
      -- doubles per prior attempt off a 5s base, capped at 6h, exponent capped
      -- at 16 to avoid power() overflow before the dead-letter sweep retires the
      -- row. 50-100% jitter de-syncs a thundering herd. attempt_count here is the
      -- pre-increment (prior-attempt) count, so the first retry is ~2.5-5s.
      next_attempt_at = now() + (
        least(interval '6 hours', interval '5 seconds' * power(2, least(attempt_count, 16)))
        * (0.5 + random() * 0.5)
      ),
      error = null
    where id in (
      select id
      from mutation_outbox
      where company_id = $1
        -- INVERTED CONTRACT: the apply-with-no-work drain only ever touches
        -- the explicit generic allowlist. Dedicated-runner types and unknown
        -- types are structurally unreachable here, no matter what lanes are
        -- paused or how deep the backlog is.
        and (
          mutation_type = any($3::text[])
          or mutation_type like any($4::text[])
        )
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and next_attempt_at <= now())
        )
      order by next_attempt_at asc, created_at asc
      limit $2
      for update skip locked
    )
    returning id
    `,
    [companyId, limit, [...GENERIC_APPLY_MUTATION_TYPES], genericPrefixLikePatterns()],
  )

  const ids = claimed.rows.map((row) => row.id)
  if (!ids.length) return []

  const applied = await client.query<ProcessedOutboxRow>(
    `
    update mutation_outbox
    set status = 'applied', applied_at = now(), error = null
    where company_id = $1 and id = any($2::uuid[])
    returning id, entity_type, entity_id, mutation_type, attempt_count, created_at,
      sentry_trace, sentry_baggage, request_id, capture_session_id
    `,
    [companyId, ids],
  )
  return applied.rows
}

/**
 * Park every due outbox row whose mutation_type has NO registered handler —
 * neither in the generic apply-with-no-work allowlist nor claimed by a
 * dedicated runner. Before the 2026-06-12 contract inversion these rows were
 * silently marked 'applied' by the generic drain; now they FAIL LOUDLY:
 * status='failed' with an instructive error, applied_at stays NULL.
 *
 * 'failed' is the established parked-terminal outbox state (it is never
 * re-claimed by any drain) — the row stays visible in /api/sync/outbox and
 * /api/system/mutation-outbox until an operator registers a handler (or
 * allowlists the type) and re-arms the row.
 *
 * Rows mid-lease for a dedicated runner are untouched: the predicate skips
 * every type in DEDICATED_HANDLER_MUTATION_TYPES, and only rows whose
 * next_attempt_at has elapsed are considered.
 */
export async function quarantineUnroutableOutbox(
  client: QueueClient,
  companyId: string,
): Promise<QuarantinedOutboxRow[]> {
  const result = await client.query<QuarantinedOutboxRow>(
    `
    update mutation_outbox
    set status = 'failed',
        error = 'outbox-contract: no handler registered for mutation_type "' || mutation_type
          || '" — not in GENERIC_APPLY_MUTATION_TYPES and not in DEDICATED_HANDLER_MUTATION_TYPES. '
          || 'Register a dedicated runner (apps/worker/src/outbox-contract.ts) or allowlist the type '
          || '(packages/queue/src/index.ts), then re-arm this row.',
        updated_at = now()
    where company_id = $1
      and status in ('pending', 'processing')
      and next_attempt_at <= now()
      and not (
        mutation_type = any($2::text[])
        or mutation_type like any($3::text[])
      )
      and mutation_type <> all($4::text[])
    returning id, entity_type, entity_id, mutation_type
    `,
    [companyId, [...GENERIC_APPLY_MUTATION_TYPES], genericPrefixLikePatterns(), [...DEDICATED_HANDLER_MUTATION_TYPES]],
  )
  return result.rows
}

export async function processSyncEventBatch(
  client: QueueClient,
  companyId: string,
  limit: number,
): Promise<ProcessedSyncEventRow[]> {
  const claimed = await client.query<{ id: string }>(
    `
    update sync_events
    set
      status = 'processing',
      attempt_count = attempt_count + 1,
      -- Exponential backoff + jitter (was a flat 5 min for every retry). Delay
      -- doubles per prior attempt off a 5s base, capped at 6h, exponent capped
      -- at 16 to avoid power() overflow before the dead-letter sweep retires the
      -- row. 50-100% jitter de-syncs a thundering herd. attempt_count here is the
      -- pre-increment (prior-attempt) count, so the first retry is ~2.5-5s.
      next_attempt_at = now() + (
        least(interval '6 hours', interval '5 seconds' * power(2, least(attempt_count, 16)))
        * (0.5 + random() * 0.5)
      ),
      error = null
    where id in (
      select id
      from sync_events
      where company_id = $1
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and next_attempt_at <= now())
        )
      order by next_attempt_at asc, created_at asc
      limit $2
      for update skip locked
    )
    returning id
    `,
    [companyId, limit],
  )

  const ids = claimed.rows.map((row) => row.id)
  if (!ids.length) return []

  const applied = await client.query<ProcessedSyncEventRow>(
    `
    update sync_events
    set status = 'applied', applied_at = now(), error = null
    where company_id = $1 and id = any($2::uuid[])
    returning id, entity_type, entity_id, direction, attempt_count, created_at,
      sentry_trace, sentry_baggage, request_id, capture_session_id
    `,
    [companyId, ids],
  )
  return applied.rows
}

export async function processQueueWithClient(
  client: QueueClient,
  companyId: string,
  limit = 25,
): Promise<QueueProcessResult> {
  // Quarantine FIRST so a just-enqueued unroutable row fails loudly in the
  // same heartbeat instead of sitting pending behind the claim window.
  const quarantined = await quarantineUnroutableOutbox(client, companyId)
  const outboxRows = await processOutboxBatch(client, companyId, limit)
  const syncEventRows = await processSyncEventBatch(client, companyId, limit)

  if (outboxRows.length || syncEventRows.length) {
    await client.query(
      `
      update integration_connections
      set last_synced_at = now(), status = 'connected', version = version + 1
      where company_id = $1
        and provider in ('qbo', 'demo')
      `,
      [companyId],
    )
  }

  return {
    processedOutboxCount: outboxRows.length,
    processedSyncEventCount: syncEventRows.length,
    outbox: outboxRows,
    syncEvents: syncEventRows,
    quarantinedOutboxCount: quarantined.length,
    quarantinedOutbox: quarantined,
  }
}

export async function processQueue(pool: QueuePool, companyId: string, limit = 25): Promise<QueueProcessResult> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await processQueueWithClient(client, companyId, limit)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Mark a single outbox row failed in its own transaction. Used after a
 * per-row work tx has been rolled back so the failure is recorded even
 * when the inner catch path's recovery work itself threw.
 *
 * HONESTY NOTE (2026-06-12): status='failed' is a PARKED-TERMINAL state.
 * No drain in the codebase claims 'failed' rows (every claim filters
 * status in ('pending','processing')), so this function used to lie when
 * it advertised a 15-minute retry via next_attempt_at — nothing ever
 * performed it. The phantom next_attempt_at bump is gone; a parked row
 * only runs again when something re-arms it back to 'pending' (a human
 * workflow RETRY_POST re-upserting the same idempotency_key, or a
 * re-arm endpoint like the QBO backfill re-click in routes/qbo.ts).
 *
 * Best-effort: if even this update can't succeed, the row is still under
 * the claim lease (status='processing', next_attempt_at=+5min) and WILL
 * be re-claimed once that lease elapses.
 *
 * Exported for use by the pusher modules under `./pushers/`.
 */
export async function markOutboxRowFailedFresh(
  client: QueueClient,
  companyId: string,
  outboxId: string,
  errorMessage: string,
): Promise<void> {
  try {
    await client.query('begin')
    await client.query(
      `update mutation_outbox
         set status = 'failed', error = $3, updated_at = now()
       where company_id = $1 and id = $2`,
      [companyId, outboxId, errorMessage.slice(0, 1000)],
    )
    await client.query('commit')
  } catch (markErr) {
    await client.query('rollback').catch(() => {})
    // Re-throw so the caller can log it; the row is still leased as
    // 'processing' and will be re-claimed once next_attempt_at elapses
    // (the original claim already set this).
    throw markErr
  }
}

export {
  processAssembleDebugBundle,
  assembleDebugBundle,
  fetchSentryEnrichment,
  fetchAxiomEnrichment,
  type AssembleDebugBundlePayload,
  type AssembleDebugBundleInput,
  type DebugBundle,
  type DebugBundleSummary,
  type SentryEnrichment,
  type AxiomEnrichment,
} from './pushers/debug-bundle.js'
