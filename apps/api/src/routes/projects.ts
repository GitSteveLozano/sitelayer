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
  nextProjectCloseoutEvents,
  PROJECT_CLOSEOUT_WORKFLOW_NAME,
  PROJECT_CLOSEOUT_WORKFLOW_SCHEMA_VERSION,
  projectStatusToCloseoutState,
  transitionProjectCloseoutWorkflow,
  type ProjectCloseoutHumanEventType,
  type ProjectCloseoutWorkflowSnapshot,
  type ProjectCloseoutWorkflowState,
  type WorkflowSnapshot,
} from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'
import { enqueueAdminAlert, recordMutationLedger, recordWorkflowEvent, withMutationTx } from '../mutation-tx.js'
import { isValidUuid, parseExpectedVersion, parseOptionalNumber } from '../http-utils.js'

const logger = createLogger('api:projects')

/**
 * Round to 2 decimal places. Used for the closeout-summary rollup so
 * `numeric(12,2)` sums survive the float trip back through JSON without
 * surfacing artifacts like 1234.5600000001. We compute on JS numbers
 * (cents-precise on this scale) and pin the boundary to 2 places at the
 * response layer — same shape `formatMoney` expects on the client.
 */
function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

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

export async function summarizeProject(
  pool: Pool,
  companyId: string,
  projectId: string,
  options: { draftId?: string | null } = {},
) {
  const projectResult = await pool.query(
    'select id, company_id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, version from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  // Phase A.4: optionally scope measurements + estimate_lines to a
  // specific takeoff draft (used by the per-draft estimate PDF). When
  // draftId is omitted, the existing behavior (all rows for the project,
  // regardless of draft) is preserved so existing callers — the
  // bid-accuracy dashboard, project lifecycle workflow — keep their
  // cross-draft rollups.
  const draftId = options.draftId ?? null
  const measurementsSql = draftId
    ? 'select service_item_code, quantity, unit, notes, created_at from takeoff_measurements where company_id = $1 and project_id = $2 and draft_id = $3 and deleted_at is null order by created_at asc'
    : 'select service_item_code, quantity, unit, notes, created_at from takeoff_measurements where company_id = $1 and project_id = $2 and deleted_at is null order by created_at asc'
  const estimateLinesSql = draftId
    ? 'select service_item_code, quantity, unit, rate, amount, created_at from estimate_lines where company_id = $1 and project_id = $2 and draft_id = $3 order by created_at asc'
    : 'select service_item_code, quantity, unit, rate, amount, created_at from estimate_lines where company_id = $1 and project_id = $2 order by created_at asc'
  const scopedParams = draftId ? [companyId, projectId, draftId] : [companyId, projectId]

  const [measurementsResult, estimateLinesResult, laborEntriesResult, materialBillsResult, bonusRuleResult] =
    await Promise.all([
      pool.query(measurementsSql, scopedParams),
      pool.query(estimateLinesSql, scopedParams),
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
 * - GET    /api/projects/<id>/closeout — admin/office; WorkflowSnapshot
 *                                        of the project-closeout workflow
 *                                        (state, state_version, context,
 *                                        next_events)
 * - POST   /api/projects/<id>/closeout — admin/office; mark completed,
 *                                        triggers margin-shortfall alert
 *                                        when closing margin < 10%
 * - GET    /api/projects/<id>/summary  — all roles; project cost summary
 */
type ProjectCloseoutRow = {
  id: string
  company_id: string
  status: string
  state_version: number
  closed_at: string | null
  closed_by: string | null
  summary_locked_at: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  created_at: string
  updated_at: string
}

type ProjectCloseoutSnapshotContext = {
  id: string
  company_id: string
  status: string
  closed_at: string | null
  closed_by: string | null
  summary_locked_at: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  created_at: string
  updated_at: string
}

function projectCloseoutSnapshotResponse(
  row: ProjectCloseoutRow,
): WorkflowSnapshot<ProjectCloseoutWorkflowState, ProjectCloseoutHumanEventType, ProjectCloseoutSnapshotContext> {
  const state = projectStatusToCloseoutState(row.status)
  return {
    state,
    state_version: row.state_version,
    next_events: nextProjectCloseoutEvents(state),
    context: {
      id: row.id,
      company_id: row.company_id,
      status: row.status,
      closed_at: row.closed_at,
      closed_by: row.closed_by,
      summary_locked_at: row.summary_locked_at,
      workflow_engine: row.workflow_engine,
      workflow_run_id: row.workflow_run_id,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  }
}

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
      // Auto-create the project's default takeoff draft (Phase A.2). Every
      // project ships with at least one draft so writes to
      // /api/projects/:id/takeoff/measurement always have a draft to land
      // on without lazy-creation races. The 066_takeoff_drafts migration
      // backfilled existing projects; this keeps the invariant going forward.
      const defaultDraft = await client.query(
        `insert into takeoff_drafts (company_id, project_id, name, type, status)
         values ($1, $2, 'Default', 'measurement', 'active')
         returning id`,
        [ctx.company.id, row.id],
      )
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_draft',
        entityId: defaultDraft.rows[0].id,
        action: 'create',
        row: {
          id: defaultDraft.rows[0].id,
          project_id: row.id,
          name: 'Default',
          type: 'measurement',
          status: 'active',
        },
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
    const patchAutoClockEnabled = body.auto_clock_in_enabled === undefined ? null : Boolean(body.auto_clock_in_enabled)
    const patchAutoClockGrace =
      body.auto_clock_out_grace_seconds === undefined ? null : parseOptionalNumber(body.auto_clock_out_grace_seconds)
    const patchAutoClockCorrection =
      body.auto_clock_correction_window_seconds === undefined
        ? null
        : parseOptionalNumber(body.auto_clock_correction_window_seconds)
    const patchDailyBudget = body.daily_budget_cents === undefined ? null : parseOptionalNumber(body.daily_budget_cents)
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
          auto_clock_in_enabled = case when $18::boolean then $19::boolean else auto_clock_in_enabled end,
          auto_clock_out_grace_seconds = case when $20::boolean then $21::int else auto_clock_out_grace_seconds end,
          auto_clock_correction_window_seconds = case when $22::boolean then $23::int else auto_clock_correction_window_seconds end,
          daily_budget_cents = case when $24::boolean then $25::int else daily_budget_cents end,
          updated_at = now(),
          version = version + 1
        where company_id = $1 and id = $2 and ($11::int is null or version = $11)
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, site_lat, site_lng, site_radius_m, auto_clock_in_enabled, auto_clock_out_grace_seconds, auto_clock_correction_window_seconds, daily_budget_cents, version, created_at, updated_at
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
          body.auto_clock_in_enabled !== undefined,
          patchAutoClockEnabled,
          body.auto_clock_out_grace_seconds !== undefined,
          patchAutoClockGrace,
          body.auto_clock_correction_window_seconds !== undefined,
          patchAutoClockCorrection,
          body.daily_budget_cents !== undefined,
          patchDailyBudget,
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

  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/closeout$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const result = await ctx.pool.query<ProjectCloseoutRow>(
      `select id, company_id, status, state_version, closed_at, closed_by,
              summary_locked_at, workflow_engine, workflow_run_id,
              version, created_at, updated_at
         from projects
         where company_id = $1 and id = $2 and deleted_at is null
         limit 1`,
      [ctx.company.id, projectId],
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    ctx.sendJson(200, projectCloseoutSnapshotResponse(result.rows[0]))
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

  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/timeline$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    // Open to anyone with project access (admin/office/foreman/member);
    // unlike /api/audit-events the per-project filter scopes the data
    // tightly enough that a foreman seeing their own project lifecycle
    // is fine. Cross-tenant leakage is blocked by company_id.
    const result = await ctx.pool.query(
      `select id, actor_user_id, actor_role, entity_type, entity_id, action, before, after, created_at
         from audit_events
        where company_id = $1
          and entity_type = 'project'
          and entity_id = $2
        order by created_at desc
        limit 200`,
      [ctx.company.id, projectId],
    )
    ctx.sendJson(200, { events: result.rows })
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

  // GET /api/projects/:id/labor-variance — per-service-item estimate-vs-
  // actual variance. Closes the foreman/owner feedback loop on "are we
  // ahead or behind on labor for this scope code?" by joining
  // estimate_lines (planned quantity) against labor_entries.sqft_done
  // (realized quantity) per service_item_code.
  //
  // Single FULL OUTER JOIN on two per-code aggregates so a code with no
  // labor yet still shows up (negative variance) and a code logged
  // without an estimate also surfaces (estimated_quantity=0). Rows where
  // both sides are zero are filtered out — the UI doesn't need to render
  // empty-on-both lines.
  //
  // Sort: worst-offender first by absolute hours_variance_pct so the
  // mobile card can show the top 5 without further client-side work.
  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/labor-variance$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }

    // Confirm the project exists + belongs to the active company before
    // running the variance query. Keeps tenant-isolation errors as 404
    // (matching /summary, /closeout, /timeline) rather than returning
    // an empty array for projects the caller can't see.
    const projectCheck = await ctx.pool.query<{ target_sqft_per_hr: string | null }>(
      `select target_sqft_per_hr from projects
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
      [ctx.company.id, projectId],
    )
    if (!projectCheck.rows[0]) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const projectTargetSqftPerHr = Number(projectCheck.rows[0].target_sqft_per_hr ?? 0) || 0

    const result = await ctx.pool.query<{
      service_item_code: string
      division_code: string | null
      unit: string | null
      estimated_quantity: string
      actual_quantity: string
      actual_hours: string
    }>(
      `
      with est as (
        select
          service_item_code,
          max(division_code) as division_code,
          max(unit) as unit,
          coalesce(sum(quantity), 0) as estimated_quantity
        from estimate_lines
        where company_id = $1 and project_id = $2
        group by service_item_code
      ),
      act as (
        select
          service_item_code,
          max(division_code) as division_code,
          coalesce(sum(sqft_done), 0) as actual_quantity,
          coalesce(sum(hours), 0) as actual_hours
        from labor_entries
        where company_id = $1 and project_id = $2 and deleted_at is null
        group by service_item_code
      )
      select
        coalesce(est.service_item_code, act.service_item_code) as service_item_code,
        coalesce(est.division_code, act.division_code) as division_code,
        est.unit as unit,
        coalesce(est.estimated_quantity, 0)::text as estimated_quantity,
        coalesce(act.actual_quantity, 0)::text as actual_quantity,
        coalesce(act.actual_hours, 0)::text as actual_hours
      from est
      full outer join act on est.service_item_code = act.service_item_code
      where coalesce(est.service_item_code, act.service_item_code) is not null
      `,
      [ctx.company.id, projectId],
    )

    const variance = result.rows
      .map((row) => {
        const estimatedQuantity = Number(row.estimated_quantity) || 0
        const actualQuantity = Number(row.actual_quantity) || 0
        const actualHours = Number(row.actual_hours) || 0

        // Estimated hours derive from the project's target_sqft_per_hr
        // (the only target-rate signal we have today; per-service-item
        // targets are a future enhancement). When the project has no
        // target rate, estimated_hours is 0 and hours_variance_pct
        // falls through to the actual-only branch below.
        const estimatedHours = projectTargetSqftPerHr > 0 ? estimatedQuantity / projectTargetSqftPerHr : 0

        // Variance percentages: undefined when the denominator is 0, but
        // the response contract says number. Convention: 0 when there's
        // no estimate to compare against (the UI surfaces this via the
        // estimated_quantity=0 sentinel).
        const quantityVariancePct =
          estimatedQuantity > 0 ? ((actualQuantity - estimatedQuantity) / estimatedQuantity) * 100 : 0
        const hoursVariancePct = estimatedHours > 0 ? ((actualHours - estimatedHours) / estimatedHours) * 100 : 0

        return {
          service_item_code: row.service_item_code,
          division_code: row.division_code,
          unit: row.unit ?? '',
          estimated_quantity: estimatedQuantity,
          actual_quantity: actualQuantity,
          estimated_hours: estimatedHours,
          actual_hours: actualHours,
          quantity_variance_pct: Number(quantityVariancePct.toFixed(2)),
          hours_variance_pct: Number(hoursVariancePct.toFixed(2)),
        }
      })
      // Skip rows where both sides are zero — nothing to surface.
      .filter((row) => row.estimated_quantity > 0 || row.actual_quantity > 0)
      .sort((a, b) => Math.abs(b.hours_variance_pct) - Math.abs(a.hours_variance_pct))

    ctx.sendJson(200, { variance })
    return true
  }

  // GET /api/projects/:id/closeout-summary — bid → actual rollup across all
  // cost buckets (labor / materials / rentals) plus the computed margin. This
  // is the strategic centerpiece of the merged platform: the single view per
  // project that answers "did we make money?" by combining estimate
  // (planned), labor entries (logged), material bills (recorded), and posted
  // rental invoices (billed) against the bid.
  //
  // Single CTE-stack so the response is one round-trip. Per-bucket sub-CTEs
  // keep each aggregation pinned to its own table — easier to reason about
  // and to mirror in the in-memory test pool than a five-way join.
  //
  // Rental filter: only `posted` rental_billing_runs count. Generated /
  // approved / failed / voided are excluded because they represent
  // in-flight or aborted billing — counting them would inflate "actual
  // rentals" before the invoice is committed to QBO. The subline note
  // in the UI calls this out.
  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/closeout-summary$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }

    // Project existence + bid/labor_rate gate. Keeps tenant-isolation
    // failures as 404 instead of returning an all-zero rollup for a
    // project the caller can't actually see.
    const projectResult = await ctx.pool.query<{
      id: string
      name: string
      bid_total: string | null
      labor_rate: string | null
    }>(
      `select id, name, bid_total, labor_rate
         from projects
         where company_id = $1 and id = $2 and deleted_at is null
         limit 1`,
      [ctx.company.id, projectId],
    )
    const project = projectResult.rows[0]
    if (!project) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const bid = Number(project.bid_total ?? 0) || 0
    const laborRate = Number(project.labor_rate ?? 0) || 0

    // Each bucket is its own sub-CTE so an empty bucket returns 0 instead
    // of NULL (coalesce on the SUM) and the LEFT JOIN against a single-
    // row anchor lets us emit one row even when every table is empty.
    const rollupResult = await ctx.pool.query<{
      estimate_total: string
      labor_hours: string
      materials_total: string
      rentals_total: string
    }>(
      `
      with est as (
        select coalesce(sum(amount), 0) as estimate_total
        from estimate_lines
        where company_id = $1 and project_id = $2
      ),
      lab as (
        select coalesce(sum(hours), 0) as labor_hours
        from labor_entries
        where company_id = $1 and project_id = $2 and deleted_at is null
      ),
      mat as (
        select coalesce(sum(amount), 0) as materials_total
        from material_bills
        where company_id = $1 and project_id = $2 and deleted_at is null
      ),
      rent as (
        select coalesce(sum(subtotal), 0) as rentals_total
        from rental_billing_runs
        where company_id = $1 and project_id = $2 and deleted_at is null and status = 'posted'
      )
      select
        est.estimate_total::text as estimate_total,
        lab.labor_hours::text as labor_hours,
        mat.materials_total::text as materials_total,
        rent.rentals_total::text as rentals_total
      from est, lab, mat, rent
      `,
      [ctx.company.id, projectId],
    )
    const rollup = rollupResult.rows[0] ?? {
      estimate_total: '0',
      labor_hours: '0',
      materials_total: '0',
      rentals_total: '0',
    }

    const estimateTotal = Number(rollup.estimate_total) || 0
    const laborHours = Number(rollup.labor_hours) || 0
    const laborActual = round2(laborHours * laborRate)
    const materialsActual = round2(Number(rollup.materials_total) || 0)
    const rentalsActual = round2(Number(rollup.rentals_total) || 0)
    const totalActual = round2(laborActual + materialsActual + rentalsActual)
    const margin = round2(bid - totalActual)
    // Margin % undefined when bid is 0 (avoid divide-by-zero); convention
    // is 0 so the UI can render "0%" without special-casing nulls. The
    // empty state in the card hides this row entirely when there's no
    // bid or actuals to compare.
    const marginPct = bid > 0 ? round2((margin / bid) * 100) : 0

    ctx.sendJson(200, {
      project: { id: project.id, name: project.name },
      bid,
      estimate_total: estimateTotal,
      labor_hours: laborHours,
      labor_rate: laborRate,
      labor_actual: laborActual,
      materials_actual: materialsActual,
      rentals_actual: rentalsActual,
      total_actual: totalActual,
      margin,
      margin_pct: marginPct,
    })
    return true
  }

  // GET /api/projects/:id — project detail metadata. Used by the Phase 2B
  // prj-detail shell. The /summary endpoint above is the cost-rollup;
  // this is the bare project row + customer name + geofence policy +
  // daily_budget. List + detail kept in different surfaces so screens
  // can fetch only what they render.
  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const result = await ctx.pool.query(
      `select p.id, p.name, p.status, p.division_code, p.customer_id, p.bid_total,
              p.labor_rate, p.target_sqft_per_hr, p.bonus_pool, p.closed_at,
              p.summary_locked_at, p.site_lat, p.site_lng, p.site_radius_m,
              p.auto_clock_in_enabled, p.auto_clock_out_grace_seconds,
              p.auto_clock_correction_window_seconds, p.daily_budget_cents,
              p.version, p.created_at, p.updated_at,
              c.name as customer_name
         from projects p
         left join customers c on c.id = p.customer_id and c.company_id = p.company_id
         where p.company_id = $1 and p.id = $2 and p.deleted_at is null
         limit 1`,
      [ctx.company.id, projectId],
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    ctx.sendJson(200, { project: result.rows[0] })
    return true
  }

  return false
}
