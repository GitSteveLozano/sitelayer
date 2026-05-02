import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { enqueueNotification } from '../mutation-tx.js'
import { listIssueRecipientUserIds } from '../notifications.js'
import { withMutationTx } from '../mutation-tx.js'

/**
 * Routes for `wk-issue` from Sitemap §11 — worker "Flag a problem" pings.
 *
 * - POST /api/worker-issues  open ticket (any role; the worker filing
 *                            the issue is the actor on the row)
 * - GET  /api/worker-issues  list open issues for triage (admin/foreman/
 *                            office); supports ?resolved=true to see the
 *                            full history.
 *
 * The POST path also enqueues `notifications` rows for the company's
 * foreman/admin/office members so the foreman gets a push without having
 * to sit on the dashboard. Recipient resolution is intentionally broad —
 * the cost of an extra notification on a small construction company is
 * lower than a dropped ping.
 */
export type WorkerIssueRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const ALLOWED_KINDS = ['materials_out', 'crew_short', 'safety', 'other'] as const
type IssueKind = (typeof ALLOWED_KINDS)[number]

const KIND_LABELS: Record<IssueKind, string> = {
  materials_out: 'Out of materials',
  crew_short: 'Crew short',
  safety: 'Safety',
  other: 'Something else',
}

function parseKind(value: unknown): IssueKind | null {
  if (typeof value !== 'string') return null
  return (ALLOWED_KINDS as readonly string[]).includes(value) ? (value as IssueKind) : null
}

const ISSUE_COLUMNS = `
  id, company_id, project_id, worker_id, reporter_clerk_user_id,
  kind, message, resolved_at, resolved_by_clerk_user_id, created_at
`

export async function handleWorkerIssueRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: WorkerIssueRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/worker-issues') {
    const body = await ctx.readBody()
    const kind = parseKind(body.kind)
    if (!kind) {
      ctx.sendJson(400, { error: `kind must be one of ${ALLOWED_KINDS.join(', ')}` })
      return true
    }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (message.length === 0) {
      ctx.sendJson(400, { error: 'message is required' })
      return true
    }
    if (message.length > 2000) {
      ctx.sendJson(400, { error: 'message must be 2000 characters or fewer' })
      return true
    }
    const projectId = typeof body.project_id === 'string' && body.project_id.length > 0 ? body.project_id : null

    // Resolve worker_id from the active membership when it exists. A row
    // without a worker mapping is fine — we still want to capture the
    // ping; just leave worker_id null.
    const workerLookup = await ctx.pool.query<{ id: string }>(
      `select id from workers where company_id = $1 and clerk_user_id = $2 and deleted_at is null limit 1`,
      [ctx.company.id, ctx.currentUserId],
    )
    const workerId = workerLookup.rows[0]?.id ?? null

    const insertedRow = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `insert into worker_issues
           (company_id, project_id, worker_id, reporter_clerk_user_id, kind, message)
         values ($1, $2, $3, $4, $5, $6)
         returning ${ISSUE_COLUMNS}`,
        [ctx.company.id, projectId, workerId, ctx.currentUserId, kind, message],
      )
      const row = result.rows[0]
      if (!row) throw new Error('worker_issues insert returned no row')
      return row
    })

    // Best-effort foreman fan-out. Notification enqueue failures are
    // logged but don't surface to the worker — the row is the audit trail.
    const recipients = await listIssueRecipientUserIds(ctx.pool, ctx.company.id)
    const subject = `${KIND_LABELS[kind]} reported`
    const text = projectId ? `${KIND_LABELS[kind]}: ${message}` : `${KIND_LABELS[kind]} (no project): ${message}`
    const payload = {
      worker_issue_id: insertedRow.id,
      kind,
      project_id: projectId,
      reporter_clerk_user_id: ctx.currentUserId,
    }
    if (recipients.length === 0) {
      await enqueueNotification({
        companyId: ctx.company.id,
        kind: 'worker_issue',
        subject,
        text,
        payload,
      })
    } else {
      for (const recipientUserId of recipients) {
        await enqueueNotification({
          companyId: ctx.company.id,
          recipientUserId,
          kind: 'worker_issue',
          subject,
          text,
          payload,
        })
      }
    }

    ctx.sendJson(201, { worker_issue: insertedRow })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/worker-issues') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const includeResolved = url.searchParams.get('resolved') === 'true'
    const params: unknown[] = [ctx.company.id]
    let where = 'where company_id = $1'
    if (!includeResolved) where += ' and resolved_at is null'
    const projectId = url.searchParams.get('project_id')
    if (projectId) {
      params.push(projectId)
      where += ` and project_id = $${params.length}`
    }
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 100)))
    params.push(limit)
    const result = await ctx.pool.query(
      `select ${ISSUE_COLUMNS} from worker_issues ${where}
       order by created_at desc
       limit $${params.length}`,
      params,
    )
    ctx.sendJson(200, { worker_issues: result.rows })
    return true
  }

  return false
}
