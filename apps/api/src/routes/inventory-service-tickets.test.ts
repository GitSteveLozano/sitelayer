import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleInventoryServiceTicketRoutes, type InventoryServiceTicketRouteCtx } from './inventory-service-tickets.js'

// ---------------------------------------------------------------------------
// Inventory service tickets (migration 103 / cost_cents added in 019). This is
// the cost_cents write path — tonight's service-log fix lands real money into
// SPENT·YTD via the cost_cents column, so the create/list/role-gate/scoping
// behaviour gets documented here against the live handler. Mirrors the
// fake-pool route-test idiom in schedules-create.test.ts.
//
// Load-bearing assertions:
//   1. POST persists service_type + cost_cents (the money column) and returns
//      the created ticket at 201.
//   2. GET lists the company's tickets back, including cost_cents.
//   3. Role gate: foreman MAY create (recent field-flagging widening), member
//      may NOT; PATCH (advance status) is admin/office only.
//   4. Company-scoping: a ticket opened under company A is invisible to a GET
//      issued as company B (the fake pool enforces the company_id = $1 WHERE).
// ---------------------------------------------------------------------------

type Role = 'admin' | 'foreman' | 'office' | 'member'

type TicketRow = {
  id: string
  company_id: string
  inventory_item_id: string
  status: 'open' | 'in_service' | 'done'
  opened_at: string
  opened_by: string | null
  completed_at: string | null
  notes: string | null
  service_type: string | null
  cost_cents: number | null
  tier_origin: string | null
  created_at: string
  updated_at: string
}

const ITEM_A = '11111111-1111-4111-8111-111111111111'
const ITEM_MISSING = '99999999-9999-4999-8999-999999999999'

let ticketSeq = 0

class FakePool {
  tickets: TicketRow[] = []
  // inventory_items rows the create path probes for existence, keyed by company.
  items: Array<{ company_id: string; id: string }> = []
  auditEvents = 0

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

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // existence probe in the create path: select id from inventory_items ...
    if (/^select id from inventory_items/i.test(sql)) {
      const [companyId, itemId] = params as [string, string]
      const found = this.items.find((i) => i.company_id === companyId && i.id === itemId)
      return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 }
    }

    // list / status-advance SELECT both project from inventory_service_tickets.
    if (/from inventory_service_tickets/i.test(sql)) {
      const companyId = params[0] as string
      // PATCH "... for update" path keys on id = $2.
      if (/for update/i.test(sql)) {
        const id = params[1] as string
        const row = this.tickets.find((t) => t.company_id === companyId && t.id === id)
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      // GET list: company_id always $1; optional item_id / status filters.
      let rows = this.tickets.filter((t) => t.company_id === companyId)
      if (/inventory_item_id = \$/i.test(sql)) {
        const itemId = params[1] as string
        rows = rows.filter((t) => t.inventory_item_id === itemId)
      }
      if (/status = \$/i.test(sql)) {
        const statusVal = params[params.length - 1] as string
        rows = rows.filter((t) => t.status === statusVal)
      }
      return { rows, rowCount: rows.length }
    }

    if (/^insert into inventory_service_tickets/i.test(sql)) {
      const [companyId, inventoryItemId, openedBy, notes, serviceType, costCents] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        number | null,
      ]
      ticketSeq += 1
      // Mint a valid uuid so the PATCH :id route (isValidUuid gate) accepts it.
      const row: TicketRow = {
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(ticketSeq).padStart(12, '0')}`,
        company_id: companyId,
        inventory_item_id: inventoryItemId,
        status: 'open',
        opened_at: '2026-06-13T00:00:00.000Z',
        opened_by: openedBy,
        completed_at: null,
        notes,
        service_type: serviceType,
        cost_cents: costCents,
        tier_origin: 'test',
        created_at: '2026-06-13T00:00:00.000Z',
        updated_at: '2026-06-13T00:00:00.000Z',
      }
      this.tickets.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (/^update inventory_service_tickets/i.test(sql)) {
      const [companyId, id, status, completedAt] = params as [string, string, TicketRow['status'], string | null]
      const row = this.tickets.find((t) => t.company_id === companyId && t.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.completed_at = completedAt
      row.updated_at = new Date().toISOString()
      return { rows: [row], rowCount: 1 }
    }

    if (/^insert into audit_events/i.test(sql)) {
      this.auditEvents += 1
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: Role = 'admin',
  companyId = 'co-a',
): { ctx: InventoryServiceTicketRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: companyId, slug: 'co', name: 'Co', created_at: '', role },
      currentUserId: 'u-1',
      requireRole: (allowed) => {
        if ((allowed as readonly string[]).includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleInventoryServiceTicketRoutes — POST /api/inventory/service-tickets', () => {
  it('persists service_type + cost_cents (the money write path) and returns 201', async () => {
    const pool = new FakePool()
    pool.items.push({ company_id: 'co-a', id: ITEM_A })
    const { ctx, responses } = makeCtx(pool, {
      inventory_item_id: ITEM_A,
      notes: '  scissor lift hydraulics  ',
      service_type: 'hydraulic-repair',
      cost_cents: 48500,
    })
    await handleInventoryServiceTicketRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/inventory/service-tickets'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const created = (responses[0]?.body as { service_ticket: TicketRow }).service_ticket
    expect(created.service_type).toBe('hydraulic-repair')
    expect(created.cost_cents).toBe(48500)
    expect(created.status).toBe('open')
    // notes are trimmed before insert.
    expect(pool.tickets[0]?.notes).toBe('scissor lift hydraulics')
    expect(pool.auditEvents).toBe(1)
  })

  it('allows a foreman to open a ticket (recent field-flagging widening)', async () => {
    const pool = new FakePool()
    pool.items.push({ company_id: 'co-a', id: ITEM_A })
    const { ctx, responses } = makeCtx(pool, { inventory_item_id: ITEM_A }, 'foreman')
    await handleInventoryServiceTicketRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/inventory/service-tickets'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.tickets).toHaveLength(1)
  })

  it('rejects a member with 403 and writes no ticket', async () => {
    const pool = new FakePool()
    pool.items.push({ company_id: 'co-a', id: ITEM_A })
    const { ctx, responses } = makeCtx(pool, { inventory_item_id: ITEM_A }, 'member')
    await handleInventoryServiceTicketRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/inventory/service-tickets'),
      ctx,
    )
    expect(responses[0]?.status).toBe(403)
    expect(pool.tickets).toHaveLength(0)
  })

  it('404s when the inventory item is unknown for the company', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { inventory_item_id: ITEM_MISSING })
    await handleInventoryServiceTicketRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/inventory/service-tickets'),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
    expect(pool.tickets).toHaveLength(0)
  })
})

describe('handleInventoryServiceTicketRoutes — GET /api/inventory/service-tickets', () => {
  it('lists the company tickets back, including cost_cents', async () => {
    const pool = new FakePool()
    pool.items.push({ company_id: 'co-a', id: ITEM_A })
    const create = makeCtx(pool, {
      inventory_item_id: ITEM_A,
      service_type: 'inspection',
      cost_cents: 12500,
    })
    await handleInventoryServiceTicketRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/inventory/service-tickets'),
      create.ctx,
    )

    const list = makeCtx(pool)
    await handleInventoryServiceTicketRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/inventory/service-tickets'),
      list.ctx,
    )
    expect(list.responses[0]?.status).toBe(200)
    const tickets = (list.responses[0]?.body as { service_tickets: TicketRow[] }).service_tickets
    expect(tickets).toHaveLength(1)
    expect(tickets[0]?.cost_cents).toBe(12500)
    expect(tickets[0]?.service_type).toBe('inspection')
  })

  it('company-scoping: a ticket opened by company A is invisible to company B', async () => {
    const pool = new FakePool()
    pool.items.push({ company_id: 'co-a', id: ITEM_A })
    const create = makeCtx(pool, { inventory_item_id: ITEM_A, cost_cents: 5000 }, 'admin', 'co-a')
    await handleInventoryServiceTicketRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/inventory/service-tickets'),
      create.ctx,
    )
    expect(create.responses[0]?.status).toBe(201)

    const otherCompany = makeCtx(pool, {}, 'admin', 'co-b')
    await handleInventoryServiceTicketRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/inventory/service-tickets'),
      otherCompany.ctx,
    )
    expect(otherCompany.responses[0]?.status).toBe(200)
    const tickets = (otherCompany.responses[0]?.body as { service_tickets: TicketRow[] }).service_tickets
    expect(tickets).toHaveLength(0)
  })
})

describe('handleInventoryServiceTicketRoutes — PATCH /api/inventory/service-tickets/:id', () => {
  it('admin advances open → in_service (admin/office only gate)', async () => {
    const pool = new FakePool()
    pool.items.push({ company_id: 'co-a', id: ITEM_A })
    const create = makeCtx(pool, { inventory_item_id: ITEM_A })
    await handleInventoryServiceTicketRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/inventory/service-tickets'),
      create.ctx,
    )
    const id = (create.responses[0]?.body as { service_ticket: TicketRow }).service_ticket.id

    const patch = makeCtx(pool, { status: 'in_service' }, 'office')
    await handleInventoryServiceTicketRoutes(
      { method: 'PATCH' } as never,
      buildUrl(`/api/inventory/service-tickets/${id}`),
      patch.ctx,
    )
    expect(patch.responses[0]?.status, JSON.stringify(patch.responses[0]?.body)).toBe(200)
    expect(pool.tickets[0]?.status).toBe('in_service')
  })

  it('rejects a foreman PATCH with 403 (advance stays admin/office)', async () => {
    const pool = new FakePool()
    pool.items.push({ company_id: 'co-a', id: ITEM_A })
    const create = makeCtx(pool, { inventory_item_id: ITEM_A })
    await handleInventoryServiceTicketRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/inventory/service-tickets'),
      create.ctx,
    )
    const id = (create.responses[0]?.body as { service_ticket: TicketRow }).service_ticket.id

    const patch = makeCtx(pool, { status: 'in_service' }, 'foreman')
    await handleInventoryServiceTicketRoutes(
      { method: 'PATCH' } as never,
      buildUrl(`/api/inventory/service-tickets/${id}`),
      patch.ctx,
    )
    expect(patch.responses[0]?.status).toBe(403)
    expect(pool.tickets[0]?.status).toBe('open')
  })
})
