import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { createClerkClient } from '@clerk/backend'
import webpush from 'web-push'
import { loadEmailConfig, sendEmail } from '../email.js'
import { clerkUserFetcherFromClient, createClerkResolver, type ClerkResolver } from '../clerk-hydrate.js'
import { drainNotifications as drainNotificationsBatch } from '../notifications.js'
import {
  ConsoleChannel,
  DefaultNotificationDispatcher,
  EmailChannel,
  TwilioSMSChannel,
  WebPushChannel,
  loadTwilioConfig,
  loadVapidConfig,
  type NotificationChannel,
  type NotificationDispatcher,
  type PushSubscriptionRow,
  type WebPushClient,
} from '../notification-channels.js'

export interface NotificationRunner {
  drain(): Promise<{
    processed: number
    sent: number
    failed: number
    shortCircuited: boolean
    deferred: number
    hydrated: number
  }>
}

export function createNotificationRunner(deps: { pool: Pool; logger: Logger }): NotificationRunner {
  const { pool, logger } = deps

  const notificationMaxAttemptsRaw = Number(process.env.NOTIFICATION_MAX_ATTEMPTS ?? 5)
  const NOTIFICATION_MAX_ATTEMPTS = Number.isFinite(notificationMaxAttemptsRaw)
    ? Math.max(1, Math.floor(notificationMaxAttemptsRaw))
    : 5
  const notificationBatchLimit = Number(process.env.NOTIFICATION_BATCH_LIMIT ?? 10)
  const emailConfig = loadEmailConfig()

  // If this many sends fail back-to-back in one batch, treat the email provider
  // as down and stop processing the rest of the batch. The unprocessed rows
  // stay locked under `FOR UPDATE SKIP LOCKED`, so on COMMIT they release with
  // their original next_attempt_at and get re-claimed in the next heartbeat.
  // This avoids burning every queued notification's attempt counter against a
  // total provider outage.
  const NOTIFICATION_PROVIDER_FAILURE_THRESHOLD = (() => {
    const n = Number(process.env.NOTIFICATION_PROVIDER_FAILURE_THRESHOLD ?? 3)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3
  })()

  // Clerk wiring. The notifications drain hydrates `recipient_email` from the
  // Clerk user id when the row was queued without an address. We fail loud at
  // startup when CLERK_SECRET_KEY is missing AND the worker is supposed to
  // drain notifications: silently marking those rows sent (the prior TODO
  // behavior) means real users miss real emails. CLAUDE.md operating rule:
  // don't fall back to silent localhost-style defaults.
  const NOTIFICATIONS_ENABLED = (process.env.NOTIFICATIONS_ENABLED ?? '1') !== '0'
  const clerkSecretKey = (process.env.CLERK_SECRET_KEY ?? '').trim()

  let clerkResolver: ClerkResolver | null = null
  if (NOTIFICATIONS_ENABLED) {
    if (!clerkSecretKey) {
      logger.fatal(
        { hint: 'set CLERK_SECRET_KEY or NOTIFICATIONS_ENABLED=0' },
        '[notifications] refusing to start: CLERK_SECRET_KEY required for clerk_user_id → email hydration',
      )
      process.exit(1)
    }
    const clerkClient = createClerkClient({ secretKey: clerkSecretKey })
    const cacheTtlRaw = Number(process.env.CLERK_EMAIL_CACHE_TTL_MS ?? 5 * 60 * 1000)
    const resolverOpts: Parameters<typeof createClerkResolver>[0] = {
      getUser: clerkUserFetcherFromClient(clerkClient),
    }
    if (Number.isFinite(cacheTtlRaw) && cacheTtlRaw > 0) {
      resolverOpts.cacheTtlMs = cacheTtlRaw
    }
    clerkResolver = createClerkResolver(resolverOpts)
    logger.info('[notifications] clerk hydration enabled')
  } else {
    logger.warn('[notifications] NOTIFICATIONS_ENABLED=0; clerk hydration skipped (rows requiring it will defer)')
  }

  // ---------------------------------------------------------------------------
  // Notification channel system (Phase 1C)
  //
  // Build the dispatcher once at boot from env. Channels self-disable when
  // their config is missing; the dispatcher's router falls back to email,
  // then defers, so the system gracefully degrades without dropping rows.
  // ---------------------------------------------------------------------------
  const vapidConfig = loadVapidConfig()
  const twilioConfig = loadTwilioConfig()

  const consoleChannel: NotificationChannel = new ConsoleChannel({ logger })
  const emailChannel: NotificationChannel = new EmailChannel({ emailConfig, sendEmail })
  const smsChannel: NotificationChannel | null = twilioConfig
    ? new TwilioSMSChannel({ config: twilioConfig, logger })
    : null

  // The static push channel only declares availability; per-(company, user)
  // instances handle actual sends so the subscription loader/pruner have
  // the right context. The static instance is reused for the
  // availability check inside the dispatcher.
  const staticPushChannel: NotificationChannel | null = vapidConfig
    ? new WebPushChannel(
        {
          vapid: vapidConfig,
          webpush: webpush as unknown as WebPushClient,
          loadSubscriptions: async () => [],
          pruneSubscription: async () => {},
          logger,
        },
        'static',
        'static',
      )
    : null

  function buildPushChannel(companyId: string, clerkUserId: string): NotificationChannel {
    return new WebPushChannel(
      {
        vapid: vapidConfig,
        webpush: vapidConfig ? (webpush as unknown as WebPushClient) : null,
        loadSubscriptions: async (cId, uId) => {
          const result = await pool.query<PushSubscriptionRow>(
            `select id, endpoint, p256dh, auth
               from push_subscriptions
              where company_id = $1 and clerk_user_id = $2
              order by last_seen_at desc`,
            [cId, uId],
          )
          return result.rows
        },
        pruneSubscription: async (subscriptionId) => {
          await pool.query(`delete from push_subscriptions where id = $1`, [subscriptionId])
        },
        logger,
      },
      companyId,
      clerkUserId,
    )
  }

  const dispatcher: NotificationDispatcher = new DefaultNotificationDispatcher({
    channels: {
      push: staticPushChannel,
      sms: smsChannel,
      email: emailChannel,
      console: consoleChannel,
    },
    buildPushChannel: vapidConfig ? buildPushChannel : null,
    hydrateEmail:
      NOTIFICATIONS_ENABLED && clerkResolver
        ? async (clerkUserId) => {
            const resolution = await clerkResolver!.resolveEmailForClerkUser(clerkUserId)
            return resolution.kind === 'email' ? resolution.email : null
          }
        : null,
    logger,
  })

  logger.info(
    {
      push: vapidConfig ? 'configured' : 'disabled',
      sms: twilioConfig ? 'configured' : 'disabled',
      email: emailConfig.provider,
    },
    '[notification-channels] dispatcher ready',
  )

  /**
   * Wrapper that opens a tx, calls into the extracted batch drainer, and commits.
   * The batch drainer holds the per-row logic (claim / hydrate / send / DLQ); see
   * `notifications.ts`.
   */
  async function drainNotifications(limit = notificationBatchLimit): Promise<{
    processed: number
    sent: number
    failed: number
    shortCircuited: boolean
    deferred: number
    hydrated: number
  }> {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const result = await drainNotificationsBatch(
        { client, sendEmail, logger },
        {
          limit,
          providerFailureThreshold: NOTIFICATION_PROVIDER_FAILURE_THRESHOLD,
          maxAttempts: NOTIFICATION_MAX_ATTEMPTS,
          emailConfig,
          clerkResolver,
          dispatcher,
        },
      )
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  return {
    drain: () => drainNotifications(),
  }
}
