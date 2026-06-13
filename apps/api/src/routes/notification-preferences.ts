import type http from 'node:http'
import { z } from 'zod'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { parseJsonBody } from '../http-utils.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

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

// PUT /api/notification-preferences wire-format. Every field is optional;
// `parseChannel` already coerces unknown channel values to the 'push'
// fallback and the route validates the sms/email contact pairing
// downstream. The schema only rejects malformed shapes (e.g.
// `email: { ... }`) up front. Permissive — no unknown-key rejection.
const NotificationPreferenceUpsertBodySchema = z
  .object({
    channel_assignment_change: z.string().optional(),
    channel_time_review_ready: z.string().optional(),
    channel_daily_log_reminder: z.string().optional(),
    channel_clock_anomaly: z.string().optional(),
    sms_phone: z.string().nullish(),
    email: z.string().nullish(),
    // Migration-020 generic per-kind channel map: `{ kind: channel }` for ANY
    // notification kind (e.g. foreman_assignment, field_request_denied,
    // invoice_paid). Optional + backward-compatible — the legacy four named
    // fields above keep working unchanged for the existing web UI. Values are
    // coerced/validated below; unknown channel strings are dropped.
    channels: z.record(z.string(), z.string()).optional(),
  })
  .loose()

/**
 * The four legacy kinds that ALSO own a fixed column on
 * notification_preferences. Their channel must stay in sync between the
 * generic `channels` map and the named legacy column during the dual-write
 * EXPAND phase (migration 020), so a rollback to pre-020 code still reads the
 * right preference from the legacy column.
 */
const LEGACY_KIND_TO_COLUMN = {
  assignment_change: 'channel_assignment_change',
  time_review_ready: 'channel_time_review_ready',
  daily_log_reminder: 'channel_daily_log_reminder',
  clock_anomaly: 'channel_clock_anomaly',
} as const
type LegacyKind = keyof typeof LEGACY_KIND_TO_COLUMN

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
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<NotificationPreferenceRow>(
        `select ${PREFERENCE_COLUMNS}
       from notification_preferences
       where company_id = $1 and clerk_user_id = $2
       limit 1`,
        [ctx.company.id, ctx.currentUserId],
      ),
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
    const parsed = parseJsonBody(NotificationPreferenceUpsertBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value

    // Build the generic per-kind map (migration 020) first. It's the union of
    // the four legacy named fields and any `channels` map entries; where both
    // name a legacy kind, the explicit `channels` entry wins, and that winning
    // value is what we sync back into the legacy column below — so the legacy
    // column and the new table never disagree.
    const perKind = new Map<string, Channel>()
    if (body.channels && typeof body.channels === 'object') {
      for (const [kind, value] of Object.entries(body.channels)) {
        const k = kind.trim()
        if (!k) continue
        if (typeof value === 'string' && (ALLOWED_CHANNELS as readonly string[]).includes(value)) {
          perKind.set(k.slice(0, 128), value as Channel)
        }
      }
    }
    // Legacy named fields. When the field is present, it sets/overrides the
    // per-kind entry only if `channels` did NOT already provide one.
    for (const [legacyKind, column] of Object.entries(LEGACY_KIND_TO_COLUMN) as [LegacyKind, string][]) {
      const raw = (body as Record<string, unknown>)[column]
      if (raw !== undefined && !perKind.has(legacyKind)) {
        perKind.set(legacyKind, parseChannel(raw, 'push'))
      }
    }

    // The four legacy columns are NON-NULL, so resolve each from (in order):
    // the per-kind map → the existing legacy default 'push'. This keeps the
    // legacy upsert shape identical for rollback-safety.
    const channels = {
      channel_assignment_change: perKind.get('assignment_change') ?? 'push',
      channel_time_review_ready: perKind.get('time_review_ready') ?? 'push',
      channel_daily_log_reminder: perKind.get('daily_log_reminder') ?? 'push',
      channel_clock_anomaly: perKind.get('clock_anomaly') ?? 'push',
    } satisfies Record<string, Channel>

    const smsPhone =
      typeof body.sms_phone === 'string' && body.sms_phone.trim() ? body.sms_phone.trim().slice(0, 32) : null
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim().slice(0, 320) : null

    // Reject channel selection that requires a contact field that's not set.
    // Better to 400 here than have the worker silently downgrade to push.
    // Checks the FULL per-kind set (legacy + generic) so a new kind set to
    // sms/email is validated the same way.
    const allChosen = [...perKind.values(), ...Object.values(channels)]
    const usesSms = allChosen.includes('sms')
    const usesEmail = allChosen.includes('email')
    if (usesSms && !smsPhone) {
      ctx.sendJson(400, { error: 'sms_phone required when any channel is sms' })
      return true
    }
    if (usesEmail && !email) {
      ctx.sendJson(400, { error: 'email required when any channel is email' })
      return true
    }

    // DUAL-WRITE (migration 020 EXPAND): write BOTH the legacy
    // notification_preferences columns (rollback-safe) AND the new
    // notification_channel_preferences per-kind rows (new code reads these
    // first). Both happen in one tx so they can never diverge on a partial
    // failure.
    const upsert = await withMutationTx(ctx.company.id, async (c) => {
      const legacy = await c.query<NotificationPreferenceRow>(
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

      for (const [kind, channel] of perKind) {
        await c.query(
          `insert into notification_channel_preferences (company_id, clerk_user_id, kind, channel)
           values ($1, $2, $3, $4)
           on conflict (company_id, clerk_user_id, kind) do update
             set channel = excluded.channel, updated_at = now()`,
          [ctx.company.id, ctx.currentUserId, kind, channel],
        )
      }

      return legacy
    })
    ctx.sendJson(200, { preferences: upsert.rows[0] })
    return true
  }

  return false
}

/**
 * Self-registered dispatch descriptor for the `notification-preferences` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const notificationPreferencesRouteDescriptor: DispatchRouteDescriptor = {
  name: 'notification-preferences',
  order: 750,
  handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
    handleNotificationPreferenceRoutes(req, url, {
      pool,
      company,
      currentUserId,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
    }),
}
