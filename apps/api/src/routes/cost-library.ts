import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError } from '../http-utils.js'
import { CostLibraryImportError, parsePriceBook, type ParsedCostLibraryRow } from '../cost-library-import.js'

export type CostLibraryRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const LIBRARY_COLUMNS = `id, company_id, trade, code, name, unit,
  material_rate, labor_rate, region, source, created_at, updated_at`

interface CostLibraryRow {
  id: string
  company_id: string | null
  trade: string
  code: string
  name: string | null
  unit: string
  material_rate: string | null
  labor_rate: string | null
  region: string | null
  source: string
  created_at: string
  updated_at: string
}

/** Upper bound on the list response so a huge shared catalog can't blow the payload. */
const LIST_LIMIT = 500

function optionalString(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  return s.slice(0, maxLen)
}

function optionalRate(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/**
 * Shared cost library (Takeoff Deep Dive M5) — company-scoped + shared-catalog
 * read/search, single-row create, and a price-book import (CSV / .xlsx) that
 * upserts rows.
 *
 * Endpoints (all company-scoped via withCompanyClient / withMutationTx; the
 * RLS policy on cost_library_items additionally exposes shared
 * `company_id IS NULL` rows):
 *   GET  /api/cost-library              — list/search (?q=, ?trade=, ?region=)
 *   POST /api/cost-library              — create one library row
 *   POST /api/cost-library/import       — parse + upsert a CSV/.xlsx price book
 *
 * Additive: this is a NEW resource. It does NOT replace `service_items`; the
 * pricing resolver consults it only as the lowest-priority fallback (see
 * pricing.ts, layer 6), so an empty library changes nothing.
 */
export async function handleCostLibraryRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: CostLibraryRouteCtx,
): Promise<boolean> {
  const collectionMatch = url.pathname === '/api/cost-library'
  const importMatch = url.pathname === '/api/cost-library/import'

  // --- list / search ---------------------------------------------------------
  if (req.method === 'GET' && collectionMatch) {
    const q = optionalString(url.searchParams.get('q'), 128)
    const trade = optionalString(url.searchParams.get('trade'), 128)
    const region = optionalString(url.searchParams.get('region'), 128)

    const where: string[] = [
      // The company's own rows plus the shared (NULL company) catalog. RLS
      // already enforces this, but stating it keeps the index usable.
      `(company_id = $1 or company_id is null)`,
      `deleted_at is null`,
    ]
    const params: unknown[] = [ctx.company.id]
    if (q) {
      params.push(`%${q.toLowerCase()}%`)
      where.push(`(lower(code) like $${params.length} or lower(coalesce(name, '')) like $${params.length})`)
    }
    if (trade) {
      params.push(trade.toLowerCase())
      where.push(`lower(trade) = $${params.length}`)
    }
    if (region) {
      params.push(region.toLowerCase())
      where.push(`lower(coalesce(region, '')) = $${params.length}`)
    }

    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<CostLibraryRow>(
        `select ${LIBRARY_COLUMNS}
         from cost_library_items
         where ${where.join(' and ')}
         order by lower(trade) asc, lower(code) asc, region nulls first
         limit ${LIST_LIMIT}`,
        params,
      ),
    )
    ctx.sendJson(200, { items: result.rows })
    return true
  }

  // --- create one row --------------------------------------------------------
  if (req.method === 'POST' && collectionMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()

    const code = optionalString(body.code, 128)
    if (!code) {
      ctx.sendJson(400, { error: 'code is required' })
      return true
    }
    const trade = optionalString(body.trade, 128) ?? 'general'
    const name = optionalString(body.name, 512)
    const unit = optionalString(body.unit, 32) ?? 'ea'
    const region = optionalString(body.region, 128)
    const source = optionalString(body.source, 64) ?? 'manual'
    const materialRate = optionalRate(body.material_rate)
    const laborRate = optionalRate(body.labor_rate)

    const created = await upsertRows(ctx, [
      { trade, code, name, unit, material_rate: materialRate, labor_rate: laborRate, region, source },
    ])
    const row = created[0]
    if (!row) throw new HttpError(500, 'cost library insert returned no row')
    ctx.sendJson(201, { item: row })
    return true
  }

  // --- import a price book ----------------------------------------------------
  if (req.method === 'POST' && importMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()

    const rawFormat = typeof body.format === 'string' ? body.format.trim().toLowerCase() : ''
    const format = rawFormat === 'xlsx' || rawFormat === 'csv' ? (rawFormat as 'csv' | 'xlsx') : null
    if (!format) {
      ctx.sendJson(400, { error: 'format must be "csv" or "xlsx"' })
      return true
    }
    // CSV arrives as raw text in `content`; .xlsx arrives base64-encoded in
    // `content` (the JSON body can't carry binary). The client also may send
    // pre-parsed `rows` directly (the takeoff-import convention) — honored below.
    const content = typeof body.content === 'string' ? body.content : null
    const preParsedRows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : null
    if (!content && !preParsedRows) {
      ctx.sendJson(400, { error: 'content (CSV text or base64 .xlsx) or rows[] is required' })
      return true
    }
    const defaultSource = optionalString(body.source, 64) ?? 'import'
    const region = optionalString(body.region, 128)

    let parsed: ParsedCostLibraryRow[]
    try {
      if (preParsedRows) {
        parsed = preParsedRows
          .map((r) => normalizePreParsedRow(r, defaultSource))
          .filter((r): r is ParsedCostLibraryRow => r !== null)
      } else {
        parsed = await parsePriceBook(format, content!, { defaultSource })
      }
    } catch (err) {
      if (err instanceof CostLibraryImportError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }

    if (parsed.length === 0) {
      ctx.sendJson(400, { error: 'no valid rows found in the price book' })
      return true
    }
    // A per-request region override stamps every imported row (the import UI
    // lets the user tag the book's region in one place).
    const rowsToUpsert = region ? parsed.map((r) => ({ ...r, region })) : parsed

    const upserted = await upsertRows(ctx, rowsToUpsert)
    ctx.sendJson(201, { imported: upserted.length, source: defaultSource, items: upserted })
    return true
  }

  return false
}

/** Coerce a caller-supplied pre-parsed row into the canonical shape; null when no code. */
function normalizePreParsedRow(r: Record<string, unknown>, defaultSource: string): ParsedCostLibraryRow | null {
  const code = optionalString(r.code, 128)
  if (!code) return null
  return {
    trade: optionalString(r.trade, 128) ?? 'general',
    code,
    name: optionalString(r.name, 512),
    unit: optionalString(r.unit, 32) ?? 'ea',
    material_rate: optionalRate(r.material_rate),
    labor_rate: optionalRate(r.labor_rate),
    region: optionalString(r.region, 128),
    source: optionalString(r.source, 64) ?? defaultSource,
  }
}

/**
 * Upsert library rows scoped to the caller's company. The conflict target is
 * the (company, region, lower(code), lower(unit)) dedupe index from migration
 * 140, so re-importing the same price book updates rates in place instead of
 * duplicating rows. Runs in one mutation tx with a single ledger row.
 */
async function upsertRows(ctx: CostLibraryRouteCtx, rows: readonly ParsedCostLibraryRow[]): Promise<CostLibraryRow[]> {
  return withMutationTx(async (client: PoolClient) => {
    const saved: CostLibraryRow[] = []
    for (const row of rows) {
      const result = await client.query<CostLibraryRow>(
        `insert into cost_library_items
           (company_id, trade, code, name, unit, material_rate, labor_rate, region, source, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (
           coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
           coalesce(region, ''),
           lower(code),
           lower(unit)
         ) where deleted_at is null
         do update set
           trade = excluded.trade,
           name = excluded.name,
           material_rate = excluded.material_rate,
           labor_rate = excluded.labor_rate,
           source = excluded.source,
           updated_at = now()
         returning ${LIBRARY_COLUMNS}`,
        [
          ctx.company.id,
          row.trade,
          row.code,
          row.name,
          row.unit,
          row.material_rate,
          row.labor_rate,
          row.region,
          row.source,
          ctx.currentUserId,
        ],
      )
      const inserted = result.rows[0]
      if (!inserted) throw new HttpError(500, 'cost library upsert returned no row')
      saved.push(inserted)
    }
    await recordMutationLedger(client, {
      companyId: ctx.company.id,
      entityType: 'cost_library_item',
      entityId: ctx.company.id,
      action: saved.length === 1 ? 'create' : 'import',
      actorUserId: ctx.currentUserId,
      row: { count: saved.length },
    })
    return saved
  })
}
