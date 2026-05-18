import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { parseJsonBody } from '../http-utils.js'
import { enqueueNotificationRow } from '../notifications.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { deleteVersionedEntity, patchVersionedEntity } from '../versioned-update.js'

// POST /api/workers — name required (matches the existing 400 path).
// role defaults to 'crew' in the insert; the schema accepts any string
// so the existing "any string" behaviour stays (no enum-tightening
// without coordinating with the seeded role taxonomy).
const WorkerCreateBodySchema = z
  .object({
    name: z.string().optional(),
    role: z.string().optional(),
  })
  .loose()

const WorkerPatchBodySchema = z
  .object({
    name: z.string().nullish(),
    role: z.string().nullish(),
    expected_version: z.union([z.number(), z.string()]).nullish(),
    version: z.union([z.number(), z.string()]).nullish(),
  })
  .loose()

const WorkerMessageBodySchema = z
  .object({
    body: z.string().optional(),
    subject: z.string().optional(),
  })
  .loose()

/**
 * Same context shape as customers.ts, minus the QBO mapping backfill —
 * workers don't sync to QBO. If we end up with a third entity that takes
 * the same trimmed-down ctx we can promote this to a shared route-context
 * variant.
 */
export type WorkerRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

/**
 * Handle /api/workers* requests. Returns true when the request matched
 * one of the routes in this module (regardless of response status); false
 * to let the parent dispatch fall through to the next handler.
 */
export async function handleWorkerRoutes(req: http.IncomingMessage, url: URL, ctx: WorkerRouteCtx): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/workers') {
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        'select id, name, role, version, deleted_at, created_at from workers where company_id = $1 and deleted_at is null order by name asc',
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { workers: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/workers') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(WorkerCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const name = (body.name ?? '').trim()
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    const worker = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        insert into workers (company_id, name, role)
        values ($1, $2, $3)
        returning id, name, role, version, deleted_at, created_at
        `,
        [ctx.company.id, name, body.role ?? 'crew'],
      )
      const row = result.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'worker',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, worker)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/workers\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const workerId = url.pathname.split('/')[3] ?? ''
    if (!workerId) {
      ctx.sendJson(400, { error: 'worker id is required' })
      return true
    }
    const parsedPatch = parseJsonBody(WorkerPatchBodySchema, await ctx.readBody())
    if (!parsedPatch.ok) {
      ctx.sendJson(400, { error: parsedPatch.error })
      return true
    }
    const body = parsedPatch.value
    return patchVersionedEntity({
      ctx,
      body,
      entityType: 'worker',
      entityName: 'worker',
      table: 'workers',
      id: workerId,
      update: async (client, expectedVersion) => {
        const result = await client.query(
          `
          update workers
          set
            name = coalesce($3, name),
            role = coalesce($4, role),
            version = version + 1
          where company_id = $1 and id = $2 and deleted_at is null and ($5::int is null or version = $5)
          returning id, name, role, version, deleted_at, created_at
          `,
          [ctx.company.id, workerId, body.name ?? null, body.role ?? null, expectedVersion],
        )
        const row = result.rows[0]
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'worker',
          entityId: workerId,
          action: 'update',
          row,
        })
        return row
      },
    })
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/workers\/[^/]+\/messages$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const workerId = url.pathname.split('/')[3] ?? ''
    if (!workerId) {
      ctx.sendJson(400, { error: 'worker id is required' })
      return true
    }
    const parsedMessage = parseJsonBody(WorkerMessageBodySchema, await ctx.readBody())
    if (!parsedMessage.ok) {
      ctx.sendJson(400, { error: parsedMessage.error })
      return true
    }
    const messageText = (parsedMessage.value.body ?? '').trim()
    if (!messageText) {
      ctx.sendJson(400, { error: 'body is required' })
      return true
    }
    if (messageText.length > 2000) {
      ctx.sendJson(400, { error: 'body must be 2000 characters or fewer' })
      return true
    }
    const subjectRaw = (parsedMessage.value.subject ?? '').trim()
    const subject = subjectRaw.length > 0 ? subjectRaw.slice(0, 200) : 'Message from foreman'

    // Resolve worker → clerk_user_id. Workers don't store this directly,
    // so we look it up from the two sources that capture it as a
    // side-effect of normal worker activity:
    //   1. worker_issues.reporter_clerk_user_id (workers who've filed a
    //      problem signed in to do it — most reliable mapping)
    //   2. clock_events.clerk_user_id (worker self-clock-in)
    // If neither source has it, the worker hasn't onboarded yet and we
    // can't address a notification to them. Return 422 with a clear
    // error rather than silently dropping the message.
    const lookup = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ clerk_user_id: string }>(
        `
        select clerk_user_id from (
          select reporter_clerk_user_id as clerk_user_id, created_at
            from worker_issues
            where company_id = $1 and worker_id = $2 and reporter_clerk_user_id is not null
          union all
          select clerk_user_id, occurred_at as created_at
            from clock_events
            where company_id = $1 and worker_id = $2 and clerk_user_id is not null
        ) sources
        order by created_at desc
        limit 1
        `,
        [ctx.company.id, workerId],
      ),
    )
    const recipientClerkUserId = lookup.rows[0]?.clerk_user_id ?? null
    if (!recipientClerkUserId) {
      ctx.sendJson(422, {
        error: 'worker has no associated user account yet — ask them to clock in or file an issue first',
        worker_id: workerId,
      })
      return true
    }

    const inserted = await withMutationTx(async (client: PoolClient) =>
      enqueueNotificationRow(client, {
        companyId: ctx.company.id,
        recipientUserId: recipientClerkUserId,
        kind: 'foreman_message',
        subject,
        text: messageText,
        payload: {
          worker_id: workerId,
          from_clerk_user_id: ctx.currentUserId,
        },
      }),
    )
    ctx.sendJson(201, { notification_id: inserted.id, recipient_clerk_user_id: recipientClerkUserId })
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/workers\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const workerId = url.pathname.split('/')[3] ?? ''
    if (!workerId) {
      ctx.sendJson(400, { error: 'worker id is required' })
      return true
    }
    return deleteVersionedEntity({
      ctx,
      entityType: 'worker',
      entityName: 'worker',
      table: 'workers',
      id: workerId,
      delete: async (client) => {
        const result = await client.query(
          `
          update workers
          set deleted_at = now(), version = version + 1
          where company_id = $1 and id = $2 and deleted_at is null
          returning id, name, role, version, deleted_at, created_at
          `,
          [ctx.company.id, workerId],
        )
        const row = result.rows[0]
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'worker',
          entityId: workerId,
          action: 'delete',
          row,
        })
        return row
      },
    })
  }

  return false
}
