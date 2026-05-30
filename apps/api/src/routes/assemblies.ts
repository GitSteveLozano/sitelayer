import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { validateFormula } from '@sitelayer/formula-evaluator'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidUuid } from '../http-utils.js'
import { explodeMeasurement, type LoadedAssembly } from '../assembly-explode.js'
import { loadDefaultPricingProfileConfig } from '../pricing-profile-config.js'

export type AssemblyRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const ASSEMBLY_COLUMNS = `
  id, company_id, service_item_code, name, description, total_rate, unit,
  origin, deleted_at, version, created_at, updated_at
`

const COMPONENT_COLUMNS = `
  id, company_id, assembly_id, kind, name, quantity_per_unit, unit, unit_cost,
  waste_pct, sort_order, quantity_formula, formula_vars, created_at, updated_at
`

/**
 * Vars a component quantity_formula is allowed to reference: the two always-bound
 * by the explode path plus whatever keys the component's own formula_vars supply.
 * Used to preflight a formula at write time (reject `unknown variable: x`).
 */
function allowedFormulaVars(formulaVars: Record<string, number | string> | null): string[] {
  return ['measurement_quantity', 'measurement_unit', ...Object.keys(formulaVars ?? {})]
}

/**
 * Parse + validate the optional formula fields from a component create/patch
 * body. Returns the normalized values or throws HttpError(400) on bad input.
 * `quantity_formula` of null/'' clears the formula (back to the static
 * quantity_per_unit path).
 */
function parseFormulaFields(body: Record<string, unknown>): {
  hasFormula: boolean
  quantityFormula: string | null
  hasVars: boolean
  formulaVars: Record<string, number | string> | null
} {
  const hasVars = body.formula_vars !== undefined
  let formulaVars: Record<string, number | string> | null = null
  if (hasVars && body.formula_vars !== null) {
    const raw = body.formula_vars
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'formula_vars must be an object of number|string values')
    }
    const out: Record<string, number | string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
      else if (typeof v === 'string') out[k] = v
      else throw new HttpError(400, `formula_vars.${k} must be a finite number or string`)
    }
    formulaVars = out
  }

  const hasFormula = body.quantity_formula !== undefined
  let quantityFormula: string | null = null
  if (hasFormula && body.quantity_formula !== null && String(body.quantity_formula).trim() !== '') {
    const formula = String(body.quantity_formula)
    const result = validateFormula(formula, allowedFormulaVars(formulaVars))
    if (!result.valid) {
      throw new HttpError(400, `quantity_formula invalid: ${result.errors.join('; ')}`)
    }
    quantityFormula = formula
  }
  return { hasFormula, quantityFormula, hasVars, formulaVars }
}

interface AssemblyRow {
  id: string
  company_id: string
  service_item_code: string
  name: string
  description: string | null
  total_rate: string
  unit: string
  origin: string | null
  deleted_at: string | null
  version: number
  created_at: string
  updated_at: string
}

interface ComponentRow {
  id: string
  company_id: string
  assembly_id: string
  kind: 'material' | 'labor' | 'sub' | 'freight'
  name: string
  quantity_per_unit: string
  unit: string
  unit_cost: string
  waste_pct: string
  sort_order: number
  quantity_formula: string | null
  formula_vars: Record<string, number | string> | null
  created_at: string
  updated_at: string
}

/**
 * Recompute and persist an assembly's cached `total_rate` from its
 * components. total_rate = sum(quantity_per_unit * (1 + waste_pct/100) *
 * unit_cost). Callers must already hold a FOR UPDATE lock on the header
 * row so concurrent component edits don't race this recompute. Also bumps
 * the header `version` so the cached rate has the same optimistic-lock
 * provenance as a direct header edit.
 *
 * NOTE (Phase 2): formula-driven components are treated as "indeterminate
 * per-unit" here — the cache keeps using the static `quantity_per_unit` so the
 * header preview stays a cheap display hint. The real explode math runs at
 * recompute time with a concrete `measurement_quantity` (see assembly-explode.ts),
 * so a NULL/static quantity_per_unit on a formula component just means the
 * header total under-counts that row in the preview; it is never authoritative.
 */
async function recomputeAssemblyTotal(client: PoolClient, companyId: string, assemblyId: string): Promise<void> {
  const recompute = await client.query<{ total: string }>(
    `select coalesce(sum(quantity_per_unit * (1 + waste_pct / 100.0) * unit_cost), 0) as total
     from service_item_assembly_components where company_id = $1 and assembly_id = $2`,
    [companyId, assemblyId],
  )
  await client.query(
    `update service_item_assemblies
       set total_rate = $3, updated_at = now(), version = version + 1
     where company_id = $1 and id = $2`,
    [companyId, assemblyId, recompute.rows[0]?.total ?? '0'],
  )
}

/**
 * PlanSwift-style assemblies (Phase 3F).
 *
 *   GET    /api/assemblies                            list active assemblies
 *   POST   /api/assemblies                            create
 *   GET    /api/assemblies/:id                        detail with components
 *   PATCH  /api/assemblies/:id                        rename / retarget header
 *   POST   /api/assemblies/:id/components             add a component
 *   PATCH  /api/assemblies/:id/components/:cid        edit a component
 *   DELETE /api/assemblies/:id/components/:cid        remove a component
 *   DELETE /api/assemblies/:id                        soft-delete
 *
 * total_rate on the header is the cached sum of components' contribution
 * per unit-of-assembly. Updated whenever a component is added; the
 * estimate flow reads total_rate as the per-unit price.
 */
export async function handleAssemblyRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: AssemblyRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/assemblies') {
    const serviceItem = String(url.searchParams.get('service_item_code') ?? '').trim()
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<AssemblyRow>(
        `select ${ASSEMBLY_COLUMNS}
       from service_item_assemblies
       where company_id = $1
         and deleted_at is null
         and ($2 = '' or service_item_code = $2)
       order by service_item_code asc, created_at desc`,
        [ctx.company.id, serviceItem],
      ),
    )
    ctx.sendJson(200, { assemblies: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/assemblies') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const serviceItem = typeof body.service_item_code === 'string' ? body.service_item_code.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!serviceItem) {
      ctx.sendJson(400, { error: 'service_item_code is required' })
      return true
    }
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    const description = typeof body.description === 'string' ? body.description.slice(0, 2048) : null
    const unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim() : 'sqft'

    const created = await withMutationTx(async (client: PoolClient) => {
      const insert = await client.query<AssemblyRow>(
        `insert into service_item_assemblies
           (company_id, service_item_code, name, description, unit)
         values ($1, $2, $3, $4, $5)
         returning ${ASSEMBLY_COLUMNS}`,
        [ctx.company.id, serviceItem, name, description, unit],
      )
      const row = insert.rows[0]
      if (!row) throw new HttpError(500, 'assembly insert returned no row')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'service_item_assembly',
        entityId: row.id,
        action: 'create',
        row: row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    ctx.sendJson(201, { assembly: created, components: [] })
    return true
  }

  const detailMatch = url.pathname.match(/^\/api\/assemblies\/([^/]+)$/)

  // PATCH /api/assemblies/:id — rename the header / retarget its
  // service_item_code or unit. Component edits go through the
  // /:id/components routes below; this only touches the header fields.
  if (req.method === 'PATCH' && detailMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const sets: string[] = []
    const values: unknown[] = [ctx.company.id, id]
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) {
        ctx.sendJson(400, { error: 'name must be a non-empty string' })
        return true
      }
      values.push(name)
      sets.push(`name = $${values.length}`)
    }
    if (body.service_item_code !== undefined) {
      const code = typeof body.service_item_code === 'string' ? body.service_item_code.trim() : ''
      if (!code) {
        ctx.sendJson(400, { error: 'service_item_code must be a non-empty string' })
        return true
      }
      values.push(code)
      sets.push(`service_item_code = $${values.length}`)
    }
    if (body.description !== undefined) {
      values.push(typeof body.description === 'string' ? body.description.slice(0, 2048) : null)
      sets.push(`description = $${values.length}`)
    }
    if (body.unit !== undefined) {
      const unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim() : ''
      if (!unit) {
        ctx.sendJson(400, { error: 'unit must be a non-empty string' })
        return true
      }
      values.push(unit)
      sets.push(`unit = $${values.length}`)
    }
    if (sets.length === 0) {
      ctx.sendJson(400, { error: 'no updatable fields supplied' })
      return true
    }
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<AssemblyRow>(
        `update service_item_assemblies
           set ${sets.join(', ')}, updated_at = now(), version = version + 1
         where company_id = $1 and id = $2 and deleted_at is null
         returning ${ASSEMBLY_COLUMNS}`,
        values,
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'service_item_assembly',
        entityId: row.id,
        action: 'update',
        row: row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'assembly not found' })
      return true
    }
    ctx.sendJson(200, { assembly: updated })
    return true
  }

  if (req.method === 'GET' && detailMatch) {
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const headerResult = await withCompanyClient(ctx.company.id, (c) =>
      c.query<AssemblyRow>(
        `select ${ASSEMBLY_COLUMNS}
       from service_item_assemblies
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
        [ctx.company.id, id],
      ),
    )
    if (!headerResult.rows[0]) {
      ctx.sendJson(404, { error: 'assembly not found' })
      return true
    }
    const componentsResult = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ComponentRow>(
        `select ${COMPONENT_COLUMNS}
       from service_item_assembly_components
       where company_id = $1 and assembly_id = $2
       order by sort_order asc, created_at asc`,
        [ctx.company.id, id],
      ),
    )
    ctx.sendJson(200, { assembly: headerResult.rows[0], components: componentsResult.rows })
    return true
  }

  // POST /api/assemblies/:id/explode — preview-only (no DB write). Runs the
  // SAME formula + resolveAssembly + applyMarkup pipeline as recompute against
  // a caller-supplied sample measurement, returning the resolution + markup
  // breakdown. Powers the editor live-preview and the "what will this cost"
  // affordance. Any company member may read (no requireRole gate).
  const explodeMatch = url.pathname.match(/^\/api\/assemblies\/([^/]+)\/explode$/)
  if (req.method === 'POST' && explodeMatch) {
    const id = explodeMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const measurementQuantity = Number(body.measurement_quantity)
    if (!Number.isFinite(measurementQuantity) || measurementQuantity < 0) {
      ctx.sendJson(400, { error: 'measurement_quantity must be a non-negative number' })
      return true
    }
    const isDeduction = body.is_deduction === true

    const header = await withCompanyClient(ctx.company.id, (c) =>
      c.query<AssemblyRow>(
        `select ${ASSEMBLY_COLUMNS}
           from service_item_assemblies
          where company_id = $1 and id = $2 and deleted_at is null
          limit 1`,
        [ctx.company.id, id],
      ),
    )
    const headerRow = header.rows[0]
    if (!headerRow) {
      ctx.sendJson(404, { error: 'assembly not found' })
      return true
    }
    const measurementUnit =
      typeof body.measurement_unit === 'string' && body.measurement_unit.trim()
        ? body.measurement_unit.trim()
        : headerRow.unit
    const componentRows = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ComponentRow>(
        `select ${COMPONENT_COLUMNS}
           from service_item_assembly_components
          where company_id = $1 and assembly_id = $2
          order by sort_order asc, created_at asc`,
        [ctx.company.id, id],
      ),
    )
    const profileConfig = await loadDefaultPricingProfileConfig(ctx.pool, ctx.company.id)
    const loaded: LoadedAssembly = {
      header: {
        id: headerRow.id,
        service_item_code: headerRow.service_item_code,
        name: headerRow.name,
        unit: headerRow.unit,
      },
      components: componentRows.rows.map((c) => ({
        id: c.id,
        assembly_id: c.assembly_id,
        kind: c.kind,
        name: c.name,
        quantity_per_unit: Number(c.quantity_per_unit),
        unit: c.unit,
        unit_cost: Number(c.unit_cost),
        waste_pct: Number(c.waste_pct),
        sort_order: c.sort_order,
        quantity_formula: c.quantity_formula,
        formula_vars: c.formula_vars,
      })),
    }
    try {
      const exploded = explodeMeasurement({
        assembly: loaded,
        measurementQuantity,
        measurementUnit,
        isDeduction,
        divisionCode: null,
        fallbackServiceItemCode: headerRow.service_item_code,
        profileConfig,
      })
      ctx.sendJson(200, {
        resolution: exploded.resolution,
        markup: exploded.markup,
        lines: exploded.lines,
      })
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  const componentsMatch = url.pathname.match(/^\/api\/assemblies\/([^/]+)\/components$/)
  if (req.method === 'POST' && componentsMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const assemblyId = componentsMatch[1]!
    if (!isValidUuid(assemblyId)) {
      ctx.sendJson(400, { error: 'assembly id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const kind = typeof body.kind === 'string' ? body.kind.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!['material', 'labor', 'sub', 'freight'].includes(kind)) {
      ctx.sendJson(400, { error: 'kind must be material|labor|sub|freight' })
      return true
    }
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    const qty = body.quantity_per_unit === undefined ? 1 : Number(body.quantity_per_unit)
    const unitCost = body.unit_cost === undefined ? 0 : Number(body.unit_cost)
    const waste = body.waste_pct === undefined ? 0 : Number(body.waste_pct)
    if (!Number.isFinite(qty) || qty < 0) {
      ctx.sendJson(400, { error: 'quantity_per_unit must be >= 0' })
      return true
    }
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      ctx.sendJson(400, { error: 'unit_cost must be >= 0' })
      return true
    }
    const unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim() : 'ea'

    // Phase 2: optional quantity_formula + formula_vars. Validated at write
    // time (400 on bad syntax / unknown var) so a bad formula never reaches
    // explode. NULL formula => the static quantity_per_unit path.
    let formulaFields: ReturnType<typeof parseFormulaFields>
    try {
      formulaFields = parseFormulaFields(body)
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }

    // Recompute total_rate after insert. Lock the parent assembly so
    // two concurrent inserts can't read the same max(sort_order) and
    // collide. Same pattern as takeoff-tags.
    const result = await withMutationTx(async (client: PoolClient) => {
      const owner = await client.query(
        `select 1 from service_item_assemblies
         where company_id = $1 and id = $2 and deleted_at is null for update`,
        [ctx.company.id, assemblyId],
      )
      if (owner.rowCount === 0) return null
      const max = await client.query<{ max_sort: number | null }>(
        `select coalesce(max(sort_order), -1) as max_sort
         from service_item_assembly_components where company_id = $1 and assembly_id = $2`,
        [ctx.company.id, assemblyId],
      )
      const sortOrder = (max.rows[0]?.max_sort ?? -1) + 1
      const insert = await client.query<ComponentRow>(
        `insert into service_item_assembly_components
           (company_id, assembly_id, kind, name, quantity_per_unit, unit, unit_cost, waste_pct, sort_order, quantity_formula, formula_vars)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         returning ${COMPONENT_COLUMNS}`,
        [
          ctx.company.id,
          assemblyId,
          kind,
          name,
          qty,
          unit,
          unitCost,
          waste,
          sortOrder,
          formulaFields.quantityFormula,
          formulaFields.formulaVars === null ? null : JSON.stringify(formulaFields.formulaVars),
        ],
      )
      // Refresh the cached header rate from all components.
      await recomputeAssemblyTotal(client, ctx.company.id, assemblyId)
      const componentRow = insert.rows[0]
      if (!componentRow) throw new HttpError(500, 'assembly component insert returned no row')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'service_item_assembly_component',
        entityId: componentRow.id,
        action: 'create',
        row: componentRow,
        actorUserId: ctx.currentUserId,
      })
      return componentRow
    })
    if (!result) {
      ctx.sendJson(404, { error: 'assembly not found' })
      return true
    }
    ctx.sendJson(201, { component: result })
    return true
  }

  // PATCH / DELETE a single component. Both recompute the parent
  // assembly's cached total_rate the same way the component-create path
  // does, holding a FOR UPDATE lock on the header so concurrent edits
  // don't race the recompute.
  const componentItemMatch = url.pathname.match(/^\/api\/assemblies\/([^/]+)\/components\/([^/]+)$/)
  if ((req.method === 'PATCH' || req.method === 'DELETE') && componentItemMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const assemblyId = componentItemMatch[1]!
    const componentId = componentItemMatch[2]!
    if (!isValidUuid(assemblyId) || !isValidUuid(componentId)) {
      ctx.sendJson(400, { error: 'assembly id and component id must be valid uuids' })
      return true
    }

    if (req.method === 'PATCH') {
      const body = await ctx.readBody()
      const sets: string[] = []
      const values: unknown[] = [ctx.company.id, assemblyId, componentId]
      if (body.kind !== undefined) {
        const kind = typeof body.kind === 'string' ? body.kind.trim() : ''
        if (!['material', 'labor', 'sub', 'freight'].includes(kind)) {
          ctx.sendJson(400, { error: 'kind must be material|labor|sub|freight' })
          return true
        }
        values.push(kind)
        sets.push(`kind = $${values.length}`)
      }
      if (body.name !== undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) {
          ctx.sendJson(400, { error: 'name must be a non-empty string' })
          return true
        }
        values.push(name)
        sets.push(`name = $${values.length}`)
      }
      if (body.quantity_per_unit !== undefined) {
        const qty = Number(body.quantity_per_unit)
        if (!Number.isFinite(qty) || qty < 0) {
          ctx.sendJson(400, { error: 'quantity_per_unit must be >= 0' })
          return true
        }
        values.push(qty)
        sets.push(`quantity_per_unit = $${values.length}`)
      }
      if (body.unit !== undefined) {
        const unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim() : ''
        if (!unit) {
          ctx.sendJson(400, { error: 'unit must be a non-empty string' })
          return true
        }
        values.push(unit)
        sets.push(`unit = $${values.length}`)
      }
      if (body.unit_cost !== undefined) {
        const unitCost = Number(body.unit_cost)
        if (!Number.isFinite(unitCost) || unitCost < 0) {
          ctx.sendJson(400, { error: 'unit_cost must be >= 0' })
          return true
        }
        values.push(unitCost)
        sets.push(`unit_cost = $${values.length}`)
      }
      if (body.waste_pct !== undefined) {
        const waste = Number(body.waste_pct)
        if (!Number.isFinite(waste) || waste < 0) {
          ctx.sendJson(400, { error: 'waste_pct must be >= 0' })
          return true
        }
        values.push(waste)
        sets.push(`waste_pct = $${values.length}`)
      }
      // Phase 2: optional formula fields. Either may be patched independently;
      // a formula supplied without vars is validated against the always-bound
      // vars plus any vars in the SAME patch. Setting quantity_formula to
      // null/'' clears it (back to the static quantity_per_unit path).
      if (body.quantity_formula !== undefined || body.formula_vars !== undefined) {
        let formulaFields: ReturnType<typeof parseFormulaFields>
        try {
          formulaFields = parseFormulaFields(body)
        } catch (err) {
          if (err instanceof HttpError) {
            ctx.sendJson(err.status, { error: err.message })
            return true
          }
          throw err
        }
        if (formulaFields.hasFormula) {
          values.push(formulaFields.quantityFormula)
          sets.push(`quantity_formula = $${values.length}`)
        }
        if (formulaFields.hasVars) {
          values.push(formulaFields.formulaVars === null ? null : JSON.stringify(formulaFields.formulaVars))
          sets.push(`formula_vars = $${values.length}::jsonb`)
        }
      }
      if (sets.length === 0) {
        ctx.sendJson(400, { error: 'no updatable fields supplied' })
        return true
      }
      const result = await withMutationTx(async (client: PoolClient) => {
        const owner = await client.query(
          `select 1 from service_item_assemblies
           where company_id = $1 and id = $2 and deleted_at is null for update`,
          [ctx.company.id, assemblyId],
        )
        if (owner.rowCount === 0) return null
        const update = await client.query<ComponentRow>(
          `update service_item_assembly_components
             set ${sets.join(', ')}, updated_at = now()
           where company_id = $1 and assembly_id = $2 and id = $3
           returning ${COMPONENT_COLUMNS}`,
          values,
        )
        const componentRow = update.rows[0]
        if (!componentRow) return null
        await recomputeAssemblyTotal(client, ctx.company.id, assemblyId)
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'service_item_assembly_component',
          entityId: componentRow.id,
          action: 'update',
          row: componentRow,
          actorUserId: ctx.currentUserId,
        })
        return componentRow
      })
      if (!result) {
        ctx.sendJson(404, { error: 'assembly component not found' })
        return true
      }
      ctx.sendJson(200, { component: result })
      return true
    }

    // DELETE
    const removed = await withMutationTx(async (client: PoolClient) => {
      const owner = await client.query(
        `select 1 from service_item_assemblies
         where company_id = $1 and id = $2 and deleted_at is null for update`,
        [ctx.company.id, assemblyId],
      )
      if (owner.rowCount === 0) return null
      const del = await client.query<ComponentRow>(
        `delete from service_item_assembly_components
         where company_id = $1 and assembly_id = $2 and id = $3
         returning ${COMPONENT_COLUMNS}`,
        [ctx.company.id, assemblyId, componentId],
      )
      const componentRow = del.rows[0]
      if (!componentRow) return null
      await recomputeAssemblyTotal(client, ctx.company.id, assemblyId)
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'service_item_assembly_component',
        entityId: componentRow.id,
        action: 'delete',
        row: componentRow,
        actorUserId: ctx.currentUserId,
      })
      return componentRow
    })
    if (!removed) {
      ctx.sendJson(404, { error: 'assembly component not found' })
      return true
    }
    ctx.sendJson(200, { component: removed })
    return true
  }

  if (req.method === 'DELETE' && detailMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<AssemblyRow>(
        `update service_item_assemblies
           set deleted_at = now(), updated_at = now(), version = version + 1
         where company_id = $1 and id = $2 and deleted_at is null
         returning ${ASSEMBLY_COLUMNS}`,
        [ctx.company.id, id],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'service_item_assembly',
        entityId: row.id,
        action: 'delete',
        row: row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    if (!deleted) {
      ctx.sendJson(404, { error: 'assembly not found' })
      return true
    }
    ctx.sendJson(200, { assembly: deleted })
    return true
  }

  return false
}
