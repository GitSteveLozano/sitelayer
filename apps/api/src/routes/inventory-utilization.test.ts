import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import { handleInventoryUtilizationRoutes } from './inventory-utilization.js'

// ---------------------------------------------------------------------------
// In-memory pg double — recognizes the two queries the handler issues:
//   1. per-item utilization CTE (`with stock as (...)`)
//   2. rollup CTE (`with active_rentals as (...) ... cross join active_rentals`)
//
// The fake skips actual SQL parsing — it just shapes responses from a small
// in-memory model. This is enough to exercise the headline math + tenant
// isolation, which is what the endpoint owners care about.
// ---------------------------------------------------------------------------

interface ItemSeed {
  id: string
  company_id: string
  code: string
  description: string
  unit: string
  default_rental_rate: string
  active: boolean
  deleted_at: string | null
}

interface MovementSeed {
  company_id: string
  inventory_item_id: string
  from_location_type: 'yard' | 'job' | 'in_transit' | 'repair' | 'lost' | 'damaged' | null
  to_location_type: 'yard' | 'job' | 'in_transit' | 'repair' | 'lost' | 'damaged' | null
  movement_type: 'deliver' | 'transfer' | 'adjustment' | 'damage' | 'loss' | 'return'
  quantity: number
}

interface RentalLineSeed {
  company_id: string
  inventory_item_id: string
  quantity: number
  status: 'active' | 'returned'
  off_rent_date: string | null
  deleted_at: string | null
}

class FakePool {
  items: ItemSeed[] = []
  movements: MovementSeed[] = []
  rentalLines: RentalLineSeed[] = []

  async query(sql: string, params: unknown[] = []) {
    const companyId = params[0] as string
    const trimmed = sql.trim()

    if (trimmed.startsWith('with stock as')) {
      // Per-item rows — only active, non-deleted items in this tenant.
      const items = this.items.filter((i) => i.company_id === companyId && i.deleted_at === null && i.active)
      const rows = items.map((i) => {
        // Movement balance: + into usable, - out of usable (excludes lost/damaged).
        let balance = 0
        for (const m of this.movements) {
          if (m.company_id !== companyId || m.inventory_item_id !== i.id) continue
          const intoUsable =
            m.to_location_type !== null && m.to_location_type !== 'lost' && m.to_location_type !== 'damaged'
          const outOfUsable =
            m.from_location_type !== null && m.from_location_type !== 'lost' && m.from_location_type !== 'damaged'
          if (intoUsable) balance += m.quantity
          if (outOfUsable) balance -= m.quantity
          // Per the handler's per-item CTE, damage/loss movement_type also drains stock.
          if (m.movement_type === 'damage' || m.movement_type === 'loss') {
            // Already covered above via to=damaged/lost. Skip double-counting.
          }
        }
        const onRent = this.rentalLines
          .filter(
            (l) =>
              l.company_id === companyId &&
              l.inventory_item_id === i.id &&
              l.deleted_at === null &&
              l.status === 'active' &&
              l.off_rent_date === null,
          )
          .reduce((s, l) => s + l.quantity, 0)
        const available = Math.max(balance - onRent, 0)
        return {
          inventory_item_id: i.id,
          code: i.code,
          description: i.description,
          unit: i.unit,
          default_rental_rate: i.default_rental_rate,
          on_rent_quantity: onRent.toFixed(2),
          available_quantity: available.toFixed(2),
          active_lines: 0,
          days_since_activity: null,
          idle_revenue_per_day_cents: Math.round(available * Number(i.default_rental_rate) * 100),
        }
      })
      return { rows, rowCount: rows.length }
    }

    if (trimmed.startsWith('with active_rentals as')) {
      // Rollup row — sum across tenant.
      const items = this.items.filter((i) => i.company_id === companyId && i.deleted_at === null)
      const totalItems = items.length

      // total_quantity_owned: balance into usable locations (excl lost/damaged).
      let totalQuantityOwned = 0
      let inYard = 0
      let outForService = 0
      for (const m of this.movements) {
        if (m.company_id !== companyId) continue
        const intoUsable =
          m.to_location_type !== null && m.to_location_type !== 'lost' && m.to_location_type !== 'damaged'
        const outOfUsable =
          m.from_location_type !== null && m.from_location_type !== 'lost' && m.from_location_type !== 'damaged'
        if (intoUsable) totalQuantityOwned += m.quantity
        if (outOfUsable) totalQuantityOwned -= m.quantity
        if (m.to_location_type === 'yard') inYard += m.quantity
        if (m.from_location_type === 'yard') inYard -= m.quantity
        if (m.to_location_type === 'repair') outForService += m.quantity
        if (m.from_location_type === 'repair') outForService -= m.quantity
      }
      const onRentCount = this.rentalLines
        .filter(
          (l) =>
            l.company_id === companyId && l.deleted_at === null && l.status === 'active' && l.off_rent_date === null,
        )
        .reduce((s, l) => s + l.quantity, 0)

      return {
        rows: [
          {
            total_items: totalItems,
            total_quantity_owned: totalQuantityOwned.toFixed(2),
            on_rent_count: onRentCount.toFixed(2),
            in_yard_count: Math.max(inYard, 0).toFixed(2),
            out_for_service_count: Math.max(outForService, 0).toFixed(2),
          },
        ],
        rowCount: 1,
      }
    }

    throw new Error(`unexpected SQL: ${trimmed.slice(0, 200)}`)
  }
}

function makeCtx(pool: FakePool, opts: { role?: 'admin' | 'foreman' | 'office' | 'member'; companyId?: string } = {}) {
  const responses: Array<{ status: number; body: unknown }> = []
  const role = opts.role ?? 'admin'
  const ctx = {
    pool: pool as unknown as Pool,
    company: {
      id: opts.companyId ?? 'co-1',
      slug: 'co',
      name: 'Co',
      created_at: '',
      role,
    },
    requireRole: (allowed: readonly string[]) => allowed.includes(role),
    sendJson: (status: number, body: unknown) => {
      responses.push({ status, body })
    },
  }
  return { ctx, responses }
}

function buildReq(): http.IncomingMessage {
  return { method: 'GET' } as http.IncomingMessage
}

function buildUrl(): URL {
  return new URL('http://localhost/api/inventory/utilization')
}

interface UtilizationResponse {
  items: Array<{ inventory_item_id: string; on_rent_quantity: string; available_quantity: string }>
  totals: {
    total_items: number
    total_quantity_owned: number
    on_rent_count: number
    in_yard_count: number
    out_for_service_count: number
    utilization_pct: number
    top_utilized: Array<{ inventory_item_id: string; utilization_pct: number; code: string }>
    generated_at: string
  }
}

describe('handleInventoryUtilizationRoutes — deployment rollup', () => {
  it('returns zero utilization for an empty company', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleInventoryUtilizationRoutes(buildReq(), buildUrl(), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as UtilizationResponse
    expect(body.totals.total_items).toBe(0)
    expect(body.totals.total_quantity_owned).toBe(0)
    expect(body.totals.on_rent_count).toBe(0)
    expect(body.totals.utilization_pct).toBe(0)
    expect(body.totals.top_utilized).toEqual([])
  })

  it('reports 0% utilization when every unit is in the yard', async () => {
    const pool = new FakePool()
    pool.items.push({
      id: 'item-1',
      company_id: 'co-1',
      code: 'SCAF-10',
      description: 'Scaffold 10ft',
      unit: 'ea',
      default_rental_rate: '5.00',
      active: true,
      deleted_at: null,
    })
    pool.movements.push({
      company_id: 'co-1',
      inventory_item_id: 'item-1',
      from_location_type: null,
      to_location_type: 'yard',
      movement_type: 'deliver',
      quantity: 100,
    })
    const { ctx, responses } = makeCtx(pool)
    await handleInventoryUtilizationRoutes(buildReq(), buildUrl(), ctx)
    const body = responses[0]?.body as UtilizationResponse
    expect(body.totals.total_items).toBe(1)
    expect(body.totals.total_quantity_owned).toBe(100)
    expect(body.totals.on_rent_count).toBe(0)
    expect(body.totals.in_yard_count).toBe(100)
    expect(body.totals.utilization_pct).toBe(0)
  })

  it('reports 50% utilization with a 50/50 split between yard and on-rent', async () => {
    const pool = new FakePool()
    pool.items.push({
      id: 'item-1',
      company_id: 'co-1',
      code: 'SCAF-10',
      description: 'Scaffold 10ft',
      unit: 'ea',
      default_rental_rate: '5.00',
      active: true,
      deleted_at: null,
    })
    pool.movements.push({
      company_id: 'co-1',
      inventory_item_id: 'item-1',
      from_location_type: null,
      to_location_type: 'yard',
      movement_type: 'deliver',
      quantity: 100,
    })
    pool.rentalLines.push({
      company_id: 'co-1',
      inventory_item_id: 'item-1',
      quantity: 50,
      status: 'active',
      off_rent_date: null,
      deleted_at: null,
    })
    const { ctx, responses } = makeCtx(pool)
    await handleInventoryUtilizationRoutes(buildReq(), buildUrl(), ctx)
    const body = responses[0]?.body as UtilizationResponse
    expect(body.totals.total_quantity_owned).toBe(100)
    expect(body.totals.on_rent_count).toBe(50)
    expect(body.totals.utilization_pct).toBe(50)
    // Top-utilized list surfaces the single item with its share.
    expect(body.totals.top_utilized).toHaveLength(1)
    expect(body.totals.top_utilized[0]?.utilization_pct).toBe(50)
    expect(body.totals.top_utilized[0]?.code).toBe('SCAF-10')
  })

  it('counts service units in out_for_service but not as on-rent', async () => {
    const pool = new FakePool()
    pool.items.push({
      id: 'item-1',
      company_id: 'co-1',
      code: 'SCAF-10',
      description: 'Scaffold 10ft',
      unit: 'ea',
      default_rental_rate: '5.00',
      active: true,
      deleted_at: null,
    })
    // Receive 10 into yard, then transfer 3 into repair. No rental lines.
    pool.movements.push({
      company_id: 'co-1',
      inventory_item_id: 'item-1',
      from_location_type: null,
      to_location_type: 'yard',
      movement_type: 'deliver',
      quantity: 10,
    })
    pool.movements.push({
      company_id: 'co-1',
      inventory_item_id: 'item-1',
      from_location_type: 'yard',
      to_location_type: 'repair',
      movement_type: 'transfer',
      quantity: 3,
    })
    const { ctx, responses } = makeCtx(pool)
    await handleInventoryUtilizationRoutes(buildReq(), buildUrl(), ctx)
    const body = responses[0]?.body as UtilizationResponse
    // Total stock is still 10 — the unit didn't leave the company, just moved.
    expect(body.totals.total_quantity_owned).toBe(10)
    expect(body.totals.in_yard_count).toBe(7)
    expect(body.totals.out_for_service_count).toBe(3)
    // None of the 3 service units are double-counted as on rent.
    expect(body.totals.on_rent_count).toBe(0)
    expect(body.totals.utilization_pct).toBe(0)
  })

  it('isolates rollup by tenant — other companies do not leak in', async () => {
    const pool = new FakePool()
    // Tenant co-1: 100 in yard, 25 on rent → 25%.
    pool.items.push({
      id: 'item-1',
      company_id: 'co-1',
      code: 'SCAF-10',
      description: 'Scaffold 10ft',
      unit: 'ea',
      default_rental_rate: '5.00',
      active: true,
      deleted_at: null,
    })
    pool.movements.push({
      company_id: 'co-1',
      inventory_item_id: 'item-1',
      from_location_type: null,
      to_location_type: 'yard',
      movement_type: 'deliver',
      quantity: 100,
    })
    pool.rentalLines.push({
      company_id: 'co-1',
      inventory_item_id: 'item-1',
      quantity: 25,
      status: 'active',
      off_rent_date: null,
      deleted_at: null,
    })
    // Tenant co-2: huge fleet entirely on rent — must not contaminate co-1's view.
    pool.items.push({
      id: 'item-99',
      company_id: 'co-2',
      code: 'OTHER',
      description: 'Other co item',
      unit: 'ea',
      default_rental_rate: '1.00',
      active: true,
      deleted_at: null,
    })
    pool.movements.push({
      company_id: 'co-2',
      inventory_item_id: 'item-99',
      from_location_type: null,
      to_location_type: 'yard',
      movement_type: 'deliver',
      quantity: 5000,
    })
    pool.rentalLines.push({
      company_id: 'co-2',
      inventory_item_id: 'item-99',
      quantity: 5000,
      status: 'active',
      off_rent_date: null,
      deleted_at: null,
    })

    const { ctx, responses } = makeCtx(pool, { companyId: 'co-1' })
    await handleInventoryUtilizationRoutes(buildReq(), buildUrl(), ctx)
    const body = responses[0]?.body as UtilizationResponse
    expect(body.totals.total_items).toBe(1)
    expect(body.totals.total_quantity_owned).toBe(100)
    expect(body.totals.on_rent_count).toBe(25)
    expect(body.totals.utilization_pct).toBe(25)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.inventory_item_id).toBe('item-1')
  })

  it('returns false (skips) when method is not GET', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleInventoryUtilizationRoutes({ method: 'POST' } as http.IncomingMessage, buildUrl(), ctx)
    expect(handled).toBe(false)
    expect(responses).toHaveLength(0)
  })

  it('short-circuits when requireRole rejects the caller', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { role: 'member' })
    const handled = await handleInventoryUtilizationRoutes(buildReq(), buildUrl(), ctx)
    // handler returned true (the route matched) but sent nothing — requireRole
    // emits the 403 response itself.
    expect(handled).toBe(true)
    expect(responses).toHaveLength(0)
  })
})
