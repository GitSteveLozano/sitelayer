import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME,
  SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION,
  transitionScaffoldOpsApprovalWorkflow,
  type ScaffoldOpsApprovalWorkflowEvent,
  type ScaffoldOpsApprovalWorkflowSnapshot,
  type ScaffoldOpsApprovalWorkflowState,
} from '@sitelayer/workflows'
import { z } from 'zod'
import { HttpError, parseJsonBody } from '../http-utils.js'

// Wire-format schemas for the scaffold-ops surface. Each schema reflects
// the field shapes the existing `nonEmptyString` / `parseNumber` helpers
// expect — strings (often nullable), string-or-number for numerics, plus
// `.loose()` so we don't accidentally narrow what the SPA already sends.
const StringOrNullSchema = z.union([z.string(), z.null()])
const NumericInputSchema = z.union([z.number(), z.string()])

const BranchCreateBodySchema = z
  .object({
    code: z.string().optional(),
    name: z.string().optional(),
    address: z.string().nullish(),
    is_default: z.boolean().nullish(),
  })
  .loose()

const BranchPatchBodySchema = z
  .object({
    name: z.string().nullish(),
    address: z.string().nullish(),
    is_default: z.boolean().nullish(),
  })
  .loose()

const RentalVendorCreateBodySchema = z
  .object({
    code: z.string().optional(),
    name: z.string().optional(),
    contact_email: z.string().nullish(),
    contact_phone: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .loose()

const ExternalRentalCreateBodySchema = z
  .object({
    vendor_id: z.string().optional(),
    inventory_item_id: z.string().optional(),
    quantity: NumericInputSchema.nullish(),
    on_rent_date: z.string().optional(),
    project_id: StringOrNullSchema.optional(),
    branch_id: StringOrNullSchema.optional(),
    vendor_rate: NumericInputSchema.nullish(),
    rate_unit: z.string().nullish(),
    vendor_po: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .loose()

const ExternalRentalReturnBodySchema = z
  .object({
    returned_quantity: NumericInputSchema.optional(),
    off_rent_date: z.string().nullish(),
  })
  .loose()

const ScaffoldManufacturerCreateBodySchema = z
  .object({
    code: z.string().optional(),
    name: z.string().optional(),
    website: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .loose()

const ScaffoldSystemCreateBodySchema = z
  .object({
    code: z.string().optional(),
    name: z.string().optional(),
    manufacturer_id: StringOrNullSchema.optional(),
    description: z.string().nullish(),
  })
  .loose()

const CatalogPartCreateBodySchema = z
  .object({
    sku: z.string().optional(),
    description: z.string().optional(),
    manufacturer_id: StringOrNullSchema.optional(),
    scaffold_system_id: StringOrNullSchema.optional(),
    inventory_item_id: StringOrNullSchema.optional(),
    unit: z.string().nullish(),
    weight_kg: NumericInputSchema.nullish(),
    length_mm: NumericInputSchema.nullish(),
    width_mm: NumericInputSchema.nullish(),
    height_mm: NumericInputSchema.nullish(),
    surface_area_m2: NumericInputSchema.nullish(),
    attrs: z.unknown().nullish(),
    active: z.boolean().nullish(),
  })
  .loose()

const CatalogPartImportBodySchema = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .loose()

const BomCreateBodySchema = z
  .object({
    name: z.string().optional(),
    source: z.string().nullish(),
    source_ref: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .loose()

const BomLinesBodySchema = z
  .object({
    lines: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .loose()
import { observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { recordMutationLedger, recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'

/**
 * Branches, rental vendors, external (cross-hire) rentals, scaffold
 * manufacturer catalog, and BOM bridge. Schema lives in migrations
 * 057–058. Workflows for shipments/damage live in separate modules.
 *
 * All endpoints are JSON-only and follow the rental-inventory-crud.ts
 * style: ctx.requireRole gates writes, withMutationTx wraps inserts +
 * outbox ledger, version is a plain int we bump on every PATCH.
 */
export type ScaffoldOpsRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const BRANCH_COLUMNS = `
  id, company_id, code, name, address, is_default,
  version, deleted_at, created_at, updated_at
`
const RENTAL_VENDOR_COLUMNS = `
  id, company_id, code, name, contact_email, contact_phone,
  notes, active, version, deleted_at, created_at, updated_at
`
const EXTERNAL_RENTAL_COLUMNS = `
  id, company_id, vendor_id, inventory_item_id, project_id, branch_id,
  quantity, returned_quantity, vendor_rate, rate_unit,
  to_char(on_rent_date, 'YYYY-MM-DD') as on_rent_date,
  to_char(off_rent_date, 'YYYY-MM-DD') as off_rent_date,
  vendor_po, status, notes, version, deleted_at, created_at, updated_at
`
const MANUFACTURER_COLUMNS = `id, company_id, code, name, website, notes, active, created_at, updated_at`
const SYSTEM_COLUMNS = `id, company_id, manufacturer_id, code, name, description, active, created_at, updated_at`
const CATALOG_PART_COLUMNS = `
  id, company_id, manufacturer_id, scaffold_system_id, inventory_item_id,
  sku, description, unit, weight_kg, length_mm, width_mm, height_mm,
  surface_area_m2, attrs, active, version, deleted_at, created_at, updated_at
`
const BOM_COLUMNS = `
  id, company_id, project_id, source, source_ref, name, notes, status,
  state_version, approved_at, approved_by, superseded_by,
  total_weight_kg, total_lines,
  version, deleted_at, created_at, updated_at
`
const BOM_LINE_COLUMNS = `id, company_id, bom_id, catalog_part_id, quantity, notes, attrs, created_at, updated_at`

function nonEmptyString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text ? text : null
}

function parseNumber(value: unknown, fallback: number | null = null): number | null {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export async function handleScaffoldOpsRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ScaffoldOpsRouteCtx,
): Promise<boolean> {
  // ---- branches ----------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/branches') {
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${BRANCH_COLUMNS} from branches where company_id = $1 and deleted_at is null order by is_default desc, name asc`,
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { branches: result.rows })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/branches') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(BranchCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const code = nonEmptyString(body.code)
    const name = nonEmptyString(body.name)
    if (!code || !name) {
      ctx.sendJson(400, { error: 'code and name are required' })
      return true
    }
    const row = await withMutationTx(async (client: PoolClient) => {
      if (body.is_default) {
        await client.query('update branches set is_default = false where company_id = $1', [ctx.company.id])
      }
      const result = await client.query(
        `insert into branches (company_id, code, name, address, is_default)
         values ($1, $2, $3, $4, coalesce($5, false))
         returning ${BRANCH_COLUMNS}`,
        [ctx.company.id, code, name, nonEmptyString(body.address), body.is_default ?? false],
      )
      const created = result.rows[0]
      if (!created) throw new HttpError(500, 'branch insert returned no row')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'branch',
        entityId: created.id,
        action: 'create',
        row: created,
      })
      return created
    })
    ctx.sendJson(201, row)
    return true
  }
  const branchPatchMatch = url.pathname.match(/^\/api\/branches\/([^/]+)$/)
  if (req.method === 'PATCH' && branchPatchMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = branchPatchMatch[1]!
    const parsedPatch = parseJsonBody(BranchPatchBodySchema, await ctx.readBody())
    if (!parsedPatch.ok) {
      ctx.sendJson(400, { error: parsedPatch.error })
      return true
    }
    const body = parsedPatch.value
    const updates: string[] = []
    const params: unknown[] = [ctx.company.id, id]
    if (body.name !== undefined) {
      params.push(nonEmptyString(body.name))
      updates.push(`name = $${params.length}`)
    }
    if (body.address !== undefined) {
      params.push(nonEmptyString(body.address))
      updates.push(`address = $${params.length}`)
    }
    if (body.is_default !== undefined && body.is_default) {
      await withMutationTx(ctx.company.id, (c) =>
        c.query('update branches set is_default = false where company_id = $1', [ctx.company.id]),
      )
      updates.push('is_default = true')
    }
    if (updates.length === 0) {
      ctx.sendJson(400, { error: 'no updatable fields supplied' })
      return true
    }
    updates.push('version = version + 1', 'updated_at = now()')
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `update branches set ${updates.join(', ')} where company_id = $1 and id = $2 and deleted_at is null returning ${BRANCH_COLUMNS}`,
        params,
      ),
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'branch not found' })
      return true
    }
    ctx.sendJson(200, result.rows[0])
    return true
  }

  // ---- rental vendors ----------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/rental-vendors') {
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${RENTAL_VENDOR_COLUMNS} from rental_vendors where company_id = $1 and deleted_at is null order by active desc, name asc`,
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { vendors: result.rows })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/rental-vendors') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(RentalVendorCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const code = nonEmptyString(body.code)
    const name = nonEmptyString(body.name)
    if (!code || !name) {
      ctx.sendJson(400, { error: 'code and name are required' })
      return true
    }
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `insert into rental_vendors (company_id, code, name, contact_email, contact_phone, notes)
       values ($1, $2, $3, $4, $5, $6) returning ${RENTAL_VENDOR_COLUMNS}`,
        [
          ctx.company.id,
          code,
          name,
          nonEmptyString(body.contact_email),
          nonEmptyString(body.contact_phone),
          nonEmptyString(body.notes),
        ],
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  // ---- external (cross-hire) rentals -------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/external-rentals') {
    const projectId = url.searchParams.get('project_id')
    const params: unknown[] = [ctx.company.id]
    let where = 'company_id = $1 and deleted_at is null'
    if (projectId) {
      params.push(projectId)
      where += ` and project_id = $${params.length}`
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${EXTERNAL_RENTAL_COLUMNS} from external_rentals where ${where} order by created_at desc`,
        params,
      ),
    )
    ctx.sendJson(200, { externalRentals: result.rows })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/external-rentals') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(ExternalRentalCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const vendorId = nonEmptyString(body.vendor_id)
    const inventoryItemId = nonEmptyString(body.inventory_item_id)
    const quantity = parseNumber(body.quantity)
    const onRentDate = nonEmptyString(body.on_rent_date)
    if (!vendorId || !inventoryItemId || quantity == null || quantity <= 0 || !onRentDate) {
      ctx.sendJson(400, { error: 'vendor_id, inventory_item_id, quantity, on_rent_date are required' })
      return true
    }
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `insert into external_rentals (
        company_id, vendor_id, inventory_item_id, project_id, branch_id,
        quantity, vendor_rate, rate_unit, on_rent_date, vendor_po, notes
      ) values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'cycle'), $9, $10, $11)
      returning ${EXTERNAL_RENTAL_COLUMNS}`,
        [
          ctx.company.id,
          vendorId,
          inventoryItemId,
          nonEmptyString(body.project_id),
          nonEmptyString(body.branch_id),
          quantity,
          parseNumber(body.vendor_rate, 0) ?? 0,
          nonEmptyString(body.rate_unit),
          onRentDate,
          nonEmptyString(body.vendor_po),
          nonEmptyString(body.notes),
        ],
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }
  const externalReturnMatch = url.pathname.match(/^\/api\/external-rentals\/([^/]+)\/return$/)
  if (req.method === 'POST' && externalReturnMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = externalReturnMatch[1]!
    const parsed = parseJsonBody(ExternalRentalReturnBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const returnedQuantity = parseNumber(body.returned_quantity)
    if (returnedQuantity == null || returnedQuantity < 0) {
      ctx.sendJson(400, { error: 'returned_quantity must be a non-negative number' })
      return true
    }
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `update external_rentals
       set returned_quantity = returned_quantity + $3,
           off_rent_date = case when returned_quantity + $3 >= quantity then coalesce($4, current_date) else off_rent_date end,
           status = case when returned_quantity + $3 >= quantity then 'returned' else status end,
           version = version + 1, updated_at = now()
       where company_id = $1 and id = $2 and deleted_at is null
       returning ${EXTERNAL_RENTAL_COLUMNS}`,
        [ctx.company.id, id, returnedQuantity, nonEmptyString(body.off_rent_date)],
      ),
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'external rental not found' })
      return true
    }
    ctx.sendJson(200, result.rows[0])
    return true
  }

  // ---- manufacturer catalog ---------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/scaffold/manufacturers') {
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${MANUFACTURER_COLUMNS} from scaffold_manufacturers
       where company_id is null or company_id = $1
       order by name asc`,
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { manufacturers: result.rows })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/scaffold/manufacturers') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(ScaffoldManufacturerCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const code = nonEmptyString(body.code)
    const name = nonEmptyString(body.name)
    if (!code || !name) {
      ctx.sendJson(400, { error: 'code and name are required' })
      return true
    }
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `insert into scaffold_manufacturers (company_id, code, name, website, notes)
       values ($1, $2, $3, $4, $5) returning ${MANUFACTURER_COLUMNS}`,
        [ctx.company.id, code, name, nonEmptyString(body.website), nonEmptyString(body.notes)],
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/scaffold/systems') {
    const manufacturerId = url.searchParams.get('manufacturer_id')
    const params: unknown[] = [ctx.company.id]
    let where = '(company_id is null or company_id = $1)'
    if (manufacturerId) {
      params.push(manufacturerId)
      where += ` and manufacturer_id = $${params.length}`
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(`select ${SYSTEM_COLUMNS} from scaffold_systems where ${where} order by name asc`, params),
    )
    ctx.sendJson(200, { systems: result.rows })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/scaffold/systems') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(ScaffoldSystemCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const code = nonEmptyString(body.code)
    const name = nonEmptyString(body.name)
    if (!code || !name) {
      ctx.sendJson(400, { error: 'code and name are required' })
      return true
    }
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `insert into scaffold_systems (company_id, manufacturer_id, code, name, description)
       values ($1, $2, $3, $4, $5) returning ${SYSTEM_COLUMNS}`,
        [ctx.company.id, nonEmptyString(body.manufacturer_id), code, name, nonEmptyString(body.description)],
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  // ---- catalog parts -----------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/scaffold/catalog-parts') {
    const systemId = url.searchParams.get('system_id')
    const manufacturerId = url.searchParams.get('manufacturer_id')
    const params: unknown[] = [ctx.company.id]
    let where = 'company_id = $1 and deleted_at is null'
    if (systemId) {
      params.push(systemId)
      where += ` and scaffold_system_id = $${params.length}`
    }
    if (manufacturerId) {
      params.push(manufacturerId)
      where += ` and manufacturer_id = $${params.length}`
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(`select ${CATALOG_PART_COLUMNS} from catalog_parts where ${where} order by sku asc limit 500`, params),
    )
    ctx.sendJson(200, { catalogParts: result.rows })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/scaffold/catalog-parts') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(CatalogPartCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const sku = nonEmptyString(body.sku)
    const description = nonEmptyString(body.description)
    if (!sku || !description) {
      ctx.sendJson(400, { error: 'sku and description are required' })
      return true
    }
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `insert into catalog_parts (
        company_id, manufacturer_id, scaffold_system_id, inventory_item_id,
        sku, description, unit, weight_kg, length_mm, width_mm, height_mm,
        surface_area_m2, attrs, active
      ) values ($1, $2, $3, $4, $5, $6, coalesce($7, 'ea'), $8, $9, $10, $11, $12, coalesce($13, '{}'::jsonb), coalesce($14, true))
      returning ${CATALOG_PART_COLUMNS}`,
        [
          ctx.company.id,
          nonEmptyString(body.manufacturer_id),
          nonEmptyString(body.scaffold_system_id),
          nonEmptyString(body.inventory_item_id),
          sku,
          description,
          nonEmptyString(body.unit),
          parseNumber(body.weight_kg),
          parseNumber(body.length_mm),
          parseNumber(body.width_mm),
          parseNumber(body.height_mm),
          parseNumber(body.surface_area_m2),
          body.attrs ?? null,
          body.active ?? true,
        ],
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/scaffold/catalog-parts/import') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(CatalogPartImportBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const rows = parsed.value.rows ?? null
    if (!rows || rows.length === 0) {
      ctx.sendJson(400, { error: 'rows[] required (one object per part)' })
      return true
    }
    let inserted = 0
    let updated = 0
    await withMutationTx(async (client: PoolClient) => {
      for (const r of rows) {
        const sku = nonEmptyString(r.sku)
        const description = nonEmptyString(r.description)
        if (!sku || !description) continue
        const existing = await client.query<{ id: string }>(
          'select id from catalog_parts where company_id = $1 and sku = $2 limit 1',
          [ctx.company.id, sku],
        )
        if (existing.rows[0]) {
          await client.query(
            `update catalog_parts
               set description = $3,
                   unit = coalesce($4, unit),
                   weight_kg = coalesce($5, weight_kg),
                   manufacturer_id = coalesce($6, manufacturer_id),
                   scaffold_system_id = coalesce($7, scaffold_system_id),
                   version = version + 1, updated_at = now()
             where company_id = $1 and id = $2`,
            [
              ctx.company.id,
              existing.rows[0].id,
              description,
              nonEmptyString(r.unit),
              parseNumber(r.weight_kg),
              nonEmptyString(r.manufacturer_id),
              nonEmptyString(r.scaffold_system_id),
            ],
          )
          updated += 1
        } else {
          await client.query(
            `insert into catalog_parts (company_id, manufacturer_id, scaffold_system_id, sku, description, unit, weight_kg)
             values ($1, $2, $3, $4, $5, coalesce($6, 'ea'), $7)`,
            [
              ctx.company.id,
              nonEmptyString(r.manufacturer_id),
              nonEmptyString(r.scaffold_system_id),
              sku,
              description,
              nonEmptyString(r.unit),
              parseNumber(r.weight_kg),
            ],
          )
          inserted += 1
        }
      }
    })
    ctx.sendJson(200, { inserted, updated })
    return true
  }

  // ---- boms --------------------------------------------------------------
  const projectBomsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/boms$/)
  if (req.method === 'GET' && projectBomsMatch) {
    const projectId = projectBomsMatch[1]!
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${BOM_COLUMNS} from boms where company_id = $1 and project_id = $2 and deleted_at is null order by created_at desc`,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, { boms: result.rows })
    return true
  }
  if (req.method === 'POST' && projectBomsMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = projectBomsMatch[1]!
    const parsed = parseJsonBody(BomCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const name = nonEmptyString(body.name)
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `insert into boms (company_id, project_id, source, source_ref, name, notes)
       values ($1, $2, coalesce($3, 'manual'), $4, $5, $6) returning ${BOM_COLUMNS}`,
        [
          ctx.company.id,
          projectId,
          nonEmptyString(body.source),
          nonEmptyString(body.source_ref),
          name,
          nonEmptyString(body.notes),
        ],
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  const bomIdMatch = url.pathname.match(/^\/api\/boms\/([^/]+)$/)
  if (req.method === 'GET' && bomIdMatch) {
    const id = bomIdMatch[1]!
    const bom = await withCompanyClient(ctx.company.id, (c) =>
      c.query(`select ${BOM_COLUMNS} from boms where company_id = $1 and id = $2 and deleted_at is null`, [
        ctx.company.id,
        id,
      ]),
    )
    if (!bom.rows[0]) {
      ctx.sendJson(404, { error: 'bom not found' })
      return true
    }
    const lines = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${BOM_LINE_COLUMNS} from bom_lines where company_id = $1 and bom_id = $2 order by created_at asc`,
        [ctx.company.id, id],
      ),
    )
    ctx.sendJson(200, { ...bom.rows[0], lines: lines.rows })
    return true
  }

  const bomLinesMatch = url.pathname.match(/^\/api\/boms\/([^/]+)\/lines$/)
  if (req.method === 'POST' && bomLinesMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = bomLinesMatch[1]!
    const parsed = parseJsonBody(BomLinesBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const lines = parsed.value.lines ?? null
    if (!lines || lines.length === 0) {
      ctx.sendJson(400, { error: 'lines[] required' })
      return true
    }
    const inserted = await withMutationTx(async (client: PoolClient) => {
      const rows: unknown[] = []
      for (const line of lines) {
        const catalogPartId = nonEmptyString(line.catalog_part_id)
        const quantity = parseNumber(line.quantity)
        if (!catalogPartId || quantity == null || quantity <= 0) continue
        const result = await client.query(
          `insert into bom_lines (company_id, bom_id, catalog_part_id, quantity, notes, attrs)
           values ($1, $2, $3, $4, $5, coalesce($6, '{}'::jsonb)) returning ${BOM_LINE_COLUMNS}`,
          [ctx.company.id, id, catalogPartId, quantity, nonEmptyString(line.notes), line.attrs ?? null],
        )
        rows.push(result.rows[0])
      }
      const total = await client.query<{ total_weight_kg: string; total_lines: string }>(
        `select coalesce(sum(bl.quantity * cp.weight_kg), 0) as total_weight_kg, count(*)::text as total_lines
         from bom_lines bl join catalog_parts cp on cp.company_id = bl.company_id and cp.id = bl.catalog_part_id
         where bl.company_id = $1 and bl.bom_id = $2`,
        [ctx.company.id, id],
      )
      await client.query(
        `update boms set total_weight_kg = $3, total_lines = $4, updated_at = now()
         where company_id = $1 and id = $2`,
        [ctx.company.id, id, total.rows[0]?.total_weight_kg ?? 0, total.rows[0]?.total_lines ?? 0],
      )
      return rows
    })
    ctx.sendJson(201, { lines: inserted })
    return true
  }

  // POST /api/boms/:id/approve — dispatch APPROVE through the
  // scaffold_ops_approval reducer in the same tx as the row UPDATE and
  // append a workflow_event_log row. Replaces the direct
  // status='approved' write that the original #325 left untouched
  // (caught in the 2026-05-16 verification audit).
  const bomApproveMatch = url.pathname.match(/^\/api\/boms\/([^/]+)\/approve$/)
  if (req.method === 'POST' && bomApproveMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = bomApproveMatch[1]!
    const outcome = await withMutationTx(async (client: PoolClient) => {
      const locked = await client.query<{
        id: string
        status: ScaffoldOpsApprovalWorkflowState
        state_version: number
        approved_at: string | null
        approved_by: string | null
        version: number
      }>(
        `select id, status, state_version, approved_at, approved_by, version
           from boms
           where company_id = $1 and id = $2 and deleted_at is null
           for update`,
        [ctx.company.id, id],
      )
      const current = locked.rows[0]
      if (!current) return { kind: 'not_found' as const }
      const currentSnapshot: ScaffoldOpsApprovalWorkflowSnapshot = {
        state: (current.status as ScaffoldOpsApprovalWorkflowState) ?? 'draft',
        state_version: current.state_version ?? 1,
        approved_at: current.approved_at ?? null,
        approved_by: current.approved_by ?? null,
      }
      const nowIso = new Date().toISOString()
      const event: ScaffoldOpsApprovalWorkflowEvent = {
        type: 'APPROVE',
        approved_at: nowIso,
        approved_by: ctx.currentUserId,
      }
      let nextSnapshot: ScaffoldOpsApprovalWorkflowSnapshot
      try {
        nextSnapshot = transitionScaffoldOpsApprovalWorkflow(currentSnapshot, event)
      } catch (err) {
        return {
          kind: 'illegal_transition' as const,
          message: err instanceof Error ? err.message : String(err),
        }
      }
      const updated = await client.query(
        `update boms
           set status = $3,
               state_version = $4,
               approved_at = $5,
               approved_by = $6,
               version = version + 1,
               updated_at = now()
         where company_id = $1 and id = $2 and deleted_at is null
         returning ${BOM_COLUMNS}`,
        [
          ctx.company.id,
          id,
          nextSnapshot.state,
          nextSnapshot.state_version,
          nextSnapshot.approved_at ?? nowIso,
          nextSnapshot.approved_by ?? ctx.currentUserId,
        ],
      )
      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME,
        schemaVersion: SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION,
        entityType: 'bom',
        entityId: id,
        stateVersion: currentSnapshot.state_version,
        eventType: 'APPROVE',
        eventPayload: event,
        snapshotAfter: nextSnapshot,
        actorUserId: ctx.currentUserId,
      })
      const outcome2 = workflowEventOutcome('APPROVE')
      if (outcome2) observeWorkflowEvent(SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME, outcome2)
      return { kind: 'ok' as const, row: updated.rows[0] }
    })
    if (outcome.kind === 'not_found') {
      ctx.sendJson(404, { error: 'bom not found' })
      return true
    }
    if (outcome.kind === 'illegal_transition') {
      ctx.sendJson(409, { error: outcome.message })
      return true
    }
    ctx.sendJson(200, outcome.row)
    return true
  }

  return false
}
