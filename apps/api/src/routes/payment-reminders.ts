import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { isValidUuid } from '../http-utils.js'
import { enqueueNotificationRow } from '../notifications.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'

export type PaymentReminderRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

/**
 * POST /api/payment-reminders  body { project_ids: string[] }
 *
 * Powers the owner-money "Send reminders" bulk action. Enqueues one real
 * follow-up notification per selected project to the requesting operator
 * (the rows are real, not a console.log no-op). Clients are not users and
 * there is no external billing portal yet, so the reminder lands in the
 * operator's own notification ledger as a "follow up on payment for <project>"
 * nudge — honest and demoable without inventing customer-email infrastructure.
 */
export async function handlePaymentReminderRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: PaymentReminderRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/payment-reminders') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const ids = Array.isArray(body.project_ids)
      ? body.project_ids.filter((x): x is string => typeof x === 'string' && isValidUuid(x))
      : []
    if (ids.length === 0) {
      ctx.sendJson(400, { error: 'project_ids must be a non-empty array of project uuids' })
      return true
    }
    // Only enqueue for projects that actually belong to this company.
    const projects = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ id: string; name: string }>(
        `select id, name
         from projects
         where company_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
        [ctx.company.id, ids],
      ),
    )
    if (projects.rows.length === 0) {
      ctx.sendJson(404, { error: 'no matching projects for this company' })
      return true
    }
    const sent = await withMutationTx(async (client: PoolClient) => {
      let n = 0
      for (const p of projects.rows) {
        await enqueueNotificationRow(client, {
          companyId: ctx.company.id,
          recipientUserId: ctx.currentUserId,
          kind: 'payment_reminder',
          subject: `Payment follow-up: ${p.name}`,
          text: `Follow up on payment for ${p.name}.`,
          payload: { project_id: p.id, requested_by: ctx.currentUserId },
        })
        n += 1
      }
      return n
    })
    ctx.sendJson(201, { reminders_sent: sent })
    return true
  }
  return false
}
