import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidUuid } from '../http-utils.js'

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
  waste_pct, sort_order, created_at, updated_at
`

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
  created_at: string
  updated_at: string
}

/**
 * PlanSwift-style assemblies (Phase 3F).
 *
 *   GET  /api/assemblies                     list active assemblies
 *   POST /api/assemblies                     create
 *   GET  /api/assemblies/:id                 detail with components
 *   POST /api/assemblies/:id/components      add a component
 *   DELETE /api/assemblies/:id               soft-delete
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
    const result = await ctx.pool.query<AssemblyRow>(
      `select ${ASSEMBLY_COLUMNS}
       from service_item_assemblies
       where company_id = $1
         and deleted_at is null
         and ($2 = '' or service_item_code = $2)
       order by service_item_code asc, created_at desc`,
      [ctx.company.id, serviceItem],
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
      const row = insert.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'service_item_assembly',
        entityId: row.id,
        action: 'create',
        row: row as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    ctx.sendJson(201, { assembly: created, components: [] })
    return true
  }

  const detailMatch = url.pathname.match(/^\/api\/assemblies\/([^/]+)$/)
  if (req.method === 'GET' && detailMatch) {
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const headerResult = await ctx.pool.query<AssemblyRow>(
      `select ${ASSEMBLY_COLUMNS}
       from service_item_assemblies
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
      [ctx.company.id, id],
    )
    if (!headerResult.rows[0]) {
      ctx.sendJson(404, { error: 'assembly not found' })
      return true
    }
    const componentsResult = await ctx.pool.query<ComponentRow>(
      `select ${COMPONENT_COLUMNS}
       from service_item_assembly_components
       where company_id = $1 and assembly_id = $2
       order by sort_order asc, created_at asc`,
      [ctx.company.id, id],
    )
    ctx.sendJson(200, { assembly: headerResult.rows[0], components: componentsResult.rows })
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
           (company_id, assembly_id, kind, name, quantity_per_unit, unit, unit_cost, waste_pct, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning ${COMPONENT_COLUMNS}`,
        [ctx.company.id, assemblyId, kind, name, qty, unit, unitCost, waste, sortOrder],
      )
      // total_rate = sum(quantity_per_unit * (1 + waste_pct/100) * unit_cost)
      // across components.
      const recompute = await client.query<{ total: string }>(
        `select coalesce(sum(quantity_per_unit * (1 + waste_pct / 100.0) * unit_cost), 0) as total
         from service_item_assembly_components where company_id = $1 and assembly_id = $2`,
        [ctx.company.id, assemblyId],
      )
      await client.query(
        `update service_item_assemblies
           set total_rate = $3, updated_at = now(), version = version + 1
         where company_id = $1 and id = $2`,
        [ctx.company.id, assemblyId, recompute.rows[0]?.total ?? '0'],
      )
      const componentRow = insert.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'service_item_assembly_component',
        entityId: componentRow.id,
        action: 'create',
        row: componentRow as unknown as Record<string, unknown>,
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
        row: row as unknown as Record<string, unknown>,
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
