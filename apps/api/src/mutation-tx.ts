import type { Pool, PoolClient } from 'pg'
import type pino from 'pino'
import { Sentry } from './instrument.js'
import { getRequestContext } from '@sitelayer/logger'
import { buildWorkflowEventLogInsert } from '@sitelayer/workflows'
import { isAuditableEntity, recordAudit } from './audit.js'
import { observeAudit } from './metrics.js'
import { HttpError } from './http-utils.js'
import { enqueueNotificationRow, listCompanyAdminIds, type EnqueueNotificationInput } from './notifications.js'

/** Postgres unique_violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

export type LedgerExecutor = Pick<Pool | PoolClient, 'query'>

let pool: Pool | null = null
let logger: pino.Logger | null = null

/** Wire the module to the live pg Pool + logger. Must be called during boot. */
export function attachMutationTx(deps: { pool: Pool; logger: pino.Logger }): void {
  pool = deps.pool
  logger = deps.logger
}

function requirePool(): Pool {
  if (!pool) throw new Error('mutation-tx: attachMutationTx() must be called before use')
  return pool
}

function getLogger(): pino.Logger | null {
  return logger
}

/** Pull the current Sentry trace headers, if any. */
export function currentTraceHeaders(): { sentryTrace: string | null; baggage: string | null } {
  try {
    const data = Sentry.getTraceData()
    return {
      sentryTrace: data['sentry-trace'] ?? null,
      baggage: data.baggage ?? null,
    }
  } catch {
    return { sentryTrace: null, baggage: null }
  }
}

/**
 * Run `fn` against a dedicated PoolClient inside BEGIN/COMMIT (or ROLLBACK on
 * throw). The intended use is to scope a domain mutation together with the
 * recordSyncEvent / recordMutationOutbox writes that ledger it, so a crash
 * between the mutation and the ledger row cannot orphan the mutation. Pass the
 * `client` to the helpers via their executor parameter.
 *
 * Pass `companyId` to bind `app.company_id` for the lifetime of the
 * transaction. Migration 066 reads this GUC in row-level security policies
 * so the database itself rejects cross-company writes once RLS is enabled.
 * `withMutationTx` is the canonical scoped-write seam; routes wired through
 * RouteContext.withMutationTx pass the active company automatically.
 */
export async function withMutationTx<T>(
  fnOrCompanyId: string | ((client: PoolClient) => Promise<T>),
  maybeFn?: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const explicitCompanyId = typeof fnOrCompanyId === 'string' ? fnOrCompanyId : null
  const fn = typeof fnOrCompanyId === 'string' ? maybeFn! : fnOrCompanyId
  // Fall back to the request-scoped company id stashed by server.ts after
  // getCompany() resolves. This keeps existing call sites (which call
  // withMutationTx(fn) with no company arg) compatible with the new RLS path.
  const companyId = explicitCompanyId ?? getRequestContext()?.companyId ?? null
  const client = await requirePool().connect()
  try {
    await client.query('begin')
    if (companyId) {
      // SET LOCAL is scoped to this tx; the connection returns to the pool clean.
      await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])
    }
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    try {
      await client.query('rollback')
    } catch {
      // best-effort: rollback failure shouldn't mask the original error
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * Read-side analog of withMutationTx: checks out a PoolClient, binds
 * `app.company_id` via SET LOCAL inside a read-only tx, runs `fn`, and
 * releases. Use this for any multi-statement read that should be scoped
 * to a single company under RLS (e.g. /api/bootstrap fan-out). Single
 * `pool.query()` calls don't need this — they go through the read-pool
 * helper wired in apps/api/src/lib/company-pool.ts.
 */
export async function withCompanyClient<T>(
  companyIdOrFn: string | ((client: PoolClient) => Promise<T>),
  maybeFn?: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const explicitCompanyId = typeof companyIdOrFn === 'string' ? companyIdOrFn : null
  const fn = typeof companyIdOrFn === 'string' ? maybeFn! : companyIdOrFn
  const companyId = explicitCompanyId ?? getRequestContext()?.companyId ?? null
  if (!companyId) {
    throw new Error('withCompanyClient: companyId required (no request context)')
  }
  const client = await requirePool().connect()
  try {
    await client.query('begin read only')
    await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    try {
      await client.query('rollback')
    } catch {
      // best-effort
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * Insert a row into `notifications`. The worker drains pending rows and sends
 * them via `sendEmail`. Rows with neither `recipientUserId` nor `recipientEmail`
 * are still written and logged via the console provider at send time. Errors
 * are logged but not rethrown: notifications are best-effort and should not
 * block the caller path.
 */
export async function enqueueNotification(input: EnqueueNotificationInput): Promise<{ id: string } | null> {
  try {
    return await enqueueNotificationRow(requirePool(), input)
  } catch (err) {
    getLogger()?.warn({ err, kind: input.kind, companyId: input.companyId }, '[notifications] enqueue failed')
    return null
  }
}

export async function enqueueAdminAlert(
  companyId: string,
  kind: string,
  subject: string,
  text: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const adminIds = await listCompanyAdminIds(requirePool(), companyId)
  if (adminIds.length === 0) {
    // Broadcast row — worker will log via console provider.
    await enqueueNotification({ companyId, kind, subject, text, payload })
    return
  }
  for (const clerkUserId of adminIds) {
    await enqueueNotification({
      companyId,
      recipientUserId: clerkUserId,
      kind,
      subject,
      text,
      payload,
    })
  }
}

export async function recordSyncEvent(
  companyId: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
  integrationConnectionId: string | null = null,
  opts: { status?: 'pending' | 'failed'; error?: string | null; executor?: LedgerExecutor } = {},
): Promise<void> {
  const executor: LedgerExecutor = opts.executor ?? requirePool()
  const { sentryTrace, baggage } = currentTraceHeaders()
  const requestId = getRequestContext()?.requestId ?? null
  const status = opts.status ?? 'pending'
  await executor.query(
    `
    insert into sync_events (
      company_id, integration_connection_id, direction, entity_type, entity_id, payload, status,
      sentry_trace, sentry_baggage, request_id, error
    )
    values ($1, $2, 'local', $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
    `,
    [
      companyId,
      integrationConnectionId,
      entityType,
      entityId,
      JSON.stringify(payload),
      status,
      sentryTrace,
      baggage,
      requestId,
      opts.error ?? null,
    ],
  )
  if (status === 'failed') {
    // Best-effort outside the caller's tx: alert delivery should not be able
    // to roll back a successfully-failed sync event. Errors are swallowed.
    const subject = `[Sitelayer] Sync failed: ${entityType}`
    const text = [
      `A sync event failed for ${entityType} ${entityId}.`,
      opts.error ? `Error: ${opts.error}` : 'No error detail was provided.',
      'Visit https://sitelayer.sandolab.xyz/ to investigate.',
    ].join('\n\n')
    await enqueueAdminAlert(companyId, 'sync_failure', subject, text, {
      entity_type: entityType,
      entity_id: entityId,
      error: opts.error ?? null,
    }).catch((err) => {
      getLogger()?.warn({ err, entityType, entityId }, '[notifications] sync_failure alert enqueue failed')
    })
  }
  if (isAuditableEntity(entityType)) {
    const action = typeof payload.action === 'string' ? payload.action : 'event'
    const after = (payload as Record<string, unknown>)[entityType] ?? payload
    try {
      await recordAudit(executor, {
        companyId,
        entityType,
        entityId,
        action,
        after,
        sentryTrace,
      })
      observeAudit(entityType, action)
    } catch (err) {
      getLogger()?.warn({ err, entityType, entityId, action }, 'audit insert failed')
    }
  }
}

export async function recordMutationOutbox(
  companyId: string,
  entityType: string,
  entityId: string,
  mutationType: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  deviceId = 'server',
  actorUserId: string | null = null,
  executor: LedgerExecutor = requirePool(),
): Promise<void> {
  const { sentryTrace, baggage } = currentTraceHeaders()
  const requestId = getRequestContext()?.requestId ?? null
  await executor.query(
    `
    insert into mutation_outbox (
      company_id, device_id, actor_user_id, entity_type, entity_id, mutation_type, payload, idempotency_key, status,
      sentry_trace, sentry_baggage, request_id
    )
    values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'pending', $9, $10, $11)
    on conflict (company_id, idempotency_key) do update
      set payload = excluded.payload,
          status = 'pending',
          attempt_count = mutation_outbox.attempt_count + 1,
          next_attempt_at = now(),
          sentry_trace = excluded.sentry_trace,
          sentry_baggage = excluded.sentry_baggage,
          request_id = excluded.request_id
    `,
    [
      companyId,
      deviceId,
      actorUserId,
      entityType,
      entityId,
      mutationType,
      JSON.stringify(payload),
      idempotencyKey,
      sentryTrace,
      baggage,
      requestId,
    ],
  )
}

export type LedgerArgs = {
  companyId: string
  entityType: string
  entityId: string
  action: string
  /** Domain row to embed in the default payloads. */
  row?: object | null
  /** Override the sync_event payload. Defaults to { action, [entityType]: row } when `row` is supplied. */
  syncPayload?: Record<string, unknown>
  /** Override the mutation_outbox payload. Defaults to `row` when supplied, else syncPayload. */
  outboxPayload?: Record<string, unknown>
  /** mutation_outbox.mutation_type (e.g. 'create' | 'update' | 'delete' | 'invoice'). Defaults to action. */
  mutationType?: string
  /** Idempotency key for mutation_outbox. Defaults to `${entityType}:${action}:${entityId}`. */
  idempotencyKey?: string
  integrationConnectionId?: string | null
  deviceId?: string
  actorUserId?: string | null
  syncStatus?: 'pending' | 'failed'
  syncError?: string | null
}

/**
 * Write a sync_event + mutation_outbox row in one logical step using the same
 * executor (typically a PoolClient inside withMutationTx). Replaces the
 * recurring 7-line pair of recordSyncEvent/recordMutationOutbox calls.
 *
 * The default payload shape mirrors what the existing call sites used:
 *   sync_event   payload = { action, [entityType]: row }
 *   outbox       payload = row
 * Override via syncPayload / outboxPayload when a handler needs more
 * context (e.g. {action: 'invoice', rental, days, amount}).
 */
export async function recordMutationLedger(executor: LedgerExecutor, args: LedgerArgs): Promise<void> {
  const { companyId, entityType, entityId, action, row } = args
  const syncPayload = args.syncPayload ?? { action, ...(row ? { [entityType]: row } : {}) }
  const outboxPayload = args.outboxPayload ?? (row ? (row as Record<string, unknown>) : syncPayload)
  const mutationType = args.mutationType ?? action
  const idempotencyKey = args.idempotencyKey ?? `${entityType}:${action}:${entityId}`

  await recordSyncEvent(companyId, entityType, entityId, syncPayload, args.integrationConnectionId ?? null, {
    executor,
    ...(args.syncStatus ? { status: args.syncStatus } : {}),
    ...(args.syncError !== undefined ? { error: args.syncError } : {}),
  })
  await recordMutationOutbox(
    companyId,
    entityType,
    entityId,
    mutationType,
    outboxPayload,
    idempotencyKey,
    args.deviceId ?? 'server',
    args.actorUserId ?? null,
    executor,
  )
}

/**
 * Append one row to workflow_event_log. Always called inside the same
 * tx that mutates the workflow row, so a crash between state update and
 * ledger insert is impossible. The caller passes the state_version that
 * the event was dispatched against (i.e. the version BEFORE the
 * transition); the unique (entity_id, state_version) constraint then
 * naturally rejects duplicate writes for the same transition.
 *
 * Replay tooling reads these rows in state_version order and feeds the
 * `event_payload` back through the registered reducer; `snapshot_after`
 * is the assertion target.
 */
export async function recordWorkflowEvent(
  executor: LedgerExecutor,
  args: {
    companyId: string
    workflowName: string
    schemaVersion: number
    entityType: string
    entityId: string
    stateVersion: number
    eventType: string
    eventPayload: object
    snapshotAfter: object
    actorUserId?: string | null
  },
): Promise<void> {
  // Pull both halves of the W3C trace propagation pair. Migration 079
  // added sentry_baggage so the workflow event log carries the full
  // sentry-trace + baggage context every other ledger table already
  // persists.
  const { sentryTrace, baggage } = currentTraceHeaders()
  const requestId = getRequestContext()?.requestId ?? null
  // Shared INSERT builder — single source of truth for the column list so
  // the API path and the worker path (queue/index.ts appendWorkflowEvent)
  // can't desync. This path sources trace context from ambient request
  // context and uses onConflict:'throw' so a duplicate transition surfaces
  // as the 409 below (human double-submit), not a silent no-op.
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
      sentryBaggage: baggage,
    },
    { onConflict: 'throw' },
  )
  try {
    await executor.query(text, values)
  } catch (err) {
    // The (entity_id, workflow_name, state_version) unique key (migration
    // 106) rejects a duplicate write for the SAME transition of the SAME
    // workflow — i.e. a replayed/double-submitted event at a state_version
    // that was already recorded. That is a stale-write conflict, not a
    // server fault, so surface it as a clean 409 rather than a bare 500.
    // (Migration 106 already removed the cross-workflow false collision that
    // used to throw here; this backstop preserves the single-workflow dedupe
    // semantics every workflow relies on.)
    if (isUniqueViolation(err)) {
      throw new HttpError(
        409,
        `workflow event already recorded for ${args.workflowName} at state_version ${args.stateVersion} — reload and retry`,
      )
    }
    throw err
  }
}
