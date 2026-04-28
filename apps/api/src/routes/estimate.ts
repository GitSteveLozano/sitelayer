import type http from 'node:http'
import type { Pool } from 'pg'
import { compareBidVsScope } from '@sitelayer/domain'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, recordSyncEvent, withMutationTx, type LedgerExecutor } from '../mutation-tx.js'
import { HttpError } from '../http-utils.js'
import { buildEstimatePdfInputFromSummary, type EstimatePdfInput } from '../pdf.js'
import { summarizeProject } from './projects.js'
import { listServiceItemProductivity } from './analytics.js'

export type EstimateRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  /**
   * Stream a PDF response with CORS headers already applied. The ctx owner
   * wires `res.writeHead` + `renderEstimatePdf` so this module stays
   * framework-free.
   */
  sendPdf: (contentDisposition: string, input: EstimatePdfInput) => Promise<void>
}

type ForecastMeasurementInput = {
  service_item_code: string
  quantity: number
  unit?: string
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export async function createEstimateFromMeasurements(
  pool: Pool,
  companyId: string,
  projectId: string,
  executor?: LedgerExecutor,
) {
  const actualExecutor = executor ?? pool
  const projectResult = await actualExecutor.query<{
    id: string
    bid_total: string | number | null
    labor_rate: string | number | null
    bonus_pool: string | number | null
    division_code: string | null
  }>(
    'select id, bid_total, labor_rate, bonus_pool, division_code from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const [measurementsResult, serviceItemsResult] = await Promise.all([
    actualExecutor.query<{
      service_item_code: string
      quantity: string | number
      unit: string
      notes: string | null
      division_code: string | null
    }>(
      'select service_item_code, quantity, unit, notes, division_code from takeoff_measurements where company_id = $1 and project_id = $2 order by created_at asc',
      [companyId, projectId],
    ),
    actualExecutor.query<{ code: string; default_rate: string | null; unit: string }>(
      'select code, default_rate, unit from service_items where company_id = $1',
      [companyId],
    ),
  ])

  const itemIndex = new Map<string, { default_rate: string | null; unit: string }>()
  for (const item of serviceItemsResult.rows) {
    itemIndex.set(item.code, { default_rate: item.default_rate, unit: item.unit })
  }

  await actualExecutor.query('delete from estimate_lines where company_id = $1 and project_id = $2', [
    companyId,
    projectId,
  ])

  const projectDivisionCode = project.division_code ?? null
  type EstimateLineRow = {
    service_item_code: string
    quantity: string | number
    unit: string
    rate: number
    amount: number
    division_code: string | null
    created_at: string
  }
  let createdLines: EstimateLineRow[] = []
  if (measurementsResult.rows.length > 0) {
    // Single multi-row INSERT replaces the previous N round-trips. unnest()
    // turns the parallel arrays back into one row per measurement so we keep
    // the per-measurement rate/amount semantics.
    const codes: string[] = []
    const quantities: string[] = []
    const units: string[] = []
    const rates: string[] = []
    const amounts: string[] = []
    const divisions: (string | null)[] = []
    for (const measurement of measurementsResult.rows) {
      const item = itemIndex.get(measurement.service_item_code)
      const rate = Number(item?.default_rate ?? 0)
      const amount = Number(measurement.quantity) * rate
      // Per WhatsApp:227-229: an estimate line inherits the measurement's
      // division_code when the takeoff captured one, otherwise falls back to
      // the project's division_code so existing flows keep working.
      const effectiveDivisionCode = measurement.division_code ?? projectDivisionCode
      codes.push(measurement.service_item_code)
      quantities.push(String(measurement.quantity))
      units.push(item?.unit ?? measurement.unit)
      rates.push(String(rate))
      amounts.push(String(amount))
      divisions.push(effectiveDivisionCode)
    }
    const insertResult = await actualExecutor.query<EstimateLineRow>(
      `
      insert into estimate_lines (company_id, project_id, service_item_code, quantity, unit, rate, amount, division_code)
      select
        $1::uuid,
        $2::uuid,
        code,
        quantity::numeric,
        unit,
        rate::numeric,
        amount::numeric,
        division_code
      from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
        as t(code, quantity, unit, rate, amount, division_code)
      returning service_item_code, quantity, unit, rate, amount, division_code, created_at
      `,
      [companyId, projectId, codes, quantities, units, rates, amounts, divisions],
    )
    createdLines = insertResult.rows
  }

  const scopeTotal = createdLines.reduce((total, line) => total + Number(line.amount), 0)
  // Preserve the human-entered bid_total once set. Only overwrite it on the
  // first estimate computation for a brand-new project (bid_total === 0),
  // which keeps the seed/demo flow working. Afterwards, bid_total is the
  // source of truth for the contract price and drift is surfaced through
  // `scope_vs_bid`.
  const existingBidTotal = Number(project.bid_total ?? 0)
  const bidTotal = existingBidTotal > 0 ? existingBidTotal : scopeTotal
  if (existingBidTotal <= 0 && scopeTotal > 0) {
    await actualExecutor.query(
      'update projects set bid_total = $1, updated_at = now(), version = version + 1 where company_id = $2 and id = $3',
      [scopeTotal, companyId, projectId],
    )
  } else {
    await actualExecutor.query(
      'update projects set updated_at = now(), version = version + 1 where company_id = $1 and id = $2',
      [companyId, projectId],
    )
  }

  return {
    projectId,
    bidTotal,
    scopeTotal,
    lines: createdLines,
  }
}

export async function getScopeVsBid(pool: Pool, companyId: string, projectId: string) {
  const projectResult = await pool.query<{ bid_total: string | number | null }>(
    'select bid_total from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const linesResult = await pool.query(
    `select service_item_code, quantity, unit, rate, amount, division_code, created_at
     from estimate_lines
     where company_id = $1 and project_id = $2
     order by created_at asc, service_item_code asc`,
    [companyId, projectId],
  )

  const bidTotal = Number(project.bid_total ?? 0)
  const scopeTotal = linesResult.rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
  const comparison = compareBidVsScope({ bidTotal, scopeTotal })

  return {
    ...comparison,
    lines: linesResult.rows,
  }
}

async function listServiceItemDivisions(pool: Pool, companyId: string, serviceItemCode: string) {
  const result = await pool.query<{ division_code: string; created_at: string }>(
    `select division_code, created_at
     from service_item_divisions
     where company_id = $1 and service_item_code = $2
     order by created_at asc`,
    [companyId, serviceItemCode],
  )
  return result.rows
}

async function forecastProjectHours(pool: Pool, companyId: string, projectId: string, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be an object')
  }
  const measurements = (body as { measurements?: unknown }).measurements
  if (!Array.isArray(measurements) || measurements.length === 0) {
    throw new HttpError(400, 'measurements[] is required')
  }

  const normalized: ForecastMeasurementInput[] = measurements.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(400, `measurements[${index}] must be an object`)
    }
    const m = entry as Record<string, unknown>
    const code = String(m.service_item_code ?? '').trim()
    const quantity = Number(m.quantity ?? 0)
    const unit = m.unit === undefined || m.unit === null ? '' : String(m.unit).trim()
    if (!code) throw new HttpError(400, `measurements[${index}].service_item_code is required`)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpError(400, `measurements[${index}].quantity must be positive`)
    }
    return { service_item_code: code, quantity, unit }
  })

  const [projectRows, serviceItemRows, bonusRuleRows, productivity] = await Promise.all([
    pool.query('select id, target_sqft_per_hr, labor_rate from projects where company_id = $1 and id = $2 limit 1', [
      companyId,
      projectId,
    ]),
    pool.query('select code, default_rate from service_items where company_id = $1 and deleted_at is null', [
      companyId,
    ]),
    pool.query('select config from bonus_rules where company_id = $1 order by created_at desc limit 1', [companyId]),
    listServiceItemProductivity(pool, companyId),
  ])

  const project = projectRows.rows[0]
  if (!project) throw new HttpError(404, 'project not found')

  const laborRate = Number(project.labor_rate ?? 0)
  const projectTarget =
    project.target_sqft_per_hr != null && Number(project.target_sqft_per_hr) > 0
      ? Number(project.target_sqft_per_hr)
      : null

  const bonusConfig = bonusRuleRows.rows[0]?.config as { target_sqft_per_hr?: number } | undefined
  const bonusTarget =
    bonusConfig?.target_sqft_per_hr != null && Number(bonusConfig.target_sqft_per_hr) > 0
      ? Number(bonusConfig.target_sqft_per_hr)
      : null

  const productivityByCode = new Map<string, (typeof productivity.service_items)[number]>()
  for (const item of productivity.service_items) {
    productivityByCode.set(item.code, item)
  }

  const defaultRateByCode = new Map<string, number | null>()
  for (const row of serviceItemRows.rows) {
    const code = String(row.code)
    const rate = row.default_rate == null ? null : Number(row.default_rate)
    defaultRateByCode.set(code, Number.isFinite(rate ?? NaN) ? (rate as number) : null)
  }

  const forecast = normalized.map((m) => {
    const stats = productivityByCode.get(m.service_item_code)
    let rate: number | null = null
    let basis: 'p50' | 'p90' | 'project_target' | 'bonus_rule_target' | 'default_rate' | 'no_data' = 'no_data'

    if (stats && stats.samples >= 3 && stats.p50_quantity_per_hour && stats.p50_quantity_per_hour > 0) {
      rate = stats.p50_quantity_per_hour
      basis = 'p50'
    } else if (projectTarget) {
      rate = projectTarget
      basis = 'project_target'
    } else if (bonusTarget) {
      rate = bonusTarget
      basis = 'bonus_rule_target'
    } else {
      const defaultRate = defaultRateByCode.get(m.service_item_code) ?? null
      if (defaultRate && defaultRate > 0) {
        rate = defaultRate
        basis = 'default_rate'
      }
    }

    const projectedHours = rate && rate > 0 ? m.quantity / rate : null
    const projectedCost = projectedHours != null ? projectedHours * laborRate : null

    return {
      service_item_code: m.service_item_code,
      quantity: m.quantity,
      projected_hours: projectedHours == null ? null : round2(projectedHours),
      projected_cost: projectedCost == null ? null : round2(projectedCost),
      basis,
    }
  })

  return { forecast }
}

/**
 * Handle project estimate routes:
 * - POST /api/projects/<id>/estimate/recompute       — admin/foreman/office;
 *                                                      rebuild estimate_lines
 * - GET  /api/projects/<id>/estimate/scope-vs-bid   — scope-vs-contract
 *                                                      comparison
 * - GET  /api/projects/<id>/estimate.pdf             — admin/office; PDF stream
 * - POST /api/projects/<id>/estimate/forecast-hours — admin/office; ML forecast
 * - GET  /api/service-items/<code>/divisions         — list xref divisions
 * - PUT  /api/service-items/<code>/divisions         — admin/office; replace set
 */
export async function handleEstimateRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: EstimateRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\/recompute$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const estimate = await withMutationTx(async (client) => {
      const computed = await createEstimateFromMeasurements(ctx.pool, ctx.company.id, projectId, client)
      if (!computed) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'estimate',
        entityId: projectId,
        action: 'recompute',
        syncPayload: { action: 'recompute', estimate: computed },
        outboxPayload: computed as Record<string, unknown>,
      })
      return computed
    })
    if (!estimate) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const scopeVsBid = await getScopeVsBid(ctx.pool, ctx.company.id, projectId)
    ;(estimate as { scope_vs_bid?: unknown }).scope_vs_bid = scopeVsBid
    ctx.sendJson(200, estimate)
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\/scope-vs-bid$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const result = await getScopeVsBid(ctx.pool, ctx.company.id, projectId)
    if (!result) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    ctx.sendJson(200, result)
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\.pdf$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
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
    const pdfInput = buildEstimatePdfInputFromSummary({
      company: { name: ctx.company.name, slug: ctx.company.slug },
      summary,
      appUrl: process.env.APP_PUBLIC_URL ?? 'https://sitelayer.sandolab.xyz',
    })
    const filename = `estimate-${summary.project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)}.pdf`
    await ctx.sendPdf(`attachment; filename="${filename}"`, pdfInput)
    return true
  }

  const forecastHoursMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/estimate\/forecast-hours$/)
  if (req.method === 'POST' && forecastHoursMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = forecastHoursMatch[1] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    try {
      const result = await forecastProjectHours(ctx.pool, ctx.company.id, projectId, body)
      ctx.sendJson(200, result)
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  const divisionsMatch = url.pathname.match(/^\/api\/service-items\/([^/]+)\/divisions$/)
  if (divisionsMatch) {
    const code = decodeURIComponent(divisionsMatch[1] ?? '')
    if (req.method === 'GET') {
      const divisions = await listServiceItemDivisions(ctx.pool, ctx.company.id, code)
      ctx.sendJson(200, { service_item_code: code, divisions })
      return true
    }
    if (req.method === 'PUT') {
      if (!ctx.requireRole(['admin', 'office'])) return true
      const body = await ctx.readBody()
      const rawCodes = Array.isArray(body.division_codes) ? body.division_codes : null
      if (!rawCodes) {
        ctx.sendJson(400, { error: 'division_codes must be an array' })
        return true
      }
      const divisionCodes = Array.from(
        new Set(
          rawCodes
            .map((value: unknown) => (typeof value === 'string' ? value.trim() : ''))
            .filter((value: string) => value.length > 0),
        ),
      )
      // Verify the service item exists for this company so we can
      // return a clean 404 rather than a FK error.
      const serviceItemExists = await ctx.pool.query<{ exists: boolean }>(
        `select exists(
           select 1 from service_items
            where company_id = $1 and code = $2 and deleted_at is null
         ) as exists`,
        [ctx.company.id, code],
      )
      if (!serviceItemExists.rows[0]?.exists) {
        ctx.sendJson(404, { error: 'service item not found' })
        return true
      }
      if (divisionCodes.length > 0) {
        const validDivisions = await ctx.pool.query<{ code: string }>(
          `select code from divisions where company_id = $1 and code = any($2::text[])`,
          [ctx.company.id, divisionCodes],
        )
        const validSet = new Set(validDivisions.rows.map((row) => row.code))
        const unknown = divisionCodes.filter((value) => !validSet.has(value))
        if (unknown.length > 0) {
          ctx.sendJson(400, {
            error: 'one or more division_codes do not exist for this company',
            unknown,
          })
          return true
        }
      }
      await withMutationTx(async (client) => {
        await client.query(`delete from service_item_divisions where company_id = $1 and service_item_code = $2`, [
          ctx.company.id,
          code,
        ])
        if (divisionCodes.length > 0) {
          // Single multi-row INSERT replaces the previous
          // per-division round-trip. on conflict do nothing keeps
          // the migration idempotent if a division pair is
          // re-asserted between the delete and insert.
          await client.query(
            `insert into service_item_divisions (company_id, service_item_code, division_code)
             select $1::uuid, $2::text, division_code
             from unnest($3::text[]) as t(division_code)
             on conflict do nothing`,
            [ctx.company.id, code, divisionCodes],
          )
        }
        await recordSyncEvent(
          ctx.company.id,
          'service_item_divisions',
          code,
          { action: 'replace', divisions: divisionCodes },
          null,
          { executor: client },
        )
      })
      const divisions = await listServiceItemDivisions(ctx.pool, ctx.company.id, code)
      ctx.sendJson(200, { service_item_code: code, divisions })
      return true
    }
  }

  return false
}
