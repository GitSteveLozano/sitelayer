import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { LOST_REASON_CODES, type LostReasonCode } from '@sitelayer/domain'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { isValidUuid } from '../http-utils.js'

export type ProjectLostReasonRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const LOST_REASON_COLUMNS = `
  id, company_id, project_id, reason, note, lost_value,
  recorded_by, version, created_at, updated_at
`

type LostReasonRow = {
  id: string
  company_id: string
  project_id: string
  reason: LostReasonCode
  note: string
  lost_value: string
  recorded_by: string | null
  version: number
  created_at: string
  updated_at: string
}

function rowToLostReason(row: LostReasonRow) {
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.project_id,
    reason: row.reason,
    note: row.note,
    // numeric(14,2) comes back from pg as a string — normalise to a number.
    lost_value: Number(row.lost_value),
    recorded_by: row.recorded_by,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function isLostReasonCode(value: unknown): value is LostReasonCode {
  return typeof value === 'string' && (LOST_REASON_CODES as readonly string[]).includes(value)
}

/**
 * Project lost-reason routes (099_project_lost_reasons.sql + @sitelayer/domain ProjectLostReason):
 *   GET /api/projects/:id/lost-reason   → { lost_reason: {...} | null }
 *   PUT /api/projects/:id/lost-reason   → upsert on (project_id); { lost_reason }
 *
 * One row per project — the v2 PROJECT · LOST screen captures why a sent estimate
 * didn't convert; re-deciding a project upserts the single live row.
 */
export async function handleProjectLostReasonRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ProjectLostReasonRouteCtx,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/lost-reason$/)
  if (!match) return false

  // --- read the single lost-reason for a project --------------------------
  if (req.method === 'GET') {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true
    const projectId = match[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<LostReasonRow>(
        `select ${LOST_REASON_COLUMNS} from project_lost_reasons
         where company_id = $1 and project_id = $2 and deleted_at is null limit 1`,
        [ctx.company.id, projectId],
      ),
    )
    const row = result.rows[0]
    ctx.sendJson(200, { lost_reason: row ? rowToLostReason(row) : null })
    return true
  }

  // --- upsert the lost-reason for a project -------------------------------
  if (req.method === 'PUT') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = match[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    if (!isLostReasonCode(body.reason)) {
      ctx.sendJson(400, { error: `reason must be one of: ${LOST_REASON_CODES.join(', ')}` })
      return true
    }
    const reason = body.reason
    const note = typeof body.note === 'string' ? body.note : ''
    const lostValue = Number.isFinite(Number(body.lost_value)) ? Number(body.lost_value) : 0
    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const proj = await client.query<{ id: string }>(
          `select id from projects where company_id = $1 and id = $2 and deleted_at is null limit 1`,
          [ctx.company.id, projectId],
        )
        if (!proj.rows[0]) return { kind: 'not_found' as const }
        const upserted = await client.query<LostReasonRow>(
          `insert into project_lost_reasons
             (company_id, project_id, reason, note, lost_value, recorded_by)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (project_id) do update set
             reason = excluded.reason,
             note = excluded.note,
             lost_value = excluded.lost_value,
             recorded_by = excluded.recorded_by,
             version = project_lost_reasons.version + 1,
             deleted_at = null,
             updated_at = now()
           returning ${LOST_REASON_COLUMNS}`,
          [ctx.company.id, projectId, reason, note, lostValue, ctx.currentUserId],
        )
        const row = upserted.rows[0]!
        await recordAudit(client, {
          companyId: ctx.company.id,
          actorUserId: ctx.currentUserId,
          action: 'project_lost_reason.set',
          entityType: 'project_lost_reason',
          entityId: row.id,
          after: { project_id: projectId, reason: row.reason, lost_value: Number(row.lost_value) },
        })
        return { kind: 'ok' as const, row }
      })
      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'project not found' })
        return true
      }
      ctx.sendJson(200, { lost_reason: rowToLostReason(result.row) })
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to set lost reason' })
    }
    return true
  }

  return false
}
