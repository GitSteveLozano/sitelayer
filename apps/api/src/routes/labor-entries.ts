import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidDateInput, parseExpectedVersion } from '../http-utils.js'

export type LaborEntryRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  /**
   * Same contract as server.ts's `assertDivisionAllowedForServiceItem`.
   * Returns true when the (service_item, division) pair is allowed by the
   * service_item_divisions xref (or no xref exists yet, lenient mode).
   * Threaded through ctx so this module doesn't need its own pool reference.
   */
  assertDivisionAllowedForServiceItem: (
    companyId: string,
    serviceItemCode: string,
    divisionCode: string | null,
  ) => Promise<boolean>
}

/**
 * Handle /api/labor-entries* requests.
 *
 * - POST   /api/labor-entries          — admin/foreman/office; bumps the
 *                                        parent project's version too
 * - GET    /api/labor-entries          — paginated listing, optional
 *                                        project_id filter
 * - PATCH  /api/labor-entries/<id>     — versioned update; re-validates
 *                                        the xref if service_item or
 *                                        division changed
 * - DELETE /api/labor-entries/<id>     — soft-delete via deleted_at
 */
export async function handleLaborEntryRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: LaborEntryRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/labor-entries') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const body = await ctx.readBody()
    const required = ['project_id', 'service_item_code', 'hours', 'occurred_on']
    for (const key of required) {
      if (body[key] === undefined || body[key] === null || body[key] === '') {
        ctx.sendJson(400, { error: `${key} is required` })
        return true
      }
    }
    if (!isValidDateInput(body.occurred_on)) {
      ctx.sendJson(400, { error: 'occurred_on must be YYYY-MM-DD' })
      return true
    }
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    if (expectedVersion !== null) {
      const projectVersionResult = await ctx.pool.query(
        'select version from projects where company_id = $1 and id = $2',
        [ctx.company.id, body.project_id],
      )
      const currentProject = projectVersionResult.rows[0]
      if (!currentProject) {
        ctx.sendJson(404, { error: 'project not found' })
        return true
      }
      if (Number(currentProject.version) !== expectedVersion) {
        ctx.sendJson(409, { error: 'version conflict', current_version: Number(currentProject.version) })
        return true
      }
    }
    const serviceItemCode = String(body.service_item_code)
    const divisionCodeInput =
      body.division_code === undefined || body.division_code === null || String(body.division_code).trim() === ''
        ? null
        : String(body.division_code).trim()
    if (divisionCodeInput) {
      const allowed = await ctx.assertDivisionAllowedForServiceItem(ctx.company.id, serviceItemCode, divisionCodeInput)
      if (!allowed) {
        ctx.sendJson(400, {
          error: 'division_code not allowed for this service item',
          service_item_code: serviceItemCode,
          division_code: divisionCodeInput,
        })
        return true
      }
    }
    const entry = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        insert into labor_entries (company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code)
        values ($1, $2, $3, $4, $5, coalesce($6, 0), coalesce($7, 'draft'), $8, $9)
        returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code, created_at
        `,
        [
          ctx.company.id,
          body.project_id,
          body.worker_id ?? null,
          serviceItemCode,
          body.hours,
          body.sqft_done ?? 0,
          body.status ?? 'draft',
          body.occurred_on,
          divisionCodeInput,
        ],
      )
      const row = result.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'labor_entry',
        entityId: row.id,
        action: 'create',
        row,
        syncPayload: { action: 'create', laborEntry: row },
      })
      await client.query(
        'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
        [ctx.company.id, body.project_id],
      )
      return row
    })
    ctx.sendJson(201, entry)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/labor-entries') {
    const projectId = String(url.searchParams.get('project_id') ?? '').trim()
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50)))
    const result = await ctx.pool.query(
      `
      select id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code, version, deleted_at, created_at
      from labor_entries
      where company_id = $1 and ($2 = '' or project_id = $2)
      order by occurred_on desc, created_at desc
      limit $3
      `,
      [ctx.company.id, projectId, limit],
    )
    ctx.sendJson(200, { laborEntries: result.rows })
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/labor-entries\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const laborEntryId = url.pathname.split('/')[3] ?? ''
    if (!laborEntryId) {
      ctx.sendJson(400, { error: 'labor entry id is required' })
      return true
    }
    const body = await ctx.readBody()
    const patchServiceItemCode =
      body.service_item_code === undefined || body.service_item_code === null ? null : String(body.service_item_code)
    const patchDivisionCode =
      body.division_code === undefined
        ? null
        : body.division_code === null || String(body.division_code).trim() === ''
          ? null
          : String(body.division_code).trim()
    if (patchDivisionCode && (patchServiceItemCode || body.service_item_code !== undefined)) {
      const effectiveServiceItemCode =
        patchServiceItemCode ??
        (
          await ctx.pool.query<{ service_item_code: string }>(
            'select service_item_code from labor_entries where company_id = $1 and id = $2',
            [ctx.company.id, laborEntryId],
          )
        ).rows[0]?.service_item_code
      if (effectiveServiceItemCode) {
        const allowed = await ctx.assertDivisionAllowedForServiceItem(
          ctx.company.id,
          effectiveServiceItemCode,
          patchDivisionCode,
        )
        if (!allowed) {
          ctx.sendJson(400, {
            error: 'division_code not allowed for this service item',
            service_item_code: effectiveServiceItemCode,
            division_code: patchDivisionCode,
          })
          return true
        }
      }
    }
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update labor_entries
        set
          worker_id = coalesce($3, worker_id),
          service_item_code = coalesce($4, service_item_code),
          hours = coalesce($5, hours),
          sqft_done = coalesce($6, sqft_done),
          status = coalesce($7, status),
          occurred_on = coalesce($8, occurred_on),
          division_code = case when $10::boolean then $9 else division_code end,
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code, version, deleted_at, created_at
        `,
        [
          ctx.company.id,
          laborEntryId,
          body.worker_id ?? null,
          patchServiceItemCode,
          body.hours ?? null,
          body.sqft_done ?? null,
          body.status ?? null,
          body.occurred_on ?? null,
          patchDivisionCode,
          body.division_code !== undefined,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'labor_entry',
        entityId: laborEntryId,
        action: 'update',
        row,
        syncPayload: { action: 'update', laborEntry: row },
      })
      return row
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'labor entry not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/labor-entries\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const laborEntryId = url.pathname.split('/')[3] ?? ''
    if (!laborEntryId) {
      ctx.sendJson(400, { error: 'labor entry id is required' })
      return true
    }
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update labor_entries
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, version, deleted_at, created_at
        `,
        [ctx.company.id, laborEntryId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'labor_entry',
        entityId: laborEntryId,
        action: 'delete',
        row,
        syncPayload: { action: 'delete', laborEntry: row },
      })
      return row
    })
    if (!deleted) {
      ctx.sendJson(404, { error: 'labor entry not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  return false
}
