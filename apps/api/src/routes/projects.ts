import type http from 'node:http'
import type { Pool } from 'pg'
import {
  calculateBonusPayout,
  calculateMargin,
  calculateProjectCost,
  DEFAULT_BONUS_RULE,
  sumMoney,
} from '@sitelayer/domain'
import { createLogger } from '@sitelayer/logger'
import {
  PROJECT_CLOSEOUT_WORKFLOW_NAME,
  PROJECT_CLOSEOUT_WORKFLOW_SCHEMA_VERSION,
  projectStatusToCloseoutState,
  transitionProjectCloseoutWorkflow,
  type ProjectCloseoutWorkflowSnapshot,
} from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'
import { enqueueAdminAlert, recordMutationLedger, recordWorkflowEvent, withMutationTx } from '../mutation-tx.js'
import { isValidUuid, parseExpectedVersion, parseOptionalNumber } from '../http-utils.js'

const logger = createLogger('api:projects')

export type ProjectRouteCtx = {
  pool: Pool
  company: ActiveCompany
  /** Currently-active Clerk user id (for the workflow event log actor). */
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

export async function summarizeProject(pool: Pool, companyId: string, projectId: string) {
  const projectResult = await pool.query(
    'select id, company_id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, version from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const [measurementsResult, estimateLinesResult, laborEntriesResult, materialBillsResult, bonusRuleResult] =
    await Promise.all([
      pool.query(
        'select service_item_code, quantity, unit, notes, created_at from takeoff_measurements where company_id = $1 and project_id = $2 order by created_at asc',
        [companyId, projectId],
      ),
      pool.query(
        'select service_item_code, quantity, unit, rate, amount, created_at from estimate_lines where company_id = $1 and project_id = $2 order by created_at asc',
        [companyId, projectId],
      ),
      pool.query(
        'select service_item_code, hours, sqft_done, status, occurred_on from labor_entries where company_id = $1 and project_id = $2 order by occurred_on desc, created_at desc',
        [companyId, projectId],
      ),
      pool.query(
        'select amount, bill_type from material_bills where company_id = $1 and project_id = $2 and deleted_at is null',
        [companyId, projectId],
      ),
      pool.query('select config from bonus_rules where company_id = $1 order by created_at desc limit 1', [companyId]),
    ])

  // Money sums use sumMoney (integer-cents arithmetic) — JS float
  // accumulation drifts on numeric(12,2) sums. The downstream consumers
  // (calculateProjectCost, calculateMargin) still take JS numbers, so
  // we parse the cents-precise string back. This keeps the boundary
  // narrow: the SUM is exact, individual values are still numbers.
  const laborRate = Number(project.labor_rate ?? 0)
  const laborCost = Number(sumMoney(laborEntriesResult.rows.map((entry) => Number(entry.hours) * laborRate)))
  const materialCost = Number(
    sumMoney(materialBillsResult.rows.filter((b) => b.bill_type !== 'sub').map((b) => b.amount ?? 0)),
  )
  const subCost = Number(
    sumMoney(materialBillsResult.rows.filter((b) => b.bill_type === 'sub').map((b) => b.amount ?? 0)),
  )
  const totalCost = calculateProjectCost({ laborCost, materialCost, subCost })
  const margin = calculateMargin({ revenue: Number(project.bid_total ?? 0), cost: totalCost })
  const bonusTiers = bonusRuleResult.rows[0]?.config?.tiers ?? DEFAULT_BONUS_RULE.tiers
  const bonus = calculateBonusPayout(margin.margin, Number(project.bonus_pool ?? 0), bonusTiers)
  // Quantities aren't currency — drift here is bounded by the small
  // measurement count and ≤ 4 decimal places, so plain JS sum is fine.
  const totalMeasurementQuantity = measurementsResult.rows.reduce(
    (total, measurement) => total + Number(measurement.quantity),
    0,
  )
  const estimateTotal = Number(sumMoney(estimateLinesResult.rows.map((line) => line.amount)))

  return {
    project,
    metrics: {
      totalMeasurementQuantity,
      estimateTotal,
      laborCost,
      materialCost,
      subCost,
      totalCost,
      margin,
      bonus,
    },
    measurements: measurementsResult.rows,
    estimateLines: estimateLinesResult.rows,
    laborEntries: laborEntriesResult.rows,
  }
}

/**
 * Handle project mutation routes:
 * - POST   /api/projects               — admin/office; create project
 * - PATCH  /api/projects/<id>          — admin/office; versioned update
 * - POST   /api/projects/<id>/closeout — admin/office; mark completed,
 *                                        triggers margin-shortfall alert
 *                                        when closing margin < 10%
 * - GET    /api/projects/<id>/summary  — all roles; project cost summary
 */
export async function handleProjectRoutes(req: http.IncomingMessage, url: URL, ctx: ProjectRouteCtx): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/projects') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const name = String(body.name ?? '').trim()
    const customerName = String(body.customer_name ?? '').trim()
    const divisionCode = String(body.division_code ?? 'D4')
    if (!name || !customerName) {
      ctx.sendJson(400, { error: 'name and customer_name are required' })
      return true
    }
    const customerId =
      body.customer_id === undefined || body.customer_id === null || body.customer_id === ''
        ? null
        : String(body.customer_id).trim()
    if (customerId && !isValidUuid(customerId)) {
      ctx.sendJson(400, { error: 'customer_id must be a valid uuid' })
      return true
    }
    const siteLat = parseOptionalNumber(body.site_lat)
    const siteLng = parseOptionalNumber(body.site_lng)
    const siteRadiusMeters = parseOptionalNumber(body.site_radius_m)
    const created = await withMutationTx(async (client) => {
      const inserted = await client.query(
        `
        insert into projects (
          company_id, customer_id, name, customer_name, division_code, status,
          bid_total, labor_rate, target_sqft_per_hr, bonus_pool,
          site_lat, site_lng, site_radius_m, version
        )
        values (
          $1,
          nullif($2, '')::uuid,
          $3,
          $4,
          $5,
          coalesce($6, 'lead'),
          coalesce($7, 0),
          coalesce($8, 0),
          $9,
          coalesce($10, 0),
          $11,
          $12,
          coalesce($13, 100),
          1
        )
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, site_lat, site_lng, site_radius_m, version, created_at, updated_at
        `,
        [
          ctx.company.id,
          customerId,
          name,
          customerName,
          divisionCode,
          body.status ?? 'lead',
          body.bid_total ?? 0,
          body.labor_rate ?? 0,
          body.target_sqft_per_hr ?? null,
          body.bonus_pool ?? 0,
          siteLat,
          siteLng,
          siteRadiusMeters,
        ],
      )
      const row = inserted.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'project',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, created)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/projects\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const patchSiteLat = body.site_lat === undefined ? null : parseOptionalNumber(body.site_lat)
    const patchSiteLng = body.site_lng === undefined ? null : parseOptionalNumber(body.site_lng)
    const patchSiteRadius = body.site_radius_m === undefined ? null : parseOptionalNumber(body.site_radius_m)
    const updated = await withMutationTx(async (client) => {
      const result = await client.query(
        `
        update projects
        set
          name = coalesce($3, name),
          customer_name = coalesce($4, customer_name),
          division_code = coalesce($5, division_code),
          status = coalesce($6, status),
          bid_total = coalesce($7, bid_total),
          labor_rate = coalesce($8, labor_rate),
          target_sqft_per_hr = coalesce($9, target_sqft_per_hr),
          bonus_pool = coalesce($10, bonus_pool),
          site_lat = case when $12::boolean then $13::numeric else site_lat end,
          site_lng = case when $14::boolean then $15::numeric else site_lng end,
          site_radius_m = case when $16::boolean then $17::int else site_radius_m end,
          updated_at = now(),
          version = version + 1
        where company_id = $1 and id = $2 and ($11::int is null or version = $11)
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, site_lat, site_lng, site_radius_m, version, created_at, updated_at
        `,
        [
          ctx.company.id,
          projectId,
          body.name ?? null,
          body.customer_name ?? null,
          body.division_code ?? null,
          body.status ?? null,
          body.bid_total ?? null,
          body.labor_rate ?? null,
          body.target_sqft_per_hr ?? null,
          body.bonus_pool ?? null,
          expectedVersion,
          body.site_lat !== undefined,
          patchSiteLat,
          body.site_lng !== undefined,
          patchSiteLng,
          body.site_radius_m !== undefined,
          patchSiteRadius,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'project',
        entityId: projectId,
        action: 'update',
        row,
      })
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'projects',
          'company_id = $1 and id = $2',
          [ctx.company.id, projectId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/closeout$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body?.expected_version ?? body?.version)
    const closed = await withMutationTx(async (client) => {
      // Lock + load so the deterministic reducer can run against the
      // current snapshot. Optimistic version check stays on `version`
      // for the SPA's existing PATCH plumbing; workflow `state_version`
      // is bumped by the reducer.
      const lockedResult = await client.query<{
        id: string
        status: string
        state_version: number
        closed_at: string | null
        closed_by: string | null
        summary_locked_at: string | null
        version: number
      }>(
        `select id, status, state_version, closed_at, closed_by, summary_locked_at, version
         from projects
         where company_id = $1 and id = $2 and deleted_at is null
         for update`,
        [ctx.company.id, projectId],
      )
      const current = lockedResult.rows[0]
      if (!current) return null
      if (expectedVersion != null && current.version !== expectedVersion) {
        // Match the legacy not-found path so the existing checkVersion
        // 409 response stays correct.
        return null
      }

      // Idempotent: a second closeout call on an already-completed
      // project is a no-op success rather than a 4xx, matching the
      // pre-workflow behaviour (the route used to silently re-run the
      // UPDATE which was a no-op).
      if (current.status === 'completed') {
        const existing = await client.query(
          `select id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, version, created_at, updated_at
           from projects
           where company_id = $1 and id = $2`,
          [ctx.company.id, projectId],
        )
        return existing.rows[0]
      }

      const reducerEvent = {
        type: 'CLOSEOUT' as const,
        closed_at: new Date().toISOString(),
        closed_by: ctx.currentUserId,
      }
      const beforeStateVersion = current.state_version
      let nextSnapshot: ProjectCloseoutWorkflowSnapshot
      try {
        nextSnapshot = transitionProjectCloseoutWorkflow(
          {
            state: projectStatusToCloseoutState(current.status),
            state_version: current.state_version,
            closed_at: current.closed_at,
            closed_by: current.closed_by,
            summary_locked_at: current.summary_locked_at,
          },
          reducerEvent,
        )
      } catch {
        return null
      }

      const result = await client.query(
        `
        update projects
        set
          status = 'completed',
          state_version = $4,
          closed_at = coalesce(closed_at, $5::timestamptz),
          closed_by = coalesce(closed_by, $6),
          summary_locked_at = coalesce(summary_locked_at, $5::timestamptz),
          updated_at = now(),
          version = version + 1
        where company_id = $1 and id = $2 and ($3::int is null or version = $3)
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, closed_by, summary_locked_at, version, created_at, updated_at
        `,
        [
          ctx.company.id,
          projectId,
          expectedVersion,
          nextSnapshot.state_version,
          reducerEvent.closed_at,
          reducerEvent.closed_by,
        ],
      )
      const row = result.rows[0]
      if (!row) return null

      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: PROJECT_CLOSEOUT_WORKFLOW_NAME,
        schemaVersion: PROJECT_CLOSEOUT_WORKFLOW_SCHEMA_VERSION,
        entityType: 'project',
        entityId: projectId,
        stateVersion: beforeStateVersion,
        eventType: 'CLOSEOUT',
        eventPayload: reducerEvent as unknown as Record<string, unknown>,
        snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'project',
        entityId: projectId,
        action: 'closeout',
        row,
      })
      return row
    })
    if (!closed) {
      if (
        !(await ctx.checkVersion(
          'projects',
          'company_id = $1 and id = $2',
          [ctx.company.id, projectId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    // Margin shortfall alert: when the closing margin is below 10%,
    // notify company admins so they can review before invoicing.
    // Best-effort, post-commit — alert delivery must not roll back
    // the closeout.
    try {
      const summary = await summarizeProject(ctx.pool, ctx.company.id, projectId)
      const marginPct = summary?.metrics?.margin?.margin
      if (typeof marginPct === 'number' && marginPct < 10) {
        const project = closed as { name?: string; customer_name?: string }
        const subject = `[Sitelayer] Margin shortfall on closeout: ${project.name ?? projectId}`
        const text = [
          `Project "${project.name ?? projectId}" (${project.customer_name ?? 'unknown customer'}) closed with a margin of ${marginPct.toFixed(2)}%.`,
          `Target is 10%. Review cost entries and invoicing before finalizing.`,
          `https://sitelayer.sandolab.xyz/projects/${projectId}`,
        ].join('\n\n')
        await enqueueAdminAlert(ctx.company.id, 'margin_shortfall', subject, text, {
          project_id: projectId,
          margin_pct: marginPct,
          revenue: summary?.metrics?.margin?.revenue ?? null,
          cost: summary?.metrics?.margin?.cost ?? null,
        })
      }
    } catch (err) {
      logger.warn({ err, projectId }, '[notifications] margin_shortfall alert failed')
    }
    ctx.sendJson(200, closed)
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/summary$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const summary = await summarizeProject(ctx.pool, ctx.company.id, projectId)
    if (!summary) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    ctx.sendJson(200, summary)
    return true
  }

  return false
}
