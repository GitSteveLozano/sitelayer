import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'

export type NotificationPreferenceRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const PREFERENCE_COLUMNS = `
  id, company_id, clerk_user_id,
  channel_assignment_change, channel_time_review_ready,
  channel_daily_log_reminder, channel_clock_anomaly,
  sms_phone, email,
  created_at, updated_at
`

const ALLOWED_CHANNELS = ['push', 'sms', 'email', 'off'] as const
type Channel = (typeof ALLOWED_CHANNELS)[number]

function parseChannel(value: unknown, fallback: Channel): Channel {
  if (typeof value === 'string' && (ALLOWED_CHANNELS as readonly string[]).includes(value)) {
    return value as Channel
  }
  return fallback
}

type NotificationPreferenceRow = {
  id: string
  company_id: string
  clerk_user_id: string
  channel_assignment_change: Channel
  channel_time_review_ready: Channel
  channel_daily_log_reminder: Channel
  channel_clock_anomaly: Channel
  sms_phone: string | null
  email: string | null
  created_at: string
  updated_at: string
}

function defaults(): Pick<
  NotificationPreferenceRow,
  | 'channel_assignment_change'
  | 'channel_time_review_ready'
  | 'channel_daily_log_reminder'
  | 'channel_clock_anomaly'
  | 'sms_phone'
  | 'email'
> {
  return {
    channel_assignment_change: 'push',
    channel_time_review_ready: 'push',
    channel_daily_log_reminder: 'push',
    channel_clock_anomaly: 'push',
    sms_phone: null,
    email: null,
  }
}

/**
 * Per-user notification preferences.
 *
 * - GET /api/notification-preferences        returns the current row, or
 *                                            the canonical defaults when
 *                                            none exists yet
 * - PUT /api/notification-preferences        upsert
 *
 * The worker (Phase 1C channel router) reads this when picking a
 * delivery channel for each `notifications` row. 'off' silences the
 * event for that user.
 */
export async function handleNotificationPreferenceRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: NotificationPreferenceRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/notification-preferences') {
    const result = await ctx.pool.query<NotificationPreferenceRow>(
      `select ${PREFERENCE_COLUMNS}
       from notification_preferences
       where company_id = $1 and clerk_user_id = $2
       limit 1`,
      [ctx.company.id, ctx.currentUserId],
    )
    if (result.rows[0]) {
      ctx.sendJson(200, { preferences: result.rows[0] })
      return true
    }
    ctx.sendJson(200, {
      preferences: {
        clerk_user_id: ctx.currentUserId,
        company_id: ctx.company.id,
        ...defaults(),
      },
    })
    return true
  }

  if (req.method === 'PUT' && url.pathname === '/api/notification-preferences') {
    const body = await ctx.readBody()
    const channels = {
      channel_assignment_change: parseChannel(body.channel_assignment_change, 'push'),
      channel_time_review_ready: parseChannel(body.channel_time_review_ready, 'push'),
      channel_daily_log_reminder: parseChannel(body.channel_daily_log_reminder, 'push'),
      channel_clock_anomaly: parseChannel(body.channel_clock_anomaly, 'push'),
    }
    const smsPhone =
      typeof body.sms_phone === 'string' && body.sms_phone.trim() ? body.sms_phone.trim().slice(0, 32) : null
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim().slice(0, 320) : null

    // Reject channel selection that requires a contact field that's not set.
    // Better to 400 here than have the worker silently downgrade to push.
    const usesSms = Object.values(channels).includes('sms')
    const usesEmail = Object.values(channels).includes('email')
    if (usesSms && !smsPhone) {
      ctx.sendJson(400, { error: 'sms_phone required when any channel is sms' })
      return true
    }
    if (usesEmail && !email) {
      ctx.sendJson(400, { error: 'email required when any channel is email' })
      return true
    }

    const upsert = await ctx.pool.query<NotificationPreferenceRow>(
      `insert into notification_preferences (
         company_id, clerk_user_id,
         channel_assignment_change, channel_time_review_ready,
         channel_daily_log_reminder, channel_clock_anomaly,
         sms_phone, email
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (company_id, clerk_user_id) do update
         set channel_assignment_change   = excluded.channel_assignment_change,
             channel_time_review_ready   = excluded.channel_time_review_ready,
             channel_daily_log_reminder  = excluded.channel_daily_log_reminder,
             channel_clock_anomaly       = excluded.channel_clock_anomaly,
             sms_phone                   = excluded.sms_phone,
             email                       = excluded.email,
             updated_at                  = now()
       returning ${PREFERENCE_COLUMNS}`,
      [
        ctx.company.id,
        ctx.currentUserId,
        channels.channel_assignment_change,
        channels.channel_time_review_ready,
        channels.channel_daily_log_reminder,
        channels.channel_clock_anomaly,
        smsPhone,
        email,
      ],
    )
    ctx.sendJson(200, { preferences: upsert.rows[0] })
    return true
  }

  return false
}
