import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleAssemblyRoutes, type AssemblyRouteCtx } from './assemblies.js'

// In-memory pg double for the assembly editor routes (header PATCH +
// component PATCH/DELETE). Matches the route SQL by substring and keeps
// the header `total_rate`/`version` in sync the way recomputeAssemblyTotal
// does. Mirrors the stub style of pricing-overrides.test.ts.

const ASSEMBLY_ID = '11111111-1111-4111-8111-111111111111'
const COMPONENT_ID = '22222222-2222-4222-8222-222222222222'

type AssemblyRow = {
  id: string
  company_id: string
  service_item_code: string
  name: string
  description: string | null
  total_rate: number
  unit: string
  version: number
  deleted_at: string | null
}

type ComponentRow = {
  id: string
  company_id: string
  assembly_id: string
  kind: string
  name: string
  quantity_per_unit: number
  unit: string
  unit_cost: number
  waste_pct: number
  sort_order: number
  quantity_formula: string | null
  formula_vars: Record<string, number | string> | null
}

class FakePool {
  assemblies: AssemblyRow[] = [
    {
      id: ASSEMBLY_ID,
      company_id: 'co-1',
      service_item_code: 'EIFS',
      name: 'EIFS wall',
      description: null,
      total_rate: 10,
      unit: 'sqft',
      version: 1,
      deleted_at: null,
    },
  ]
  components: ComponentRow[] = [
    {
      id: COMPONENT_ID,
      company_id: 'co-1',
      assembly_id: ASSEMBLY_ID,
      kind: 'material',
      name: 'EPS board',
      quantity_per_unit: 1,
      unit: 'sqft',
      unit_cost: 5,
      waste_pct: 0,
      sort_order: 0,
      quantity_formula: null,
      formula_vars: null,
    },
  ]
  // Default pricing profile config used by the explode route. null => the
  // explode pipeline applies DEFAULT_MARKUP_CONFIG.
  pricingConfig: unknown = { material_waste_pct: 0, labor_burden_pct: 0, profit_margin_pct: 0 }

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }
  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  private headerCols(row: AssemblyRow) {
    return {
      id: row.id,
      company_id: row.company_id,
      service_item_code: row.service_item_code,
      name: row.name,
      description: row.description,
      total_rate: String(row.total_rate),
      unit: row.unit,
      origin: 'local',
      deleted_at: row.deleted_at,
      version: row.version,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
  }

  private componentCols(row: ComponentRow) {
    return {
      id: row.id,
      company_id: row.company_id,
      assembly_id: row.assembly_id,
      kind: row.kind,
      name: row.name,
      quantity_per_unit: String(row.quantity_per_unit),
      unit: row.unit,
      unit_cost: String(row.unit_cost),
      waste_pct: String(row.waste_pct),
      sort_order: row.sort_order,
      quantity_formula: row.quantity_formula,
      formula_vars: row.formula_vars,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    if (/^(begin|commit|rollback)/i.test(sql) || /^select set_config/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }

    // FOR UPDATE lock on the header
    if (/^select 1 from service_item_assemblies/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.assemblies.find((a) => a.id === id && a.company_id === companyId && a.deleted_at === null)
      return { rows: row ? [{ '?column?': 1 }] : [], rowCount: row ? 1 : 0 }
    }

    // Explode / GET-detail route: header detail SELECT (full columns, limit 1).
    if (/^select[\s\S]*from\s+service_item_assemblies/i.test(sql) && /limit 1/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.assemblies.find((a) => a.id === id && a.company_id === companyId && a.deleted_at === null)
      return { rows: row ? [this.headerCols(row)] : [], rowCount: row ? 1 : 0 }
    }

    // Explode route: components list SELECT for one assembly.
    if (/^select[\s\S]*from\s+service_item_assembly_components/i.test(sql) && /order by sort_order/i.test(sql)) {
      const [companyId, assemblyId] = params as [string, string]
      const rows = this.components
        .filter((c) => c.assembly_id === assemblyId && c.company_id === companyId)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((c) => this.componentCols(c))
      return { rows, rowCount: rows.length }
    }

    // Explode route: default pricing profile config lookup.
    if (/^select\s+config\s+from\s+pricing_profiles/i.test(sql)) {
      return { rows: [{ config: this.pricingConfig }], rowCount: 1 }
    }

    // Component POST: max(sort_order) lookup for the next sort index.
    if (/coalesce\(max\(sort_order\)/i.test(sql)) {
      const [companyId, assemblyId] = params as [string, string]
      const max = this.components
        .filter((c) => c.assembly_id === assemblyId && c.company_id === companyId)
        .reduce((m, c) => Math.max(m, c.sort_order), -1)
      return { rows: [{ max_sort: max }], rowCount: 1 }
    }

    // Component INSERT (POST).
    if (/^insert into service_item_assembly_components/i.test(sql)) {
      const [companyId, assemblyId, kind, name, qty, unit, unitCost, waste, sortOrder, quantityFormula, formulaVars] =
        params as [string, string, string, string, number, string, number, number, number, string | null, string | null]
      const row: ComponentRow = {
        id: `c-new-${this.components.length}`,
        company_id: companyId,
        assembly_id: assemblyId,
        kind,
        name,
        quantity_per_unit: Number(qty),
        unit,
        unit_cost: Number(unitCost),
        waste_pct: Number(waste),
        sort_order: Number(sortOrder),
        quantity_formula: quantityFormula ?? null,
        formula_vars: formulaVars === null || formulaVars === undefined ? null : JSON.parse(String(formulaVars)),
      }
      this.components.push(row)
      return { rows: [this.componentCols(row)], rowCount: 1 }
    }

    // PATCH header — dynamic set list. Distinguished from the recompute
    // UPDATE by the SET clause: header edits set name/code/etc; the
    // recompute path sets `total_rate`. (Both RETURN total_rate, so match
    // on `set total_rate`, not a bare `total_rate`.)
    if (/^update service_item_assemblies/i.test(sql) && !/set total_rate = \$/.test(sql)) {
      const [companyId, id, ...rest] = params as [string, string, ...unknown[]]
      const row = this.assemblies.find((a) => a.id === id && a.company_id === companyId && a.deleted_at === null)
      if (!row) return { rows: [], rowCount: 0 }
      const next = [...rest]
      if (/[ ,]name = \$/.test(sql)) row.name = next.shift() as string
      if (/[ ,]service_item_code = \$/.test(sql)) row.service_item_code = next.shift() as string
      if (/[ ,]description = \$/.test(sql)) row.description = next.shift() as string | null
      if (/[ ,]unit = \$/.test(sql)) row.unit = next.shift() as string
      row.version += 1
      return { rows: [this.headerCols(row)], rowCount: 1 }
    }

    // recomputeAssemblyTotal SELECT
    if (/coalesce\(sum\(quantity_per_unit/i.test(sql)) {
      const [companyId, assemblyId] = params as [string, string]
      const total = this.components
        .filter((c) => c.assembly_id === assemblyId && c.company_id === companyId)
        .reduce((sum, c) => sum + c.quantity_per_unit * (1 + c.waste_pct / 100) * c.unit_cost, 0)
      return { rows: [{ total: String(total) }], rowCount: 1 }
    }

    // recomputeAssemblyTotal UPDATE (sets total_rate)
    if (/^update service_item_assemblies/i.test(sql) && /set total_rate = \$/.test(sql)) {
      const [companyId, id, total] = params as [string, string, string]
      const row = this.assemblies.find((a) => a.id === id && a.company_id === companyId)
      if (row) {
        row.total_rate = Number(total)
        row.version += 1
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    // PATCH component
    if (/^update service_item_assembly_components/i.test(sql)) {
      const [companyId, assemblyId, componentId, ...rest] = params as [string, string, string, ...unknown[]]
      const row = this.components.find(
        (c) => c.id === componentId && c.assembly_id === assemblyId && c.company_id === companyId,
      )
      if (!row) return { rows: [], rowCount: 0 }
      // Column matchers anchor on a `set `/`, ` boundary so `unit = $`
      // doesn't spuriously match the tail of `quantity_per_unit = $`. Params
      // arrive in the route's fixed SET order; consume them by shifting.
      const next = [...rest]
      if (/[ ,]kind = \$/.test(sql)) row.kind = next.shift() as string
      if (/[ ,]name = \$/.test(sql)) row.name = next.shift() as string
      if (/[ ,]quantity_per_unit = \$/.test(sql)) row.quantity_per_unit = Number(next.shift())
      // `unit = $` must not match the tail of `quantity_per_unit`; anchor handled
      // above. The formula columns are matched explicitly so they don't get
      // swallowed by the `unit` matcher.
      if (/[ ,]unit = \$/.test(sql)) row.unit = next.shift() as string
      if (/[ ,]unit_cost = \$/.test(sql)) row.unit_cost = Number(next.shift())
      if (/[ ,]waste_pct = \$/.test(sql)) row.waste_pct = Number(next.shift())
      if (/[ ,]quantity_formula = \$/.test(sql)) row.quantity_formula = (next.shift() as string | null) ?? null
      if (/[ ,]formula_vars = \$/.test(sql)) {
        const raw = next.shift() as string | null
        row.formula_vars = raw === null || raw === undefined ? null : JSON.parse(String(raw))
      }
      return { rows: [this.componentCols(row)], rowCount: 1 }
    }

    // DELETE component
    if (/^delete from service_item_assembly_components/i.test(sql)) {
      const [companyId, assemblyId, componentId] = params as [string, string, string]
      const idx = this.components.findIndex(
        (c) => c.id === componentId && c.assembly_id === assemblyId && c.company_id === companyId,
      )
      if (idx < 0) return { rows: [], rowCount: 0 }
      const [removed] = this.components.splice(idx, 1)
      return { rows: [this.componentCols(removed!)], rowCount: 1 }
    }

    if (/^insert into sync_events/i.test(sql) || /^insert into mutation_outbox/i.test(sql)) {
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeCtx(pool: FakePool, opts: { role?: boolean } = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  const ctx: AssemblyRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' },
    currentUserId: 'u-1',
    requireRole: () => opts.role ?? true,
    readBody: async () => (reads.shift() ?? {}) as Record<string, unknown>,
    sendJson: (status, body) => {
      responses.push({ status, body })
    },
  }
  return { ctx, responses, reads }
}

const url = (p: string) => new URL(`http://localhost${p}`)

describe('handleAssemblyRoutes editor endpoints', () => {
  it('PATCH /:id renames the header', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ name: 'EIFS wall v2' })
    const handled = await handleAssemblyRoutes({ method: 'PATCH' } as never, url(`/api/assemblies/${ASSEMBLY_ID}`), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { assembly: { name: string } }).assembly.name).toBe('EIFS wall v2')
    expect(pool.assemblies[0]?.name).toBe('EIFS wall v2')
  })

  it('PATCH /:id rejects an empty body', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({})
    await handleAssemblyRoutes({ method: 'PATCH' } as never, url(`/api/assemblies/${ASSEMBLY_ID}`), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('PATCH /:id/components/:cid edits a component and recomputes total_rate', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ quantity_per_unit: 2, unit_cost: 5 })
    const handled = await handleAssemblyRoutes(
      { method: 'PATCH' } as never,
      url(`/api/assemblies/${ASSEMBLY_ID}/components/${COMPONENT_ID}`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect(pool.components[0]?.quantity_per_unit).toBe(2)
    // 2 * (1 + 0) * 5 = 10
    expect(pool.assemblies[0]?.total_rate).toBe(10)
  })

  it('PATCH /:id/components/:cid rejects an out-of-range kind', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ kind: 'bogus' })
    await handleAssemblyRoutes(
      { method: 'PATCH' } as never,
      url(`/api/assemblies/${ASSEMBLY_ID}/components/${COMPONENT_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('DELETE /:id/components/:cid removes the component and recomputes total_rate to 0', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleAssemblyRoutes(
      { method: 'DELETE' } as never,
      url(`/api/assemblies/${ASSEMBLY_ID}/components/${COMPONENT_ID}`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect(pool.components).toHaveLength(0)
    expect(pool.assemblies[0]?.total_rate).toBe(0)
  })

  it('returns 404 deleting a component on a missing assembly', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const missing = '99999999-9999-4999-8999-999999999999'
    await handleAssemblyRoutes(
      { method: 'DELETE' } as never,
      url(`/api/assemblies/${missing}/components/${COMPONENT_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })

  it('ignores unrelated paths', async () => {
    const pool = new FakePool()
    const { ctx } = makeCtx(pool)
    const handled = await handleAssemblyRoutes({ method: 'GET' } as never, url('/api/projects/p-1/summary'), ctx)
    expect(handled).toBe(false)
  })
})

describe('handleAssemblyRoutes formula fields', () => {
  it('POST /:id/components with a valid formula → 201 and persists it', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({
      kind: 'material',
      name: 'finish coat',
      unit_cost: 40,
      quantity_formula: 'measurement_quantity / coverage_rate',
      formula_vars: { coverage_rate: 100 },
    })
    const handled = await handleAssemblyRoutes(
      { method: 'POST' } as never,
      url(`/api/assemblies/${ASSEMBLY_ID}/components`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(201)
    const added = pool.components.find((c) => c.name === 'finish coat')
    expect(added?.quantity_formula).toBe('measurement_quantity / coverage_rate')
    expect(added?.formula_vars).toEqual({ coverage_rate: 100 })
  })

  it('POST /:id/components with a bad formula → 400', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ kind: 'material', name: 'bad', quantity_formula: 'measurement_quantity * (' })
    await handleAssemblyRoutes({ method: 'POST' } as never, url(`/api/assemblies/${ASSEMBLY_ID}/components`), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toMatch(/quantity_formula invalid/)
  })

  it('POST /:id/components rejects a formula referencing an unknown var → 400', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ kind: 'material', name: 'x', quantity_formula: 'measurement_quantity * nope' })
    await handleAssemblyRoutes({ method: 'POST' } as never, url(`/api/assemblies/${ASSEMBLY_ID}/components`), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toMatch(/unknown variable: nope/)
  })

  it('PATCH /:id/components/:cid sets a formula', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ quantity_formula: 'measurement_quantity * 1.1' })
    await handleAssemblyRoutes(
      { method: 'PATCH' } as never,
      url(`/api/assemblies/${ASSEMBLY_ID}/components/${COMPONENT_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect(pool.components[0]?.quantity_formula).toBe('measurement_quantity * 1.1')
  })
})

describe('handleAssemblyRoutes explode preview', () => {
  it('POST /:id/explode returns the resolution + markup breakdown', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ measurement_quantity: 1000 })
    const handled = await handleAssemblyRoutes(
      { method: 'POST' } as never,
      url(`/api/assemblies/${ASSEMBLY_ID}/explode`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as {
      resolution: { total: number; by_kind: Record<string, number> }
      markup: { total: number }
      lines: Array<{ kind: string; amount: number; assembly_id: string }>
    }
    // single material component: 1000 × 1 × $5 = $5000 (waste 0, no markup config uplift)
    expect(body.resolution.by_kind.material).toBe(5000)
    expect(body.markup.total).toBe(5000)
    expect(body.lines).toHaveLength(1)
    expect(body.lines[0]!.kind).toBe('material')
    expect(body.lines[0]!.assembly_id).toBe(ASSEMBLY_ID)
  })

  it('POST /:id/explode flips signs for a deduction', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ measurement_quantity: 1000, is_deduction: true })
    await handleAssemblyRoutes({ method: 'POST' } as never, url(`/api/assemblies/${ASSEMBLY_ID}/explode`), ctx)
    const body = responses[0]?.body as { lines: Array<{ amount: number }> }
    expect(body.lines[0]!.amount).toBe(-5000)
  })

  it('POST /:id/explode 404s on a missing assembly', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ measurement_quantity: 1000 })
    const missing = '99999999-9999-4999-8999-999999999999'
    await handleAssemblyRoutes({ method: 'POST' } as never, url(`/api/assemblies/${missing}/explode`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('POST /:id/explode rejects a non-numeric measurement_quantity → 400', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ measurement_quantity: 'banana' })
    await handleAssemblyRoutes({ method: 'POST' } as never, url(`/api/assemblies/${ASSEMBLY_ID}/explode`), ctx)
    expect(responses[0]?.status).toBe(400)
  })
})
