import type http from 'node:http'
import type { Pool } from 'pg'
import ExcelJS from 'exceljs'
import {
  compareBidVsScope,
  deriveMeasurementDrivers,
  normalizeGeometry,
  repriceForTargetMargin,
  type MeasurementDrivers,
} from '@sitelayer/domain'
import type { ActiveCompany } from '../auth-types.js'
import {
  recordMutationLedger,
  recordSyncEvent,
  withCompanyClient,
  withMutationTx,
  type LedgerExecutor,
} from '../mutation-tx.js'
import { HttpError, isValidUuid } from '../http-utils.js'
import { assertServiceItemCatalogStatus, rejectionMessageForCatalog } from '../catalog.js'
import { buildEstimatePdfInputFromSummary, isReportKind, type EstimatePdfInput } from '../pdf.js'
import { resolvePrices } from '../pricing.js'
import { explodeMeasurement, loadAssembliesByMeasurement } from '../assembly-explode.js'
import { loadDefaultPricingProfileConfig } from '../pricing-profile-config.js'
import { summarizeProject } from './projects.js'
import { listServiceItemProductivity } from './analytics.js'
import { resolveDefaultDraftId, validateDraftId } from './takeoff-drafts.js'

export type EstimateRouteCtx = {
  pool: Pool
  company: ActiveCompany
  /** Clerk user id of the caller; stamped on the audit/sync ledger for line edits. */
  currentUserId?: string | null
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  /**
   * Stream a PDF response with CORS headers already applied. The ctx owner
   * wires `res.writeHead` + `renderEstimatePdf` so this module stays
   * framework-free.
   */
  sendPdf: (contentDisposition: string, input: EstimatePdfInput) => Promise<void>
  /** Stream a non-JSON file body (CORS headers applied by the ctx owner). */
  sendFileContent: (mimeType: string, fileName: string, content: Buffer | string) => void
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return `"${s.replace(/"/g, '""')}"`
}

/**
 * Serialize an estimate's line items to CSV (Excel-friendly: UTF-8 BOM + CRLF
 * so Excel opens it cleanly). Columns mirror the estimate PDF, plus a trailing
 * Total row. PlanSwift-parity quick win — opens directly in a spreadsheet; a
 * formatted .xlsx (exceljs) can layer on later.
 */
function buildEstimateCsv(
  projectName: string,
  lines: Array<{
    service_item_code: string
    quantity: number | string
    unit: string
    rate: number | string
    amount: number | string
  }>,
): string {
  const rows: string[] = [
    ['Project', projectName].map(csvCell).join(','),
    '',
    ['Item', 'Quantity', 'Unit', 'Rate', 'Amount'].map(csvCell).join(','),
  ]
  let total = 0
  for (const line of lines) {
    rows.push([line.service_item_code, line.quantity, line.unit, line.rate, line.amount].map(csvCell).join(','))
    total += Number(line.amount) || 0
  }
  rows.push(['', '', '', 'Total', total.toFixed(2)].map(csvCell).join(','))
  return `\ufeff${rows.join('\r\n')}\r\n`
}

/**
 * PlanSwift-parity Excel export (Phase 0). Same line-item shape as the CSV, but
 * a real .xlsx workbook with a bold header, numeric Rate/Amount columns, and a
 * bold total row so estimators can drop it straight into their own sheets.
 */
async function buildEstimateXlsx(
  projectName: string,
  lines: Array<{
    service_item_code: string
    quantity: number | string
    unit: string
    rate: number | string
    amount: number | string
  }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Sitelayer'
  const ws = wb.addWorksheet('Estimate')
  ws.addRow(['Project', projectName]).font = { bold: true }
  ws.addRow([])
  ws.addRow(['Item', 'Quantity', 'Unit', 'Rate', 'Amount']).font = { bold: true }
  let total = 0
  for (const line of lines) {
    ws.addRow([
      line.service_item_code,
      Number(line.quantity) || 0,
      line.unit,
      Number(line.rate) || 0,
      Number(line.amount) || 0,
    ])
    total += Number(line.amount) || 0
  }
  ws.addRow(['', '', '', 'Total', Number(total.toFixed(2))]).font = { bold: true }
  ws.getColumn(4).numFmt = '#,##0.00'
  ws.getColumn(5).numFmt = '#,##0.00'
  ws.columns.forEach((col) => {
    col.width = 18
  })
  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer as ArrayBuffer)
}

type ForecastMeasurementInput = {
  service_item_code: string
  quantity: number
  unit?: string
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Phase A.4 helper. Resolve the draft to operate on for an estimate route.
 * Accepts `?draft_id=` (always) and `body.draft_id` (POST only). Validates
 * the uuid syntactically and the tenancy / project membership against
 * `takeoff_drafts`. Returns:
 *   - a uuid string when the caller supplied a valid draft_id
 *   - null when no draft_id was supplied (the helper that consumes this
 *     value will fall back to the project's default draft)
 *   - undefined when validation failed and a 400 was already sent — the
 *     caller should `return true` immediately
 */
async function resolveDraftIdParam(
  ctx: EstimateRouteCtx,
  url: URL,
  body: Record<string, unknown>,
  projectId: string,
): Promise<string | null | undefined> {
  const fromQuery = url.searchParams.get('draft_id')
  const fromBody = typeof body.draft_id === 'string' ? body.draft_id.trim() : ''
  const raw = (fromQuery ?? fromBody ?? '').trim()
  if (!raw) return null
  if (!isValidUuid(raw)) {
    ctx.sendJson(400, { error: 'draft_id must be a valid uuid' })
    return undefined
  }
  const ok = await validateDraftId(ctx.pool, ctx.company.id, projectId, raw)
  if (!ok) {
    ctx.sendJson(400, { error: 'draft_id does not belong to this project' })
    return undefined
  }
  return raw
}

export async function createEstimateFromMeasurements(
  pool: Pool,
  companyId: string,
  projectId: string,
  options: { draftId?: string | null; executor?: LedgerExecutor } = {},
) {
  const actualExecutor = options.executor ?? pool
  const projectResult = await actualExecutor.query<{
    id: string
    customer_id: string | null
    bid_total: string | number | null
    labor_rate: string | number | null
    bonus_pool: string | number | null
    division_code: string | null
  }>(
    'select id, customer_id, bid_total, labor_rate, bonus_pool, division_code from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  // Resolve the target draft. Phase A.4: each draft owns its own
  // estimate; recompute rebuilds estimate_lines for that draft only.
  // Lines on sibling drafts (e.g. archived proposals, the future drone
  // pipeline draft) survive untouched.
  const draftId = options.draftId ?? (await resolveDefaultDraftId(pool, companyId, projectId))

  const measurementsResult = await actualExecutor.query<{
    service_item_code: string
    quantity: string | number
    unit: string
    notes: string | null
    division_code: string | null
    is_deduction: boolean
    assembly_id: string | null
    geometry: unknown
  }>(
    draftId
      ? 'select service_item_code, quantity, unit, notes, division_code, is_deduction, assembly_id, geometry from takeoff_measurements where company_id = $1 and project_id = $2 and draft_id = $3 and deleted_at is null order by created_at asc'
      : 'select service_item_code, quantity, unit, notes, division_code, is_deduction, assembly_id, geometry from takeoff_measurements where company_id = $1 and project_id = $2 and draft_id is null and deleted_at is null order by created_at asc',
    draftId ? [companyId, projectId, draftId] : [companyId, projectId],
  )

  // Pull each measurement's effective rate through the pricing chain
  // (project_override → customer → company → qbo → service_items.default_rate)
  // in one query, instead of the old "snapshot every service_items row
  // and look up default_rate" path. This both honors per-project and
  // per-customer overrides and falls back to the same default_rate the
  // old code used when nothing higher-priority matches.
  const distinctCodes = Array.from(new Set(measurementsResult.rows.map((row) => row.service_item_code).filter(Boolean)))
  const priceIndex = await resolvePrices({
    pool: actualExecutor,
    company_id: companyId,
    project_id: projectId,
    customer_id: project.customer_id,
    service_item_codes: distinctCodes,
  })

  // Phase A.4: scope the wipe to the target draft so sibling drafts'
  // estimate_lines survive untouched. Null-draft callers (projects with
  // no draft pre-066, or hard-deleted-draft orphans) get the legacy
  // "wipe everything" behavior so they still recompute correctly.
  if (draftId) {
    await actualExecutor.query(
      'delete from estimate_lines where company_id = $1 and project_id = $2 and draft_id = $3',
      [companyId, projectId, draftId],
    )
  } else {
    await actualExecutor.query(
      'delete from estimate_lines where company_id = $1 and project_id = $2 and draft_id is null',
      [companyId, projectId],
    )
  }

  const projectDivisionCode = project.division_code ?? null

  // PlanSwift Phase 2: hydrate the assemblies attached to this draft's
  // measurements (if any) + the company's markup profile, so an
  // assembly-attached measurement explodes into N priced component lines
  // instead of one flat line. Both loads are no-ops when nothing attaches an
  // assembly (the common case), so the flat-line path pays ~nothing.
  const assembliesById = await loadAssembliesByMeasurement(actualExecutor, companyId, measurementsResult.rows)
  const profileConfig =
    assembliesById.size > 0 ? await loadDefaultPricingProfileConfig(actualExecutor, companyId) : null
  // Surface the per-measurement markup breakdown on the recompute response so
  // the estimate UI can render the transparency panel without a second call.
  const assemblyBreakdowns: Array<{ assembly_id: string; service_item_code: string; markup: unknown }> = []

  type EstimateLineRow = {
    service_item_code: string
    quantity: string | number
    unit: string
    rate: number
    amount: number
    division_code: string | null
    assembly_id: string | null
    assembly_component_id: string | null
    kind: string | null
    created_at: string
  }
  let createdLines: EstimateLineRow[] = []
  if (measurementsResult.rows.length > 0) {
    // Single multi-row INSERT replaces the previous N round-trips. unnest()
    // turns the parallel arrays back into one row per estimate line so we keep
    // the per-line rate/amount semantics. Phase 2 extends the parallel arrays
    // with the assembly provenance columns (assembly_id / assembly_component_id
    // / kind), NULL for flat (non-assembly) lines.
    const codes: string[] = []
    const quantities: string[] = []
    const units: string[] = []
    const rates: string[] = []
    const amounts: string[] = []
    const divisions: (string | null)[] = []
    const assemblyIds: (string | null)[] = []
    const assemblyComponentIds: (string | null)[] = []
    const kinds: (string | null)[] = []
    for (const measurement of measurementsResult.rows) {
      // Per WhatsApp:227-229: an estimate line inherits the measurement's
      // division_code when the takeoff captured one, otherwise falls back to
      // the project's division_code so existing flows keep working.
      const effectiveDivisionCode = measurement.division_code ?? projectDivisionCode

      const attached = measurement.assembly_id ? assembliesById.get(measurement.assembly_id) : undefined
      if (attached) {
        // M2: derive the real-world drivers (height/width/thickness/perimeter/
        // sides) from the stored geometry so component formulas + include_when
        // can reference them. Malformed geometry → no drivers (every driver
        // binds to 0), preserving the pre-M2 behavior for those rows.
        const geometry = normalizeGeometry(measurement.geometry)
        const drivers: MeasurementDrivers | undefined = geometry ? deriveMeasurementDrivers(geometry) : undefined
        // EXPLODE path. Throws HttpError(400) on a bad component formula so the
        // whole recompute transaction rolls back — no partial estimate write.
        const exploded = explodeMeasurement({
          assembly: attached,
          measurementQuantity: Number(measurement.quantity),
          measurementUnit: measurement.unit,
          isDeduction: measurement.is_deduction,
          divisionCode: effectiveDivisionCode,
          fallbackServiceItemCode: measurement.service_item_code,
          profileConfig,
          drivers,
        })
        assemblyBreakdowns.push({
          assembly_id: attached.header.id,
          service_item_code: attached.header.service_item_code,
          markup: exploded.markup,
        })
        for (const line of exploded.lines) {
          codes.push(line.service_item_code)
          quantities.push(String(line.quantity))
          units.push(line.unit)
          rates.push(String(line.rate))
          amounts.push(String(line.amount))
          divisions.push(line.division_code)
          assemblyIds.push(line.assembly_id)
          assemblyComponentIds.push(line.assembly_component_id)
          kinds.push(line.kind)
        }
        continue
      }

      // FLAT-LINE path (unchanged). Also the safe fallback when an attached
      // assembly was soft-deleted after attach (absent from assembliesById).
      const resolved = priceIndex.get(measurement.service_item_code)
      const rate = resolved?.price ?? 0
      // PlanSwift Phase 1 cutout/deduct: a deduction measurement (e.g. a window
      // opening) contributes a NEGATIVE quantity + amount so the net rolls up
      // correctly everywhere downstream — scope-vs-bid totals, the estimate
      // PDF, and the QBO push all just sum the signed line values. The stored
      // measurement quantity stays positive; only the derived line is signed.
      const sign = measurement.is_deduction ? -1 : 1
      const signedQuantity = Number(measurement.quantity) * sign
      const amount = signedQuantity * rate
      codes.push(measurement.service_item_code)
      quantities.push(String(signedQuantity))
      units.push(resolved?.unit || measurement.unit)
      rates.push(String(rate))
      amounts.push(String(amount))
      divisions.push(effectiveDivisionCode)
      assemblyIds.push(null)
      assemblyComponentIds.push(null)
      kinds.push(null)
    }
    if (codes.length > 0) {
      const insertResult = await actualExecutor.query<EstimateLineRow>(
        `
      insert into estimate_lines (company_id, project_id, draft_id, service_item_code, quantity, unit, rate, amount, division_code, assembly_id, assembly_component_id, kind)
      select
        $1::uuid,
        $2::uuid,
        $9::uuid,
        code,
        quantity::numeric,
        unit,
        rate::numeric,
        amount::numeric,
        division_code,
        nullif(assembly_id, '')::uuid,
        nullif(assembly_component_id, '')::uuid,
        kind
      from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $10::text[], $11::text[], $12::text[])
        as t(code, quantity, unit, rate, amount, division_code, assembly_id, assembly_component_id, kind)
      returning service_item_code, quantity, unit, rate, amount, division_code, assembly_id, assembly_component_id, kind, created_at
      `,
        [
          companyId,
          projectId,
          codes,
          quantities,
          units,
          rates,
          amounts,
          divisions,
          draftId,
          // unnest over text[] needs '' sentinels for NULL uuids; nullif(...)
          // above turns them back into SQL NULL.
          assemblyIds.map((v) => v ?? ''),
          assemblyComponentIds.map((v) => v ?? ''),
          kinds,
        ],
      )
      createdLines = insertResult.rows
    }
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
    draftId,
    bidTotal,
    scopeTotal,
    lines: createdLines,
    // PlanSwift Phase 2: per-assembly markup breakdown for the transparency
    // panel (empty when no measurement attaches an assembly).
    assemblyBreakdowns,
  }
}

export async function getScopeVsBid(
  pool: Pool,
  companyId: string,
  projectId: string,
  options: { draftId?: string | null } = {},
) {
  const projectResult = await withCompanyClient(companyId, (client) =>
    client.query<{ bid_total: string | number | null }>(
      'select bid_total from projects where company_id = $1 and id = $2 limit 1',
      [companyId, projectId],
    ),
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const draftId = options.draftId ?? (await resolveDefaultDraftId(pool, companyId, projectId))

  const linesResult = await withCompanyClient(companyId, (client) =>
    client.query(
      draftId
        ? `select id, service_item_code, quantity, unit, rate, amount, division_code,
                  assembly_id, assembly_component_id, kind, created_at
           from estimate_lines
          where company_id = $1 and project_id = $2 and draft_id = $3
          order by created_at asc, service_item_code asc`
        : `select id, service_item_code, quantity, unit, rate, amount, division_code,
                  assembly_id, assembly_component_id, kind, created_at
           from estimate_lines
          where company_id = $1 and project_id = $2 and draft_id is null
          order by created_at asc, service_item_code asc`,
      draftId ? [companyId, projectId, draftId] : [companyId, projectId],
    ),
  )

  const bidTotal = Number(project.bid_total ?? 0)
  const scopeTotal = linesResult.rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
  const comparison = compareBidVsScope({ bidTotal, scopeTotal })

  // H4 staleness signal. The recompute path deletes + re-inserts every
  // estimate_lines row for the draft (see createEstimateFromMeasurements),
  // so the newest line's created_at is a faithful "estimate last recomputed"
  // timestamp without needing a dedicated recomputed_at column. We compare it
  // against the newest mutation on the inputs the estimate is derived from —
  // the draft's live measurements (new/edited measurements insert fresh rows)
  // and any assemblies (+ their components) those measurements attach (rate /
  // component edits bump assemblies.updated_at). If a source row is newer than
  // the estimate, the estimate is out of date and the UI shows a recompute
  // banner. Derived, additive, and read-only — no schema change.
  //
  // node-pg returns timestamptz as Date (no type parser override here), so we
  // normalize to ISO strings for the JSON contract and compare on epoch millis.
  const toIso = (value: unknown): string | null => {
    if (value == null) return null
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
    const d = new Date(value as string)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const recomputedAt = linesResult.rows.reduce<string | null>((latest, row) => {
    const ts = toIso(row.created_at)
    if (!ts) return latest
    return latest === null || ts > latest ? ts : latest
  }, null)

  const sourceResult = await withCompanyClient(companyId, (client) =>
    client.query<{ source_updated_at: string | null }>(
      draftId
        ? `select max(ts) as source_updated_at from (
             select created_at as ts
               from takeoff_measurements
              where company_id = $1 and project_id = $2 and draft_id = $3 and deleted_at is null
             union all
             select greatest(a.updated_at, coalesce(max(c.updated_at), a.updated_at)) as ts
               from takeoff_measurements m
               join service_item_assemblies a
                 on a.company_id = m.company_id and a.id = m.assembly_id and a.deleted_at is null
               left join service_item_assembly_components c
                 on c.company_id = a.company_id and c.assembly_id = a.id
              where m.company_id = $1 and m.project_id = $2 and m.draft_id = $3
                and m.deleted_at is null and m.assembly_id is not null
              group by a.id, a.updated_at
           ) sources`
        : `select max(ts) as source_updated_at from (
             select created_at as ts
               from takeoff_measurements
              where company_id = $1 and project_id = $2 and draft_id is null and deleted_at is null
             union all
             select greatest(a.updated_at, coalesce(max(c.updated_at), a.updated_at)) as ts
               from takeoff_measurements m
               join service_item_assemblies a
                 on a.company_id = m.company_id and a.id = m.assembly_id and a.deleted_at is null
               left join service_item_assembly_components c
                 on c.company_id = a.company_id and c.assembly_id = a.id
              where m.company_id = $1 and m.project_id = $2 and m.draft_id is null
                and m.deleted_at is null and m.assembly_id is not null
              group by a.id, a.updated_at
           ) sources`,
      draftId ? [companyId, projectId, draftId] : [companyId, projectId],
    ),
  )
  const sourceUpdatedAt = toIso(sourceResult.rows[0]?.source_updated_at)
  // Stale only when we have both a computed estimate and a newer source edit.
  // Both are normalized ISO strings, so lexical > matches chronological >.
  const isStale = recomputedAt !== null && sourceUpdatedAt !== null && sourceUpdatedAt > recomputedAt

  return {
    ...comparison,
    draft_id: draftId,
    recomputed_at: recomputedAt,
    source_updated_at: sourceUpdatedAt,
    is_stale: isStale,
    lines: linesResult.rows,
  }
}

async function listServiceItemDivisions(_pool: Pool, companyId: string, serviceItemCode: string) {
  const result = await withCompanyClient(companyId, (client) =>
    client.query<{ division_code: string; created_at: string }>(
      `select division_code, created_at
     from service_item_divisions
     where company_id = $1 and service_item_code = $2
     order by created_at asc`,
      [companyId, serviceItemCode],
    ),
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

  const [[projectRows, serviceItemRows, bonusRuleRows], productivity] = await Promise.all([
    withCompanyClient(companyId, async (client) =>
      Promise.all([
        client.query(
          'select id, target_sqft_per_hr, labor_rate from projects where company_id = $1 and id = $2 limit 1',
          [companyId, projectId],
        ),
        client.query('select code, default_rate from service_items where company_id = $1 and deleted_at is null', [
          companyId,
        ]),
        client.query('select config from bonus_rules where company_id = $1 order by created_at desc limit 1', [
          companyId,
        ]),
      ]),
    ),
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
 * - PATCH /api/estimate-lines/<id>                     — admin/foreman/office;
 *                                                       per-line qty/rate edit
 *                                                       (mobile estimate review +
 *                                                       desktop builder)
 */
export async function handleEstimateRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: EstimateRouteCtx,
): Promise<boolean> {
  // PATCH /api/estimate-lines/<id> — update a single estimate line's
  // quantity and/or rate in place. Unlike the recompute path (which
  // rebuilds every line from takeoff_measurements), this lets the
  // estimate review screens nudge one line without blowing away manual
  // edits on siblings.
  //
  // Concurrency: estimate_lines carries no `version`/`updated_at` column,
  // so the optimistic guard is value-based — the client may send
  // `expected_amount` (the line `amount` it last saw). A mismatch means
  // another writer (or a recompute) moved the line; we 409 with the
  // current amount so the client reloads. Omitting `expected_amount`
  // opts out, matching `assertVersion`'s null-version behavior.
  //
  // Catalog: enforced the same way the takeoff measurement writes do —
  // the line's service_item_code must be in the curated catalog for its
  // division_code (`assertServiceItemCatalogStatus`).
  const estimateLineMatch = url.pathname.match(/^\/api\/estimate-lines\/([^/]+)$/)
  if (req.method === 'PATCH' && estimateLineMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const lineId = decodeURIComponent(estimateLineMatch[1] ?? '')
    if (!isValidUuid(lineId)) {
      ctx.sendJson(400, { error: 'estimate line id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()

    const hasQuantity = body.quantity !== undefined && body.quantity !== null && body.quantity !== ''
    const hasRate = body.rate !== undefined && body.rate !== null && body.rate !== ''
    if (!hasQuantity && !hasRate) {
      ctx.sendJson(400, { error: 'quantity or rate is required' })
      return true
    }

    let quantity: number | null = null
    if (hasQuantity) {
      const parsed = Number(body.quantity)
      if (!Number.isFinite(parsed) || parsed < 0) {
        ctx.sendJson(400, { error: 'quantity must be a non-negative number' })
        return true
      }
      quantity = parsed
    }
    let rate: number | null = null
    if (hasRate) {
      const parsed = Number(body.rate)
      if (!Number.isFinite(parsed) || parsed < 0) {
        ctx.sendJson(400, { error: 'rate must be a non-negative number' })
        return true
      }
      rate = parsed
    }

    const hasExpectedAmount =
      body.expected_amount !== undefined && body.expected_amount !== null && body.expected_amount !== ''
    let expectedAmount: number | null = null
    if (hasExpectedAmount) {
      const parsed = Number(body.expected_amount)
      if (!Number.isFinite(parsed)) {
        ctx.sendJson(400, { error: 'expected_amount must be a number' })
        return true
      }
      expectedAmount = parsed
    }

    const existing = await withCompanyClient(ctx.company.id, (client) =>
      client.query<{
        id: string
        project_id: string
        draft_id: string | null
        service_item_code: string
        quantity: string
        unit: string
        rate: string
        amount: string
        division_code: string | null
      }>(
        `select id, project_id, draft_id, service_item_code, quantity, unit, rate, amount, division_code
           from estimate_lines
          where company_id = $1 and id = $2
          limit 1`,
        [ctx.company.id, lineId],
      ),
    )
    const line = existing.rows[0]
    if (!line) {
      ctx.sendJson(404, { error: 'estimate line not found' })
      return true
    }

    // Optimistic guard: round both sides to cents so a string/number
    // round-trip through numeric(12,2) doesn't produce a phantom conflict.
    if (expectedAmount !== null && round2(Number(line.amount)) !== round2(expectedAmount)) {
      ctx.sendJson(409, { error: 'version conflict', current_amount: Number(line.amount) })
      return true
    }

    // Catalog enforcement — same gate the takeoff measurement writes use.
    const catalog = await assertServiceItemCatalogStatus(
      ctx.pool,
      ctx.company.id,
      line.service_item_code,
      line.division_code,
    )
    if (!catalog.ok) {
      ctx.sendJson(422, { error: rejectionMessageForCatalog(catalog.reason), reason: catalog.reason })
      return true
    }

    const nextQuantity = quantity ?? Number(line.quantity)
    const nextRate = rate ?? Number(line.rate)
    const nextAmount = round2(nextQuantity * nextRate)

    const updated = await withMutationTx(async (client) => {
      const result = await client.query<{
        id: string
        service_item_code: string
        quantity: string
        unit: string
        rate: string
        amount: string
        division_code: string | null
        created_at: string
      }>(
        `update estimate_lines
            set quantity = $3::numeric, rate = $4::numeric, amount = $5::numeric
          where company_id = $1 and id = $2
        returning id, service_item_code, quantity, unit, rate, amount, division_code, created_at`,
        [ctx.company.id, lineId, String(nextQuantity), String(nextRate), String(nextAmount)],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'estimate_line',
        entityId: lineId,
        action: 'update',
        row,
        actorUserId: ctx.currentUserId ?? null,
      })
      return row
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'estimate line not found' })
      return true
    }

    // Return the refreshed scope-vs-bid snapshot for the line's draft so
    // the caller can repaint totals without a second round-trip — same
    // contract the recompute route uses.
    const scopeVsBid = await getScopeVsBid(ctx.pool, ctx.company.id, line.project_id, { draftId: line.draft_id })
    ctx.sendJson(200, { line: updated, scope_vs_bid: scopeVsBid })
    return true
  }

  // POST /api/projects/:id/estimate/margin — interactive margin re-pricing
  // (D10 · MARGIN slider). The body carries a single SET_MARGIN intent
  // ({ event: 'SET_MARGIN', target_margin_pct }); the route reprices the
  // project's contract bid off the internal cost basis via the pure
  // repriceForTargetMargin reducer (bid = cost / (1 - margin)) and persists
  // both target_margin_pct (so the slider survives reload) and the recomputed
  // bid_total. The per-line solver is untouched — only the revenue side moves.
  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\/margin$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody().catch(() => ({}) as Record<string, unknown>)
    if (body.event !== undefined && body.event !== 'SET_MARGIN') {
      ctx.sendJson(400, { error: `unsupported event ${String(body.event)} — only SET_MARGIN is accepted` })
      return true
    }
    const raw = body.target_margin_pct
    const targetMargin = typeof raw === 'string' ? Number(raw) : raw
    if (typeof targetMargin !== 'number' || !Number.isFinite(targetMargin) || targetMargin < 0 || targetMargin >= 1) {
      ctx.sendJson(400, { error: 'target_margin_pct must be a number in [0, 1)' })
      return true
    }

    // The cost basis is the project's internal cost (labor + materials + subs),
    // the same figure summarizeProject/calculateMargin already use as `cost`.
    const summary = await summarizeProject(ctx.pool, ctx.company.id, projectId)
    if (!summary) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const cost = Number(summary.metrics.totalCost ?? 0)
    const { bidTotal, marginPct } = repriceForTargetMargin({ cost, targetMarginPct: targetMargin })

    const updated = await withMutationTx(ctx.company.id, async (client) => {
      const result = await client.query<{ id: string; bid_total: string | number | null; version: number }>(
        `update projects
            set target_margin_pct = $1,
                bid_total = $2,
                updated_at = now(),
                version = version + 1
          where company_id = $3 and id = $4
          returning id, bid_total, version`,
        [marginPct, bidTotal, ctx.company.id, projectId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'project',
        entityId: projectId,
        action: 'set_margin',
        row: { id: projectId, target_margin_pct: marginPct, bid_total: bidTotal, cost },
        idempotencyKey: `project:set_margin:${projectId}:${row.version}`,
        actorUserId: ctx.currentUserId ?? null,
      })
      return row
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }

    const scopeVsBid = await getScopeVsBid(ctx.pool, ctx.company.id, projectId)
    ctx.sendJson(200, {
      project_id: projectId,
      target_margin_pct: marginPct,
      bid_total: bidTotal,
      cost,
      scope_vs_bid: scopeVsBid,
    })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\/recompute$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    // Phase A.4: accept draft_id either as ?draft_id= or in the JSON
    // body. URL is the more idiomatic form for "recompute draft X" but
    // the body version stays compatible with offline replay queues that
    // can't easily restructure the URL.
    const body = req.method === 'POST' ? await ctx.readBody().catch(() => ({})) : {}
    const draftId = await resolveDraftIdParam(ctx, url, body, projectId)
    if (draftId === undefined) return true // 400 already sent by helper
    const estimate = await withMutationTx(async (client) => {
      const computed = await createEstimateFromMeasurements(ctx.pool, ctx.company.id, projectId, {
        draftId,
        executor: client,
      })
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
    const scopeVsBid = await getScopeVsBid(ctx.pool, ctx.company.id, projectId, { draftId })
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
    const draftId = await resolveDraftIdParam(ctx, url, {}, projectId)
    if (draftId === undefined) return true
    const result = await getScopeVsBid(ctx.pool, ctx.company.id, projectId, { draftId })
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
    const draftId = await resolveDraftIdParam(ctx, url, {}, projectId)
    if (draftId === undefined) return true
    // PlanSwift-parity report kinds (Phase 3): ?report=customer|rfq|cost_vs_sell.
    // Unknown / absent → the original 'summary' estimate.
    const reportParam = url.searchParams.get('report')
    const report = isReportKind(reportParam) ? reportParam : 'summary'
    const summary = await summarizeProject(ctx.pool, ctx.company.id, projectId, { draftId })
    if (!summary) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const pdfInput = buildEstimatePdfInputFromSummary({
      company: { name: ctx.company.name, slug: ctx.company.slug },
      report,
      summary,
      appUrl: process.env.APP_PUBLIC_URL ?? 'https://sitelayer.sandolab.xyz',
    })
    const namePart = summary.project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
    const prefix = report === 'summary' ? 'estimate' : `${report.replace(/_/g, '-')}-report`
    const filename = `${prefix}-${namePart}.pdf`
    await ctx.sendPdf(`attachment; filename="${filename}"`, pdfInput)
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\.csv$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }
    const draftId = await resolveDraftIdParam(ctx, url, {}, projectId)
    if (draftId === undefined) return true
    const summary = await summarizeProject(ctx.pool, ctx.company.id, projectId, { draftId })
    if (!summary) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const csv = buildEstimateCsv(summary.project.name, summary.estimateLines)
    const filename = `estimate-${summary.project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)}.csv`
    ctx.sendFileContent('text/csv; charset=utf-8', filename, csv)
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\.xlsx$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }
    const draftId = await resolveDraftIdParam(ctx, url, {}, projectId)
    if (draftId === undefined) return true
    const summary = await summarizeProject(ctx.pool, ctx.company.id, projectId, { draftId })
    if (!summary) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const xlsx = await buildEstimateXlsx(summary.project.name, summary.estimateLines)
    const filename = `estimate-${summary.project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)}.xlsx`
    ctx.sendFileContent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename, xlsx)
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
      const serviceItemExists = await withCompanyClient(ctx.company.id, (c) =>
        c.query<{ exists: boolean }>(
          `select exists(
           select 1 from service_items
            where company_id = $1 and code = $2 and deleted_at is null
         ) as exists`,
          [ctx.company.id, code],
        ),
      )
      if (!serviceItemExists.rows[0]?.exists) {
        ctx.sendJson(404, { error: 'service item not found' })
        return true
      }
      if (divisionCodes.length > 0) {
        const validDivisions = await withCompanyClient(ctx.company.id, (c) =>
          c.query<{ code: string }>(`select code from divisions where company_id = $1 and code = any($2::text[])`, [
            ctx.company.id,
            divisionCodes,
          ]),
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
