import type http from 'node:http'
import type { Pool } from 'pg'
import { DEFAULT_BONUS_RULE, calculateBonusPayout, computeProductivity } from '@sitelayer/domain'
import type { ActiveCompany } from '../auth-types.js'
import { listLaborByItem, listLaborByWeek, listLaborByWorker, parseLaborReportFilters } from '../labor-reports.js'

export type AnalyticsRouteCtx = {
  pool: Pool
  company: ActiveCompany
  /** Currently-active Clerk user id (for the membership-role lookups). */
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  sendJson: (status: number, body: unknown) => void
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

async function lookupRole(pool: Pool, companyId: string, userId: string): Promise<string | null> {
  const result = await pool.query<{ role: string }>(
    'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
    [companyId, userId],
  )
  return result.rows[0]?.role ?? null
}

async function listAnalytics(pool: Pool, companyId: string) {
  const [projectRows, laborRows, materialRows, bonusRules] = await Promise.all([
    pool.query(
      'select id, name, customer_name, division_code, status, bid_total, labor_rate, bonus_pool from projects where company_id = $1 order by updated_at desc',
      [companyId],
    ),
    pool.query(
      'select project_id, service_item_code, hours, sqft_done, occurred_on from labor_entries where company_id = $1 and deleted_at is null',
      [companyId],
    ),
    pool.query(
      'select project_id, amount, bill_type from material_bills where company_id = $1 and deleted_at is null',
      [companyId],
    ),
    pool.query('select config from bonus_rules where company_id = $1 order by created_at desc limit 1', [companyId]),
  ])

  const bonusTiers = bonusRules.rows[0]?.config?.tiers ?? DEFAULT_BONUS_RULE.tiers
  const laborByProject = new Map<string, typeof laborRows.rows>()
  const materialByProject = new Map<string, typeof materialRows.rows>()

  for (const labor of laborRows.rows) {
    const list = laborByProject.get(labor.project_id) ?? []
    list.push(labor)
    laborByProject.set(labor.project_id, list)
  }

  for (const material of materialRows.rows) {
    const list = materialByProject.get(material.project_id) ?? []
    list.push(material)
    materialByProject.set(material.project_id, list)
  }

  const analytics = projectRows.rows.map((project) => {
    const projectLabor = laborByProject.get(project.id) ?? []
    const projectMaterial = materialByProject.get(project.id) ?? []

    const totalHours = projectLabor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
    const totalSqft = projectLabor.reduce((sum, l) => sum + Number(l.sqft_done ?? 0), 0)
    const laborCost = totalHours * Number(project.labor_rate ?? 0)
    const materialCost = projectMaterial
      .filter((m) => m.bill_type !== 'sub')
      .reduce((sum, m) => sum + Number(m.amount ?? 0), 0)
    const subCost = projectMaterial
      .filter((m) => m.bill_type === 'sub')
      .reduce((sum, m) => sum + Number(m.amount ?? 0), 0)
    const totalCost = laborCost + materialCost + subCost
    const revenue = Number(project.bid_total ?? 0)
    const profit = revenue - totalCost
    const margin = revenue > 0 ? profit / revenue : 0
    const bonus = calculateBonusPayout(margin, Number(project.bonus_pool ?? 0), bonusTiers)
    const sqftPerHr = totalHours > 0 ? totalSqft / totalHours : 0

    return {
      project,
      metrics: {
        totalHours,
        totalSqft,
        laborCost,
        materialCost,
        subCost,
        totalCost,
        revenue,
        profit,
        margin,
        bonus,
        sqftPerHr,
      },
    }
  })

  const byDivision = new Map<string, { revenue: number; cost: number; count: number }>()
  for (const row of analytics) {
    const current = byDivision.get(row.project.division_code) ?? { revenue: 0, cost: 0, count: 0 }
    current.revenue += row.metrics.revenue
    current.cost += row.metrics.totalCost
    current.count += 1
    byDivision.set(row.project.division_code, current)
  }

  return {
    projects: analytics,
    divisions: Array.from(byDivision.entries()).map(([divisionCode, totals]) => ({
      divisionCode,
      revenue: totals.revenue,
      cost: totals.cost,
      profit: totals.revenue - totals.cost,
      margin: totals.revenue > 0 ? ((totals.revenue - totals.cost) / totals.revenue) * 100 : 0,
      count: totals.count,
    })),
  }
}

async function listDivisionAnalytics(pool: Pool, companyId: string, options: { since?: string | null } = {}) {
  const since = options.since && options.since.trim() ? options.since.trim() : null

  const projectQueryParams: Array<string> = [companyId]
  let projectWhere = 'where p.company_id = $1'
  if (since) {
    projectQueryParams.push(since)
    projectWhere += ' and (p.updated_at >= $2::date or p.closed_at >= $2::date)'
  }

  const [projectRows, laborRows, materialRows, divisionRows] = await Promise.all([
    pool.query(
      `select p.id, p.name, p.division_code, p.status, p.bid_total, p.labor_rate
       from projects p
       ${projectWhere}
       order by p.updated_at desc`,
      projectQueryParams,
    ),
    pool.query('select project_id, hours, sqft_done from labor_entries where company_id = $1 and deleted_at is null', [
      companyId,
    ]),
    pool.query(
      'select project_id, amount, bill_type from material_bills where company_id = $1 and deleted_at is null',
      [companyId],
    ),
    pool.query('select code, name from divisions where company_id = $1 order by sort_order asc', [companyId]),
  ])

  const divisionNameByCode = new Map<string, string>()
  for (const row of divisionRows.rows) {
    divisionNameByCode.set(String(row.code), String(row.name))
  }

  type DivisionTotals = {
    total_revenue: number
    total_labor_cost: number
    total_material_cost: number
    total_sub_cost: number
    total_hours: number
    total_sqft: number
    project_count: number
    active_project_count: number
    completed_project_count: number
  }

  const totalsByDivision = new Map<string, DivisionTotals>()
  const ensureBucket = (code: string): DivisionTotals => {
    let bucket = totalsByDivision.get(code)
    if (!bucket) {
      bucket = {
        total_revenue: 0,
        total_labor_cost: 0,
        total_material_cost: 0,
        total_sub_cost: 0,
        total_hours: 0,
        total_sqft: 0,
        project_count: 0,
        active_project_count: 0,
        completed_project_count: 0,
      }
      totalsByDivision.set(code, bucket)
    }
    return bucket
  }

  const projectById = new Map<
    string,
    { id: string; division_code: string; status: string; labor_rate: number; bid_total: number }
  >()
  for (const project of projectRows.rows) {
    const code = String(project.division_code ?? '')
    if (!code) continue
    const bucket = ensureBucket(code)
    const revenue = Number(project.bid_total ?? 0)
    const laborRate = Number(project.labor_rate ?? 0)
    bucket.total_revenue += revenue
    bucket.project_count += 1
    const status = String(project.status ?? '')
    if (status === 'closed' || status === 'completed') {
      bucket.completed_project_count += 1
    } else {
      bucket.active_project_count += 1
    }
    projectById.set(String(project.id), {
      id: String(project.id),
      division_code: code,
      status,
      labor_rate: laborRate,
      bid_total: revenue,
    })
  }

  for (const labor of laborRows.rows) {
    const project = projectById.get(String(labor.project_id))
    if (!project) continue
    const bucket = totalsByDivision.get(project.division_code)
    if (!bucket) continue
    const hours = Number(labor.hours ?? 0)
    const sqft = Number(labor.sqft_done ?? 0)
    bucket.total_hours += hours
    bucket.total_sqft += sqft
    bucket.total_labor_cost += hours * project.labor_rate
  }

  for (const material of materialRows.rows) {
    const project = projectById.get(String(material.project_id))
    if (!project) continue
    const bucket = totalsByDivision.get(project.division_code)
    if (!bucket) continue
    const amount = Number(material.amount ?? 0)
    if (material.bill_type === 'sub') {
      bucket.total_sub_cost += amount
    } else {
      bucket.total_material_cost += amount
    }
  }

  const divisions = Array.from(totalsByDivision.entries())
    .map(([divisionCode, totals]) => {
      const totalCost = totals.total_labor_cost + totals.total_material_cost + totals.total_sub_cost
      const profit = totals.total_revenue - totalCost
      const margin = totals.total_revenue > 0 ? profit / totals.total_revenue : 0
      const sqftPerHour = totals.total_hours > 0 ? totals.total_sqft / totals.total_hours : 0

      return {
        division_code: divisionCode,
        division_name: divisionNameByCode.get(divisionCode) ?? divisionCode,
        project_count: totals.project_count,
        active_project_count: totals.active_project_count,
        completed_project_count: totals.completed_project_count,
        total_revenue: round2(totals.total_revenue),
        total_labor_cost: round2(totals.total_labor_cost),
        total_material_cost: round2(totals.total_material_cost),
        total_sub_cost: round2(totals.total_sub_cost),
        total_cost: round2(totalCost),
        profit: round2(profit),
        margin: round4(margin),
        total_hours: round2(totals.total_hours),
        total_sqft: round2(totals.total_sqft),
        sqft_per_hour: round2(sqftPerHour),
      }
    })
    .sort((a, b) => a.division_code.localeCompare(b.division_code))

  return { divisions, as_of: new Date().toISOString() }
}

export async function listServiceItemProductivity(pool: Pool, companyId: string) {
  const [laborRows, itemRows] = await Promise.all([
    pool.query(
      `select service_item_code, hours, sqft_done, occurred_on
       from labor_entries
       where company_id = $1
         and deleted_at is null
         and service_item_code is not null`,
      [companyId],
    ),
    pool.query('select code, name, unit from service_items where company_id = $1 and deleted_at is null', [companyId]),
  ])

  const itemsByCode = new Map<string, { code: string; name: string; unit: string }>()
  for (const row of itemRows.rows) {
    itemsByCode.set(String(row.code), { code: String(row.code), name: String(row.name), unit: String(row.unit) })
  }

  type EntryBucket = {
    entries: Array<{ quantity: number; hours: number }>
    firstSeen: string | null
    lastSeen: string | null
  }
  const byCode = new Map<string, EntryBucket>()
  for (const row of laborRows.rows) {
    const code = String(row.service_item_code ?? '').trim()
    if (!code) continue
    const quantity = Number(row.sqft_done ?? 0)
    const hours = Number(row.hours ?? 0)
    const occurredOn = row.occurred_on ? new Date(row.occurred_on).toISOString().slice(0, 10) : null

    let bucket = byCode.get(code)
    if (!bucket) {
      bucket = { entries: [], firstSeen: occurredOn, lastSeen: occurredOn }
      byCode.set(code, bucket)
    }
    bucket.entries.push({ quantity, hours })
    if (occurredOn) {
      if (!bucket.firstSeen || occurredOn < bucket.firstSeen) bucket.firstSeen = occurredOn
      if (!bucket.lastSeen || occurredOn > bucket.lastSeen) bucket.lastSeen = occurredOn
    }
  }

  const service_items = Array.from(byCode.entries())
    .map(([code, bucket]) => {
      const stats = computeProductivity({ entries: bucket.entries })
      const item = itemsByCode.get(code)
      return {
        code,
        name: item?.name ?? code,
        unit: item?.unit ?? 'sqft',
        samples: stats.samples,
        total_quantity: stats.total_quantity,
        total_hours: stats.total_hours,
        avg_quantity_per_hour: stats.avg,
        p50_quantity_per_hour: stats.p50,
        p90_quantity_per_hour: stats.p90,
        first_seen: bucket.firstSeen,
        last_seen: bucket.lastSeen,
      }
    })
    .sort((a, b) => a.code.localeCompare(b.code))

  return { service_items }
}

/**
 * Handle /api/analytics* requests:
 * - GET /api/analytics                              — per-project metrics + division roll-up
 * - GET /api/analytics/history                      — time-series labor metrics by division
 * - GET /api/analytics/divisions                    — admin/office; division roll-up snapshot
 * - GET /api/analytics/service-item-productivity    — admin/office; per-service-item productivity
 * - GET /api/analytics/labor/by-item                — admin/office; labor reports
 * - GET /api/analytics/labor/by-worker              — admin/office; labor reports
 * - GET /api/analytics/labor/by-week                — admin/office; labor reports
 *
 * The /divisions and /service-item-productivity routes do their own
 * membership-role lookup rather than going through ctx.requireRole
 * because the legacy semantics returned 403 with a specific error
 * message that the frontend depends on; preserving verbatim.
 */
export async function handleAnalyticsRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: AnalyticsRouteCtx,
): Promise<boolean> {
  if (req.method !== 'GET') return false

  if (url.pathname === '/api/analytics') {
    ctx.sendJson(200, await listAnalytics(ctx.pool, ctx.company.id))
    return true
  }

  if (url.pathname === '/api/analytics/history') {
    const from = url.searchParams.get('from') ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const to = url.searchParams.get('to') ?? new Date().toISOString()

    const result = await ctx.pool.query(
      `
      select
        date_trunc('day', le.occurred_on)::date as day,
        p.division_code,
        sum(le.hours) as total_hours,
        sum(le.sqft_done) as total_sqft,
        count(distinct p.id) as project_count
      from labor_entries le
      join projects p on le.project_id = p.id
      where le.company_id = $1 and le.occurred_on >= $2::timestamp and le.occurred_on < $3::timestamp and le.deleted_at is null
      group by date_trunc('day', le.occurred_on), p.division_code
      order by day desc
      `,
      [ctx.company.id, from, to],
    )

    const history = result.rows.map((row) => ({
      date: row.day,
      division: row.division_code,
      hours: Number(row.total_hours ?? 0),
      sqft: Number(row.total_sqft ?? 0),
      projects: Number(row.project_count ?? 0),
      productivity: Number(row.total_hours ?? 0) > 0 ? Number(row.total_sqft ?? 0) / Number(row.total_hours ?? 0) : 0,
    }))

    ctx.sendJson(200, { history, from, to })
    return true
  }

  if (url.pathname === '/api/analytics/divisions') {
    const role = await lookupRole(ctx.pool, ctx.company.id, ctx.currentUserId)
    if (role !== 'admin' && role !== 'office') {
      ctx.sendJson(403, { error: 'admin or office role required' })
      return true
    }
    const since = url.searchParams.get('since')
    ctx.sendJson(200, await listDivisionAnalytics(ctx.pool, ctx.company.id, { since }))
    return true
  }

  if (url.pathname === '/api/analytics/service-item-productivity') {
    const role = await lookupRole(ctx.pool, ctx.company.id, ctx.currentUserId)
    if (role !== 'admin' && role !== 'office') {
      ctx.sendJson(403, { error: 'admin or office role required' })
      return true
    }
    ctx.sendJson(200, await listServiceItemProductivity(ctx.pool, ctx.company.id))
    return true
  }

  if (url.pathname === '/api/analytics/labor/by-item') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const filters = parseLaborReportFilters(url.searchParams)
    ctx.sendJson(200, { rows: await listLaborByItem(ctx.pool, ctx.company.id, filters), filters })
    return true
  }

  if (url.pathname === '/api/analytics/labor/by-worker') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const filters = parseLaborReportFilters(url.searchParams)
    ctx.sendJson(200, { rows: await listLaborByWorker(ctx.pool, ctx.company.id, filters), filters })
    return true
  }

  if (url.pathname === '/api/analytics/labor/by-week') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const filters = parseLaborReportFilters(url.searchParams)
    ctx.sendJson(200, { rows: await listLaborByWeek(ctx.pool, ctx.company.id, filters), filters })
    return true
  }

  return false
}
