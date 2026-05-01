// Notification drain extracted from worker.ts so the Clerk → email hydration
// path is unit-testable. The worker still owns the pool, the email config,
// and the Clerk resolver wiring; this module is a pure function of
// (db client, sendEmail, resolver, config).
//
// Behavior:
//   1. Claim N pending rows under FOR UPDATE SKIP LOCKED (caller's tx).
//   2. For each row:
//      - If it has a recipient_email already, send.
//      - If it only has recipient_clerk_user_id, resolve via Clerk:
//          * email      → persist hydrated email AND send
//          * not_found  → mark failed reason=clerk_user_not_found
//          * rate_limit → leave pending, bump attempt_count, short backoff
//          * unreachable→ leave pending until N attempts, then DLQ
//      - If neither: legacy "broadcast" path keeps marking sent so the
//        backlog doesn't loop forever. (Real broadcasts use a separate
//        fan-out path; rows without either field today are stale fixtures.)

import type { Logger } from '@sitelayer/logger'
import type { EmailConfig, EmailMessage, sendEmail as sendEmailFn } from './email.js'
import type { ClerkResolver, EmailResolution } from './clerk-hydrate.js'

export type PendingNotificationRow = {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  recipient_email: string | null
  kind: string
  subject: string
  body_text: string
  body_html: string | null
  attempt_count: number
}

// Minimal subset of pg's PoolClient/Client surface used here. Lets tests pass
// a fake without pulling pg into the test boundary.
export interface NotificationDbClient {
  query<R = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<{ rows: R[] }>
}

export interface DrainNotificationsConfig {
  /** Max rows to claim in one batch. */
  limit: number
  /** Bail out early if this many sends fail back-to-back (provider outage). */
  providerFailureThreshold: number
  /** Hard ceiling on attempt_count before a row becomes 'failed'. */
  maxAttempts: number
  /** Email provider config passed through to sendEmail. */
  emailConfig: EmailConfig
  /** Clerk resolver — null disables hydration (tests / no-Clerk tiers). */
  clerkResolver: ClerkResolver | null
}

export interface DrainNotificationsDeps {
  client: NotificationDbClient
  sendEmail: typeof sendEmailFn
  logger: Logger
}

export interface DrainNotificationsResult {
  processed: number
  sent: number
  failed: number
  shortCircuited: boolean
  /** Subset of `processed` whose row stayed pending (e.g. Clerk 429). */
  deferred: number
  /** Subset of `processed` whose Clerk hydration found a real address. */
  hydrated: number
}

const RATE_LIMITED_BACKOFF_SECONDS = 60
const NOT_FOUND_REASON = 'clerk_user_not_found'
const UNREACHABLE_REASON = 'clerk_unreachable'

function backoffSecondsFor(nextAttemptCount: number): number {
  return Math.min(60 * 60 * 24, 300 * Math.pow(2, nextAttemptCount))
}

async function markSent(client: NotificationDbClient, id: string): Promise<void> {
  await client.query(`update notifications set status = 'sent', sent_at = now(), error = null where id = $1`, [id])
}

async function persistHydratedEmail(client: NotificationDbClient, id: string, email: string): Promise<void> {
  await client.query(`update notifications set recipient_email = $2 where id = $1`, [id, email])
}

async function markFailedWithReason(
  client: NotificationDbClient,
  id: string,
  attemptCount: number,
  reason: string,
): Promise<void> {
  await client.query(
    `update notifications
     set status = 'failed',
         attempt_count = $2,
         error = $3
     where id = $1`,
    [id, attemptCount, reason],
  )
}

async function deferRow(
  client: NotificationDbClient,
  id: string,
  attemptCount: number,
  backoffSeconds: number,
  reason: string,
): Promise<void> {
  await client.query(
    `update notifications
     set status = 'pending',
         attempt_count = $2,
         next_attempt_at = now() + ($3 || ' seconds')::interval,
         error = $4
     where id = $1`,
    [id, attemptCount, backoffSeconds, reason.slice(0, 2000)],
  )
}

async function applyClerkUnreachable(
  client: NotificationDbClient,
  row: PendingNotificationRow,
  errorMessage: string,
  maxAttempts: number,
): Promise<{ deferred: boolean }> {
  const nextAttempt = row.attempt_count + 1
  if (nextAttempt >= maxAttempts) {
    await markFailedWithReason(client, row.id, nextAttempt, UNREACHABLE_REASON)
    return { deferred: false }
  }
  await deferRow(client, row.id, nextAttempt, backoffSecondsFor(nextAttempt), `${UNREACHABLE_REASON}: ${errorMessage}`)
  return { deferred: true }
}

async function attemptSend(
  deps: DrainNotificationsDeps,
  config: DrainNotificationsConfig,
  row: PendingNotificationRow,
  to: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const message: EmailMessage = {
    to,
    subject: row.subject,
    text: row.body_text,
  }
  if (row.body_html) message.html = row.body_html
  try {
    await deps.sendEmail(message, { config: config.emailConfig })
    return { ok: true }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    return { ok: false, error: errorMessage }
  }
}

async function applySendFailure(
  client: NotificationDbClient,
  row: PendingNotificationRow,
  errorMessage: string,
  maxAttempts: number,
): Promise<{ status: 'pending' | 'failed' }> {
  const nextAttempt = row.attempt_count + 1
  const exceeded = nextAttempt >= maxAttempts
  const nextStatus = exceeded ? 'failed' : 'pending'
  const backoff = backoffSecondsFor(nextAttempt)
  await client.query(
    `update notifications
     set status = $2,
         attempt_count = $3,
         next_attempt_at = now() + ($4 || ' seconds')::interval,
         error = $5
     where id = $1`,
    [row.id, nextStatus, nextAttempt, backoff, errorMessage.slice(0, 2000)],
  )
  return { status: nextStatus }
}

/**
 * Resolve `recipient_email`. If the row already has one, return it. Otherwise
 * call Clerk and either hydrate the row or apply the appropriate failure /
 * deferral side effects. Returns null when no further send should happen.
 */
async function ensureRecipientEmail(
  deps: DrainNotificationsDeps,
  config: DrainNotificationsConfig,
  row: PendingNotificationRow,
): Promise<{ email: string; hydrated: boolean } | { email: null; deferred: boolean; failed: boolean }> {
  if (row.recipient_email) {
    return { email: row.recipient_email, hydrated: false }
  }
  if (!row.recipient_clerk_user_id) {
    // No recipient at all — caller handles legacy broadcast.
    return { email: null, deferred: false, failed: false }
  }

  if (!config.clerkResolver) {
    // Clerk hydration disabled but row needs it — defer rather than burn an
    // attempt. This keeps test/local tiers from silently DLQing rows that
    // would deliver in prod.
    const nextAttempt = row.attempt_count + 1
    await deferRow(deps.client, row.id, nextAttempt, backoffSecondsFor(nextAttempt), 'clerk_resolver_disabled')
    deps.logger.warn(
      { id: row.id, kind: row.kind, clerk_user_id: row.recipient_clerk_user_id },
      '[notifications] clerk hydration disabled; deferring',
    )
    return { email: null, deferred: true, failed: false }
  }

  let resolution: EmailResolution
  try {
    resolution = await config.clerkResolver.resolveEmailForClerkUser(row.recipient_clerk_user_id)
  } catch (err) {
    // Resolver itself shouldn't throw, but defend in depth.
    const errorMessage = err instanceof Error ? err.message : String(err)
    const result = await applyClerkUnreachable(deps.client, row, errorMessage, config.maxAttempts)
    deps.logger.warn(
      { id: row.id, kind: row.kind, err: errorMessage },
      '[notifications] clerk resolver threw; applied unreachable policy',
    )
    return { email: null, deferred: result.deferred, failed: !result.deferred }
  }

  switch (resolution.kind) {
    case 'email': {
      await persistHydratedEmail(deps.client, row.id, resolution.email)
      deps.logger.info(
        { id: row.id, kind: row.kind, clerk_user_id: row.recipient_clerk_user_id },
        '[notifications] hydrated email from clerk',
      )
      return { email: resolution.email, hydrated: true }
    }
    case 'not_found': {
      await markFailedWithReason(deps.client, row.id, row.attempt_count + 1, NOT_FOUND_REASON)
      deps.logger.warn(
        { id: row.id, kind: row.kind, clerk_user_id: row.recipient_clerk_user_id },
        '[notifications] clerk user not found; marking failed',
      )
      return { email: null, deferred: false, failed: true }
    }
    case 'rate_limited': {
      const nextAttempt = row.attempt_count + 1
      await deferRow(deps.client, row.id, nextAttempt, RATE_LIMITED_BACKOFF_SECONDS, 'clerk_rate_limited')
      deps.logger.warn(
        {
          id: row.id,
          kind: row.kind,
          clerk_user_id: row.recipient_clerk_user_id,
          attempt_count: nextAttempt,
        },
        '[notifications] clerk rate limited; deferring',
      )
      return { email: null, deferred: true, failed: false }
    }
    case 'unreachable': {
      const errorMessage = resolution.error instanceof Error ? resolution.error.message : String(resolution.error)
      const result = await applyClerkUnreachable(deps.client, row, errorMessage, config.maxAttempts)
      deps.logger.warn(
        {
          id: row.id,
          kind: row.kind,
          clerk_user_id: row.recipient_clerk_user_id,
          err: errorMessage,
          deferred: result.deferred,
        },
        '[notifications] clerk unreachable',
      )
      return { email: null, deferred: result.deferred, failed: !result.deferred }
    }
    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = resolution
      throw new Error(`unknown clerk resolution: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/**
 * Single-batch notification drain. Caller is responsible for opening and
 * committing the surrounding transaction; this matches the prior worker.ts
 * shape so behavior under FOR UPDATE SKIP LOCKED is preserved.
 */
export async function drainNotifications(
  deps: DrainNotificationsDeps,
  config: DrainNotificationsConfig,
): Promise<DrainNotificationsResult> {
  const { client, logger } = deps
  let processed = 0
  let sent = 0
  let failed = 0
  let deferred = 0
  let hydrated = 0
  let consecutiveFailures = 0
  let shortCircuited = false

  const claimed = await client.query<PendingNotificationRow>(
    `
      select id, company_id, recipient_clerk_user_id, recipient_email, kind, subject, body_text, body_html, attempt_count
      from notifications
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at asc, created_at asc
      limit $1
      for update skip locked
      `,
    [config.limit],
  )

  for (const row of claimed.rows) {
    if (consecutiveFailures >= config.providerFailureThreshold) {
      shortCircuited = true
      break
    }
    processed += 1

    // Hydrate (or short-circuit) the recipient email.
    const ensured = await ensureRecipientEmail(deps, config, row)
    if (ensured.email == null) {
      // Legacy broadcast: row had neither email nor clerk id. Keep marking
      // sent so the queue doesn't loop. Real fan-out lives elsewhere.
      if (!row.recipient_email && !row.recipient_clerk_user_id) {
        await markSent(client, row.id)
        sent += 1
        consecutiveFailures = 0
        logger.info({ id: row.id, kind: row.kind, recipient: 'broadcast' }, '[notifications] logged broadcast')
        continue
      }
      if (ensured.deferred) deferred += 1
      if (ensured.failed) failed += 1
      // Don't count Clerk-side failures against the provider circuit breaker
      // — that's reserved for the email sender being down.
      continue
    }

    if (ensured.hydrated) hydrated += 1

    const send = await attemptSend(deps, config, row, ensured.email)
    if (send.ok) {
      await markSent(client, row.id)
      sent += 1
      consecutiveFailures = 0
      continue
    }
    const result = await applySendFailure(client, row, send.error, config.maxAttempts)
    failed += 1
    consecutiveFailures += 1
    logger.warn(
      {
        id: row.id,
        kind: row.kind,
        attempt_count: row.attempt_count + 1,
        next_status: result.status,
        err: send.error,
      },
      '[notifications] send failed',
    )
  }

  if (shortCircuited) {
    logger.warn(
      {
        consecutive_failures: consecutiveFailures,
        processed,
        sent,
        failed,
        remaining: claimed.rows.length - processed,
      },
      '[notifications] short-circuited batch (suspected provider outage)',
    )
  }

  return { processed, sent, failed, shortCircuited, deferred, hydrated }
}
