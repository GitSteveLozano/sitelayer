import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { Guardrail, GuardrailStatus, GuardrailType } from '@sitelayer/domain'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { isValidUuid } from '../http-utils.js'

export type GuardrailRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const GUARDRAIL_COLUMNS = `
  id, company_id, project_id, type, threshold, current_value, status,
  triggered_at, snoozed_until, muted_reason, label, detail,
  version, created_at, updated_at
`

type GuardrailRow = {
  id: string
  company_id: string
  project_id: string
  type: GuardrailType
  threshold: string
  current_value: string
  status: GuardrailStatus
  triggered_at: string | null
  snoozed_until: string | null
  muted_reason: string | null
  label: string
  detail: string
  version: number
  created_at: string
  updated_at: string
}

function rowToGuardrail(row: GuardrailRow): Guardrail {
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.project_id,
    type: row.type,
    threshold: Number(row.threshold),
    current_value: Number(row.current_value),
    status: row.status,
    triggered_at: row.triggered_at,
    snoozed_until: row.snoozed_until,
    muted_reason: row.muted_reason,
    label: row.label,
    detail: row.detail,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const GUARDRAIL_TYPES: readonly GuardrailType[] = ['margin', 'schedule', 'safety']

function isGuardrailType(value: unknown): value is GuardrailType {
  return typeof value === 'string' && (GUARDRAIL_TYPES as readonly string[]).includes(value)
}

/** Read a numeric body field that may arrive as a number or numeric string. */
function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Guardrail routes (098_guardrails.sql):
 *   POST /api/guardrails                 create/upsert a guardrail (status=triggered)
 *   POST /api/projects/:id/guardrails    same, with project id from the path
 *   GET  /api/projects/:id/guardrails    list a project's guardrails
 *   GET  /api/guardrails/active          company-wide triggered/snoozed (owner attention card)
 *   POST /api/guardrails/:id/snooze      { snoozed_until } → status=snoozed
 *   POST /api/guardrails/:id/mute        { muted_reason }  → status=muted
 *   POST /api/guardrails/:id/clear       re-arm (status=armed, clears triggered/snooze/mute)
 */
export async function handleGuardrailRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: GuardrailRouteCtx,
): Promise<boolean> {
  // --- create (the producer for the owner attention card) -----------------
  // Two shapes: `POST /api/guardrails` (project_id in the body) and
  // `POST /api/projects/:id/guardrails` (project_id from the path). Both land
  // a row with status='triggered' so it surfaces immediately on the dashboard.
  const createPathMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/guardrails$/)
  const isCreatePath = url.pathname === '/api/guardrails' || createPathMatch !== null
  if (isCreatePath && req.method === 'POST') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()

    const projectId = createPathMatch
      ? createPathMatch[1]!
      : typeof body.project_id === 'string'
        ? body.project_id.trim()
        : ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project_id must be a valid uuid' })
      return true
    }

    // `type` is required and constrained by the table CHECK. We also accept
    // `severity` as a friendly alias for callers that think in margin/schedule/safety.
    const rawType = body.type ?? body.severity
    if (!isGuardrailType(rawType)) {
      ctx.sendJson(400, { error: "type must be one of 'margin', 'schedule', 'safety'" })
      return true
    }
    const type: GuardrailType = rawType

    const label =
      typeof body.label === 'string' && body.label.trim() !== ''
        ? body.label.trim()
        : typeof body.title === 'string'
          ? body.title.trim()
          : ''
    const detail =
      typeof body.detail === 'string' && body.detail.trim() !== ''
        ? body.detail.trim()
        : typeof body.message === 'string'
          ? body.message.trim()
          : ''
    const threshold = readNumber(body.threshold ?? body.threshold_value) ?? 0
    const currentValue = readNumber(body.current_value) ?? 0

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const owns = await client.query<{ id: string }>(
          `select id from projects
           where company_id = $1 and id = $2 and deleted_at is null limit 1`,
          [ctx.company.id, projectId],
        )
        if (owns.rows.length === 0) return { kind: 'not_found' as const }

        // One live guardrail per (project, type) — re-creating an existing one
        // re-triggers it in place (keeps the demo + evaluator idempotent).
        const inserted = await client.query<GuardrailRow>(
          `insert into guardrails
             (company_id, project_id, type, threshold, current_value,
              status, triggered_at, label, detail)
           values ($1, $2, $3, $4, $5, 'triggered', now(), $6, $7)
           on conflict (project_id, type) do update set
             threshold = excluded.threshold,
             current_value = excluded.current_value,
             status = 'triggered',
             triggered_at = now(),
             snoozed_until = null,
             muted_reason = null,
             label = excluded.label,
             detail = excluded.detail,
             version = guardrails.version + 1,
             updated_at = now()
           where guardrails.deleted_at is null
           returning ${GUARDRAIL_COLUMNS}`,
          [ctx.company.id, projectId, type, threshold, currentValue, label, detail],
        )
        const row = inserted.rows[0]!
        await recordAudit(client, {
          companyId: ctx.company.id,
          actorUserId: ctx.currentUserId,
          action: 'guardrail.triggered',
          entityType: 'guardrail',
          entityId: row.id,
          before: null,
          after: { status: row.status, type: row.type, project_id: row.project_id },
        })
        return { kind: 'ok' as const, row }
      })
      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'project not found' })
        return true
      }
      ctx.sendJson(201, { guardrail: rowToGuardrail(result.row) })
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to create guardrail' })
    }
    return true
  }

  // --- list for a project -------------------------------------------------
  const listMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/guardrails$/)
  if (listMatch && req.method === 'GET') {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true
    const projectId = listMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const rows = await withCompanyClient(ctx.company.id, (c) =>
      c.query<GuardrailRow>(
        `select ${GUARDRAIL_COLUMNS} from guardrails
         where company_id = $1 and project_id = $2 and deleted_at is null
         order by type asc`,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, { guardrails: rows.rows.map(rowToGuardrail) })
    return true
  }

  // --- company-wide active (owner attention card) -------------------------
  if (url.pathname === '/api/guardrails/active' && req.method === 'GET') {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true
    const rows = await withCompanyClient(ctx.company.id, (c) =>
      c.query<GuardrailRow>(
        `select ${GUARDRAIL_COLUMNS} from guardrails
         where company_id = $1 and deleted_at is null
           and status in ('triggered', 'snoozed')
         order by triggered_at desc nulls last`,
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { guardrails: rows.rows.map(rowToGuardrail) })
    return true
  }

  // --- snooze -------------------------------------------------------------
  const snoozeMatch = url.pathname.match(/^\/api\/guardrails\/([^/]+)\/snooze$/)
  if (snoozeMatch && req.method === 'POST') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = snoozeMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const snoozedUntil = typeof body.snoozed_until === 'string' ? body.snoozed_until.trim() : ''
    if (!snoozedUntil || Number.isNaN(Date.parse(snoozedUntil))) {
      ctx.sendJson(400, { error: 'snoozed_until must be an ISO date string' })
      return true
    }
    await applyGuardrailMutation(ctx, id, {
      action: 'guardrail.snoozed',
      setClause: `status = 'snoozed', snoozed_until = $3`,
      params: [snoozedUntil],
    })
    return true
  }

  // --- mute ---------------------------------------------------------------
  const muteMatch = url.pathname.match(/^\/api\/guardrails\/([^/]+)\/mute$/)
  if (muteMatch && req.method === 'POST') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = muteMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const mutedReason = typeof body.muted_reason === 'string' ? body.muted_reason.trim() : ''
    if (!mutedReason) {
      ctx.sendJson(400, { error: 'muted_reason is required' })
      return true
    }
    await applyGuardrailMutation(ctx, id, {
      action: 'guardrail.muted',
      setClause: `status = 'muted', muted_reason = $3`,
      params: [mutedReason],
    })
    return true
  }

  // --- clear (re-arm) -----------------------------------------------------
  const clearMatch = url.pathname.match(/^\/api\/guardrails\/([^/]+)\/clear$/)
  if (clearMatch && req.method === 'POST') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = clearMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    await applyGuardrailMutation(ctx, id, {
      action: 'guardrail.cleared',
      setClause: `status = 'armed', snoozed_until = null, muted_reason = null, triggered_at = null`,
      params: [],
    })
    return true
  }

  return false
}

/**
 * Shared snooze/mute/clear envelope: lock the guardrail FOR UPDATE, apply the
 * caller's SET clause (which always bumps version + updated_at), audit the
 * status transition, and respond. `setClause` is a trusted literal built by the
 * route above; only `params` (starting at $3) carries request data.
 */
async function applyGuardrailMutation(
  ctx: GuardrailRouteCtx,
  id: string,
  op: { action: string; setClause: string; params: unknown[] },
): Promise<void> {
  try {
    const result = await withMutationTx(async (client: PoolClient) => {
      const locked = await client.query<GuardrailRow>(
        `select ${GUARDRAIL_COLUMNS} from guardrails
         where company_id = $1 and id = $2 and deleted_at is null for update`,
        [ctx.company.id, id],
      )
      const current = locked.rows[0]
      if (!current) return { kind: 'not_found' as const }
      const updated = await client.query<GuardrailRow>(
        `update guardrails set
           ${op.setClause}, version = version + 1, updated_at = now()
         where company_id = $1 and id = $2
         returning ${GUARDRAIL_COLUMNS}`,
        [ctx.company.id, id, ...op.params],
      )
      const row = updated.rows[0]!
      await recordAudit(client, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        action: op.action,
        entityType: 'guardrail',
        entityId: id,
        before: { status: current.status },
        after: { status: row.status },
      })
      return { kind: 'ok' as const, row }
    })
    if (result.kind === 'not_found') {
      ctx.sendJson(404, { error: 'guardrail not found' })
      return
    }
    ctx.sendJson(200, { guardrail: rowToGuardrail(result.row) })
  } catch (err) {
    ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to update guardrail' })
  }
}
