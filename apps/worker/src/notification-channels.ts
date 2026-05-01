// Notification channels — Phase 1C abstraction layer.
//
// Replaces the email-only delivery path inside drainNotifications with a
// per-event-type channel router. The router reads notification_preferences
// for the recipient, maps the row's `kind` to a preference column, and
// dispatches to the matching channel adapter (push / sms / email / off /
// console). Channels self-disable when their env config is missing, in
// which case the router falls back to email so messages still land.
//
// Design rules (encoded in the router decisions, not just docs):
//   - 'off' is intentional silence; never fall back when the user picked it
//   - missing contact info or unconfigured channel falls back to email,
//     because the user *wanted* to be told and we don't have permission to
//     drop the message
//   - if email itself is unavailable (no provider + no console fallback),
//     the row is deferred so a later config fix delivers it
//
// Pure decision logic lives in `decideChannel()` so it can be tested
// without a DB or HTTP. The IO bridge is `loadRouteContext()` +
// `WebPushChannel`/`TwilioSMSChannel`/`EmailChannel`/`ConsoleChannel`.

import type { Logger } from '@sitelayer/logger'
import type { EmailConfig, EmailMessage, sendEmail as sendEmailFn } from './email.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelKind = 'push' | 'sms' | 'email' | 'console'

/** Per-event-type channel selection persisted in notification_preferences. */
export type ChannelPreference = 'push' | 'sms' | 'email' | 'off'

/**
 * The `kind` values on notifications that map to a preference column.
 * Anything else (legacy 'sync_failure', etc.) falls through to email
 * so existing alert paths keep working.
 */
export type RoutableNotificationKind =
  | 'assignment_change'
  | 'time_review_ready'
  | 'daily_log_reminder'
  | 'clock_anomaly'

const ROUTABLE_KINDS: ReadonlySet<string> = new Set<RoutableNotificationKind>([
  'assignment_change',
  'time_review_ready',
  'daily_log_reminder',
  'clock_anomaly',
])

export function isRoutableKind(kind: string): kind is RoutableNotificationKind {
  return ROUTABLE_KINDS.has(kind)
}

/** notification_preferences row shape — see migration 028. */
export interface NotificationPreferences {
  channel_assignment_change: ChannelPreference
  channel_time_review_ready: ChannelPreference
  channel_daily_log_reminder: ChannelPreference
  channel_clock_anomaly: ChannelPreference
  sms_phone: string | null
  email: string | null
}

/** Default preferences for users who haven't configured any. */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  channel_assignment_change: 'push',
  channel_time_review_ready: 'push',
  channel_daily_log_reminder: 'push',
  channel_clock_anomaly: 'push',
  sms_phone: null,
  email: null,
}

function preferenceFor(kind: RoutableNotificationKind, prefs: NotificationPreferences): ChannelPreference {
  switch (kind) {
    case 'assignment_change':
      return prefs.channel_assignment_change
    case 'time_review_ready':
      return prefs.channel_time_review_ready
    case 'daily_log_reminder':
      return prefs.channel_daily_log_reminder
    case 'clock_anomaly':
      return prefs.channel_clock_anomaly
  }
}

/** Channels that are configured and ready to send. */
export interface ChannelAvailability {
  push: boolean
  sms: boolean
  email: boolean
  /** Always true — console is the no-config fallback. */
  console: true
}

/** Resolved contact info for the recipient at decision time. */
export interface ChannelTarget {
  /** Push: count of registered subscriptions for this user. */
  pushSubscriptionCount: number
  /** SMS: phone from preferences. */
  smsPhone: string | null
  /** Email: prefs.email > clerk-hydrated email. */
  email: string | null
}

/**
 * Output of the pure router decision. Kept tightly typed so the drain
 * caller can pattern-match each outcome instead of branching on bools.
 */
export type RouteDecision =
  | { kind: 'silent'; reason: 'preference_off' }
  | { kind: 'broadcast' }
  | { kind: 'send'; channel: ChannelKind; target: ChannelTarget }
  | { kind: 'defer'; reason: string }
  | { kind: 'fail'; reason: string }

/**
 * Pure router. Takes the row's kind + the recipient's resolved
 * preferences/contact + which channels are configured, returns a
 * decision. Inputs:
 *   - kind: the notification's `kind` column
 *   - hasRecipient: false for legacy broadcast rows (no email + no
 *     clerk_user_id), which the drain handles separately
 *   - prefs: the resolved preferences (or DEFAULT_PREFERENCES)
 *   - target: resolved contact info (counts, phone, email)
 *   - availability: which channels have config
 *
 * The fallback ladder is: chosen → email → console. The router will
 * never silently choose console — falling all the way to console means
 * email is also unavailable, which deserves a deferral so a config fix
 * later delivers the message.
 */
export function decideChannel(
  kind: string,
  hasRecipient: boolean,
  prefs: NotificationPreferences,
  target: ChannelTarget,
  availability: ChannelAvailability,
): RouteDecision {
  if (!hasRecipient) {
    return { kind: 'broadcast' }
  }

  // Non-routable kinds (sync_failure, etc.) preserve the legacy email-only
  // behaviour. If email isn't configured, defer.
  if (!isRoutableKind(kind)) {
    if (availability.email && target.email) {
      return { kind: 'send', channel: 'email', target }
    }
    if (availability.email && !target.email) {
      return { kind: 'defer', reason: 'no_recipient_email' }
    }
    return { kind: 'defer', reason: 'no_email_provider_configured' }
  }

  const choice = preferenceFor(kind, prefs)

  if (choice === 'off') {
    return { kind: 'silent', reason: 'preference_off' }
  }

  if (choice === 'push') {
    if (availability.push && target.pushSubscriptionCount > 0) {
      return { kind: 'send', channel: 'push', target }
    }
    // Push fallback → email (per design rule: don't drop messages just
    // because the chosen channel happens to be unavailable).
    if (availability.email && target.email) {
      return { kind: 'send', channel: 'email', target }
    }
    return { kind: 'defer', reason: 'push_unavailable_no_email_fallback' }
  }

  if (choice === 'sms') {
    if (availability.sms && target.smsPhone) {
      return { kind: 'send', channel: 'sms', target }
    }
    if (availability.email && target.email) {
      return { kind: 'send', channel: 'email', target }
    }
    return { kind: 'defer', reason: 'sms_unavailable_no_email_fallback' }
  }

  // 'email'
  if (availability.email && target.email) {
    return { kind: 'send', channel: 'email', target }
  }
  return { kind: 'defer', reason: 'email_unavailable' }
}

// ---------------------------------------------------------------------------
// Channel adapters
// ---------------------------------------------------------------------------

export interface ChannelMessage {
  /** Human-readable subject. Push title; email subject; SMS prefix. */
  subject: string
  /** Plain-text body. SMS truncates; email + console use as-is. */
  bodyText: string
  /** Optional HTML body for email. */
  bodyHtml: string | null
  /** notifications.kind, passed for logging + push payload. */
  kind: string
  /** Arbitrary structured payload — pass through to push subscribers. */
  payload: Record<string, unknown>
}

export interface ChannelSendOk {
  ok: true
  channel: ChannelKind
  /** Provider id where available (e.g. Twilio SID, Resend id). */
  messageId?: string
  /** Deliveries that fanned out (push to N subscriptions). */
  delivered?: number
}

export interface ChannelSendErr {
  ok: false
  channel: ChannelKind
  error: string
  /** When the failure is transient (e.g. 5xx), router can defer; when
   * the contact is unreachable (410 Gone, hard SMS bounce), it can mark
   * failed without retry. */
  permanent: boolean
}

export type ChannelSendResult = ChannelSendOk | ChannelSendErr

export interface NotificationChannel {
  readonly kind: ChannelKind
  isConfigured(): boolean
  send(target: ChannelTarget, message: ChannelMessage): Promise<ChannelSendResult>
}

// ---------------------------------------------------------------------------
// EmailChannel — wraps existing sendEmail
// ---------------------------------------------------------------------------

export interface EmailChannelDeps {
  emailConfig: EmailConfig
  sendEmail: typeof sendEmailFn
}

export class EmailChannel implements NotificationChannel {
  readonly kind = 'email' as const

  constructor(private readonly deps: EmailChannelDeps) {}

  isConfigured(): boolean {
    const provider = this.deps.emailConfig.provider
    if (provider === 'console') return true
    if (provider === 'resend') return Boolean(this.deps.emailConfig.resendApiKey)
    if (provider === 'sendgrid') return Boolean(this.deps.emailConfig.sendgridApiKey)
    return false
  }

  async send(target: ChannelTarget, message: ChannelMessage): Promise<ChannelSendResult> {
    if (!target.email) {
      return { ok: false, channel: this.kind, error: 'no_recipient_email', permanent: true }
    }
    const msg: EmailMessage = {
      to: target.email,
      subject: message.subject,
      text: message.bodyText,
    }
    if (message.bodyHtml) msg.html = message.bodyHtml
    try {
      const result = await this.deps.sendEmail(msg, { config: this.deps.emailConfig })
      const out: ChannelSendOk = { ok: true, channel: this.kind, delivered: 1 }
      if (result.messageId) out.messageId = result.messageId
      return out
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { ok: false, channel: this.kind, error, permanent: false }
    }
  }
}

// ---------------------------------------------------------------------------
// ConsoleChannel — never throws, always succeeds, logs the message
// ---------------------------------------------------------------------------

export interface ConsoleChannelDeps {
  logger: Logger
}

export class ConsoleChannel implements NotificationChannel {
  readonly kind = 'console' as const

  constructor(private readonly deps: ConsoleChannelDeps) {}

  isConfigured(): true {
    return true
  }

  async send(target: ChannelTarget, message: ChannelMessage): Promise<ChannelSendResult> {
    this.deps.logger.info(
      {
        channel: 'console',
        kind: message.kind,
        subject: message.subject,
        body: message.bodyText,
        target: { email: target.email ?? null, sms: target.smsPhone ?? null },
      },
      'notification (console)',
    )
    return { ok: true, channel: this.kind, delivered: 1 }
  }
}

// ---------------------------------------------------------------------------
// TwilioSMSChannel — REST API via fetch (matches the existing email pattern)
// ---------------------------------------------------------------------------

export interface TwilioConfig {
  accountSid: string
  authToken: string
  fromNumber: string
}

export function loadTwilioConfig(env: NodeJS.ProcessEnv = process.env): TwilioConfig | null {
  const sid = env.TWILIO_ACCOUNT_SID?.trim() || ''
  const token = env.TWILIO_AUTH_TOKEN?.trim() || ''
  const from = env.TWILIO_FROM_NUMBER?.trim() || ''
  if (!sid || !token || !from) return null
  return { accountSid: sid, authToken: token, fromNumber: from }
}

export interface TwilioChannelDeps {
  config: TwilioConfig | null
  logger: Logger
  fetchImpl?: typeof fetch
}

/** SMS body cap. Twilio splits at 160 GSM-7 chars, 70 UCS-2; truncate to
 * 320 to give us a safe two-segment ceiling without needing to introspect
 * the encoding. */
const SMS_BODY_MAX = 320

export class TwilioSMSChannel implements NotificationChannel {
  readonly kind = 'sms' as const

  constructor(private readonly deps: TwilioChannelDeps) {}

  isConfigured(): boolean {
    return this.deps.config !== null
  }

  async send(target: ChannelTarget, message: ChannelMessage): Promise<ChannelSendResult> {
    const config = this.deps.config
    if (!config) {
      return { ok: false, channel: this.kind, error: 'twilio_not_configured', permanent: false }
    }
    if (!target.smsPhone) {
      return { ok: false, channel: this.kind, error: 'no_recipient_phone', permanent: true }
    }

    const body = synthesizeSmsBody(message)
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`
    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')
    const params = new URLSearchParams({
      From: config.fromNumber,
      To: target.smsPhone,
      Body: body,
    })

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${auth}`,
        },
        body: params.toString(),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // 4xx (other than 429) is permanent — bad number, blocked, etc.
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 429
        return {
          ok: false,
          channel: this.kind,
          error: `twilio http ${res.status}: ${text.slice(0, 256)}`,
          permanent,
        }
      }
      const json = (await res.json().catch(() => ({}))) as { sid?: string }
      const out: ChannelSendOk = { ok: true, channel: this.kind, delivered: 1 }
      if (json.sid) out.messageId = json.sid
      return out
    } catch (err) {
      return {
        ok: false,
        channel: this.kind,
        error: err instanceof Error ? err.message : String(err),
        permanent: false,
      }
    }
  }
}

/** Build the SMS body. Subject prefix + plain body, capped at SMS_BODY_MAX.
 * Exposed for tests so we don't have to ping Twilio to verify formatting. */
export function synthesizeSmsBody(message: ChannelMessage): string {
  const subject = message.subject.trim()
  const body = message.bodyText.trim()
  // Subject is usually short ("New assignment" etc.); prepend it on its own
  // line so the message reads naturally on a phone lock screen.
  const combined = subject && !body.startsWith(subject) ? `${subject}\n${body}` : body
  if (combined.length <= SMS_BODY_MAX) return combined
  return `${combined.slice(0, SMS_BODY_MAX - 1).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// WebPushChannel — uses the `web-push` lib for ECDH + AES-GCM payload encryption
// ---------------------------------------------------------------------------

export interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

export function loadVapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || ''
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() || ''
  const subject = env.VAPID_SUBJECT?.trim() || ''
  if (!publicKey || !privateKey || !subject) return null
  return { publicKey, privateKey, subject }
}

/**
 * One push subscription as stored in the push_subscriptions table.
 * Same shape the web-push library expects (with `keys.{p256dh,auth}`).
 */
export interface PushSubscriptionRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * Loader injected into WebPushChannel so tests can return canned rows.
 * Production passes a function that runs `select id, endpoint, p256dh, auth
 * from push_subscriptions where company_id=$1 and clerk_user_id=$2`.
 */
export type PushSubscriptionLoader = (companyId: string, clerkUserId: string) => Promise<PushSubscriptionRow[]>

/**
 * Cleanup hook for stale endpoints. Called when the push service returns
 * 404 / 410. Production deletes the row; tests can record the call.
 */
export type PushSubscriptionPruner = (subscriptionId: string) => Promise<void>

/**
 * Library facade — narrowed to the two surface methods we use so we can
 * mock it in tests without pulling in the real web-push package.
 */
export interface WebPushClient {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload?: string,
  ): Promise<{ statusCode: number }>
}

export interface WebPushChannelDeps {
  vapid: VapidConfig | null
  webpush: WebPushClient | null
  loadSubscriptions: PushSubscriptionLoader
  pruneSubscription: PushSubscriptionPruner
  logger: Logger
}

export class WebPushChannel implements NotificationChannel {
  readonly kind = 'push' as const

  constructor(
    private readonly deps: WebPushChannelDeps,
    /** Used by the router for fan-out context; the channel itself
     * re-loads subscriptions at send time so a stale count doesn't cause
     * us to skip a delivery. */
    public readonly companyId: string,
    public readonly clerkUserId: string,
  ) {
    if (deps.vapid && deps.webpush) {
      deps.webpush.setVapidDetails(deps.vapid.subject, deps.vapid.publicKey, deps.vapid.privateKey)
    }
  }

  isConfigured(): boolean {
    return this.deps.vapid !== null && this.deps.webpush !== null
  }

  async send(_target: ChannelTarget, message: ChannelMessage): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { ok: false, channel: this.kind, error: 'web_push_not_configured', permanent: false }
    }
    const subs = await this.deps.loadSubscriptions(this.companyId, this.clerkUserId)
    if (subs.length === 0) {
      return { ok: false, channel: this.kind, error: 'no_push_subscriptions', permanent: true }
    }
    const payload = JSON.stringify({
      title: message.subject,
      body: message.bodyText,
      kind: message.kind,
      data: message.payload,
    })
    let delivered = 0
    let lastError: string | null = null
    for (const sub of subs) {
      try {
        const res = await this.deps.webpush!.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        )
        if (res.statusCode >= 200 && res.statusCode < 300) {
          delivered++
          continue
        }
        if (res.statusCode === 404 || res.statusCode === 410) {
          // Subscription gone — prune, treat as a non-error.
          await this.deps.pruneSubscription(sub.id).catch((err) => {
            this.deps.logger.warn(
              { err, subscription_id: sub.id },
              '[push] failed to prune stale subscription',
            )
          })
          continue
        }
        lastError = `push http ${res.statusCode}`
      } catch (err) {
        // Library throws structured errors with statusCode; check for stale
        // endpoint signal there too.
        const statusCode =
          typeof (err as { statusCode?: unknown }).statusCode === 'number'
            ? ((err as { statusCode?: number }).statusCode as number)
            : undefined
        if (statusCode === 404 || statusCode === 410) {
          await this.deps.pruneSubscription(sub.id).catch(() => {})
          continue
        }
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    if (delivered > 0) {
      return { ok: true, channel: this.kind, delivered }
    }
    return {
      ok: false,
      channel: this.kind,
      error: lastError ?? 'all_push_subscriptions_pruned',
      // No live subscriptions left after this attempt → treat as
      // permanent so the row goes to failed instead of looping. Router's
      // fallback ladder doesn't fire post-send; that's a route-time
      // decision.
      permanent: true,
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher — live composition: prefs + target + channel send
// ---------------------------------------------------------------------------

/** Outcome returned to the drain caller for one notification row. */
export type DispatchOutcome =
  | { kind: 'sent'; channel: ChannelKind; messageId?: string; delivered?: number }
  | { kind: 'silent'; reason: string }
  | { kind: 'broadcast' }
  | { kind: 'failed'; channel: ChannelKind | null; error: string; permanent: boolean }
  | { kind: 'deferred'; reason: string }

/** Minimal pg client shape; mirrors notifications.NotificationDbClient. */
export interface DispatcherDbClient {
  query<R = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<{ rows: R[] }>
}

/**
 * Per-row hydration: when the chosen channel is email and the recipient
 * doesn't have an email on the row or in prefs, the dispatcher calls
 * this hook (typically wrapping Clerk). Return null when no email is
 * resolvable so the dispatcher returns a 'deferred' outcome.
 */
export type EmailHydrator = (clerkUserId: string) => Promise<string | null>

export interface NotificationDispatcherDeps {
  channels: {
    push: NotificationChannel | null
    sms: NotificationChannel | null
    email: NotificationChannel
    console: NotificationChannel
  }
  /**
   * Per-user push channel builder. Push needs the (company, user)
   * context to load subscriptions, so the static channel in
   * `channels.push` only declares availability — actual sends use this
   * builder. Tests can omit it and the static channel is used directly.
   */
  buildPushChannel: ((companyId: string, clerkUserId: string) => NotificationChannel) | null
  hydrateEmail: EmailHydrator | null
  logger: Logger
}

export interface DispatchableRow {
  id: string
  company_id: string
  kind: string
  subject: string
  body_text: string
  body_html: string | null
  payload: Record<string, unknown>
  recipient_email: string | null
  recipient_clerk_user_id: string | null
}

export interface NotificationDispatcher {
  /**
   * Apply the channel router decision for one row and dispatch via the
   * chosen channel. The `client` is the per-tick tx (drain holds the
   * FOR UPDATE SKIP LOCKED lock); the dispatcher reads
   * notification_preferences + push_subscriptions through it.
   */
  dispatch(row: DispatchableRow, client: DispatcherDbClient): Promise<DispatchOutcome>
}

export class DefaultNotificationDispatcher implements NotificationDispatcher {
  constructor(private readonly deps: NotificationDispatcherDeps) {}

  async dispatch(row: DispatchableRow, client: DispatcherDbClient): Promise<DispatchOutcome> {
    const hasRecipient = Boolean(row.recipient_email) || Boolean(row.recipient_clerk_user_id)
    if (!hasRecipient) {
      return { kind: 'broadcast' }
    }

    const prefs = row.recipient_clerk_user_id
      ? await loadPreferences(client, row.company_id, row.recipient_clerk_user_id)
      : DEFAULT_PREFERENCES

    const target: ChannelTarget = {
      pushSubscriptionCount: row.recipient_clerk_user_id
        ? await countPushSubscriptions(client, row.company_id, row.recipient_clerk_user_id)
        : 0,
      smsPhone: prefs.sms_phone,
      // prefs.email > row.recipient_email > (clerk hydrated lazily below)
      email: prefs.email ?? row.recipient_email,
    }

    const availability: ChannelAvailability = {
      push: this.deps.channels.push?.isConfigured() ?? false,
      sms: this.deps.channels.sms?.isConfigured() ?? false,
      email: this.deps.channels.email.isConfigured(),
      console: true,
    }

    let decision = decideChannel(row.kind, true, prefs, target, availability)

    // Email may be the chosen channel even when target.email is initially
    // null — clerk-hydration can fill it. Attempt hydration once when the
    // first-pass decision either picked email-with-no-address or fell
    // through to a defer that hydration could fix, then re-decide.
    const needsHydration =
      this.deps.hydrateEmail !== null &&
      row.recipient_clerk_user_id !== null &&
      target.email === null &&
      ((decision.kind === 'send' && decision.channel === 'email') ||
        (decision.kind === 'defer' &&
          (decision.reason === 'email_unavailable' ||
            decision.reason === 'no_recipient_email' ||
            decision.reason === 'push_unavailable_no_email_fallback' ||
            decision.reason === 'sms_unavailable_no_email_fallback')))

    if (needsHydration) {
      const hydrated = await this.deps.hydrateEmail!(row.recipient_clerk_user_id!)
      if (hydrated) {
        target.email = hydrated
        decision = decideChannel(row.kind, true, prefs, target, availability)
      }
    }

    if (decision.kind === 'silent') return { kind: 'silent', reason: decision.reason }
    if (decision.kind === 'broadcast') return { kind: 'broadcast' }
    if (decision.kind === 'defer') return { kind: 'deferred', reason: decision.reason }
    if (decision.kind === 'fail') return { kind: 'failed', channel: null, error: decision.reason, permanent: true }

    const message: ChannelMessage = {
      subject: row.subject,
      bodyText: row.body_text,
      bodyHtml: row.body_html,
      kind: row.kind,
      payload: row.payload,
    }

    const channel = this.resolveChannel(decision.channel, row)
    if (!channel) {
      return { kind: 'deferred', reason: `${decision.channel}_channel_not_available` }
    }

    const result = await channel.send(target, message)
    if (result.ok) {
      const out: { kind: 'sent'; channel: ChannelKind; messageId?: string; delivered?: number } = {
        kind: 'sent',
        channel: result.channel,
      }
      if (result.messageId) out.messageId = result.messageId
      if (result.delivered) out.delivered = result.delivered
      return out
    }
    return { kind: 'failed', channel: result.channel, error: result.error, permanent: result.permanent }
  }

  private resolveChannel(kind: ChannelKind, row: DispatchableRow): NotificationChannel | null {
    if (kind === 'email') return this.deps.channels.email
    if (kind === 'console') return this.deps.channels.console
    if (kind === 'sms') return this.deps.channels.sms
    if (kind === 'push') {
      // Push channel is per-(company, user) because the subscription
      // loader needs that context. Fall back to the static channel if
      // the per-user builder isn't supplied (test path).
      if (this.deps.buildPushChannel && row.recipient_clerk_user_id) {
        return this.deps.buildPushChannel(row.company_id, row.recipient_clerk_user_id)
      }
      return this.deps.channels.push
    }
    return null
  }
}

async function loadPreferences(
  client: DispatcherDbClient,
  companyId: string,
  clerkUserId: string,
): Promise<NotificationPreferences> {
  const result = await client.query<NotificationPreferences>(
    `select channel_assignment_change, channel_time_review_ready,
            channel_daily_log_reminder, channel_clock_anomaly,
            sms_phone, email
       from notification_preferences
      where company_id = $1 and clerk_user_id = $2
      limit 1`,
    [companyId, clerkUserId],
  )
  return result.rows[0] ?? DEFAULT_PREFERENCES
}

async function countPushSubscriptions(
  client: DispatcherDbClient,
  companyId: string,
  clerkUserId: string,
): Promise<number> {
  const result = await client.query<{ n: string }>(
    `select count(*)::text as n
       from push_subscriptions
      where company_id = $1 and clerk_user_id = $2`,
    [companyId, clerkUserId],
  )
  const raw = result.rows[0]?.n
  const n = raw === undefined ? 0 : Number(raw)
  return Number.isFinite(n) ? n : 0
}
