import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleRentalRequestRoutes } from './rental-requests.js'

// ---------------------------------------------------------------------------
// In-memory pg double — same shape as estimate-shares.test.ts. Just enough
// SQL pattern matching to exercise the rental-requests approve / decline /
// list flows. Not a general SQL emulator.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

interface RentalRequestSeed {
  id: string
  company_id: string
  share_link_id: string | null
  customer_id: string | null
  items: unknown
  requested_start: string | null
  requested_end: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  notes: string | null
  status: 'pending' | 'approved' | 'declined'
  approved_at: string | null
  approved_by: string | null
  approved_by_user_id: string | null
  rejected_at: string | null
  declined_at: string | null
  decline_reason: string | null
  converted_rental_id: string | null
  created_at: string
  updated_at: string
}

interface InventoryItemSeed {
  id: string
  company_id: string
  description: string
  default_rental_rate: string
}

interface CustomerSeed {
  id: string
  company_id: string
  name: string
  external_id: string | null
}

class FakePool {
  rentalRequests: RentalRequestSeed[] = []
  rentals: Row[] = []
  inventoryItems: InventoryItemSeed[] = []
  customers: CustomerSeed[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []

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
    if (sql.startsWith('begin') || sql.startsWith('commit') || sql.startsWith('rollback')) {
      return { rows: [], rowCount: 0 }
    }

    // ---- rental_requests ----
    if (/select[\s\S]+from rental_requests rr/i.test(sql)) {
      // List query with optional status + limit. The route module embeds
      // the limit param last; the status param (if present) is second.
      const [companyId] = params as [string, ...unknown[]]
      let rows = this.rentalRequests.filter((r) => r.company_id === companyId)
      // Heuristic: when there are 3+ params, status is index 1 (the
      // limit is last). When there are 2, only company_id + limit, so no
      // status filter.
      if (params.length >= 3) {
        const status = params[1] as string
        rows = rows.filter((r) => r.status === status)
      }
      rows = rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      const limit = Number(params[params.length - 1])
      rows = rows.slice(0, limit)
      return {
        rows: rows.map((r) => ({
          ...r,
          customer_name: this.customers.find((c) => c.id === r.customer_id)?.name ?? null,
          customer_external_id: this.customers.find((c) => c.id === r.customer_id)?.external_id ?? null,
        })),
        rowCount: rows.length,
      }
    }
    if (/select[\s\S]+from rental_requests/i.test(sql) && /for update/i.test(sql)) {
      const [id, companyId] = params as [string, string]
      const row = this.rentalRequests.find((r) => r.id === id && r.company_id === companyId) ?? null
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    if (/^update rental_requests/i.test(sql) && /status = 'approved'/i.test(sql)) {
      const [id, companyId, userId, rentalId] = params as [string, string, string, string]
      const row = this.rentalRequests.find((r) => r.id === id && r.company_id === companyId)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'approved'
      row.approved_at = new Date().toISOString()
      row.approved_by = userId
      row.approved_by_user_id = userId
      row.converted_rental_id = rentalId
      row.updated_at = row.approved_at
      return { rows: [{ ...row }], rowCount: 1 }
    }
    if (/^update rental_requests/i.test(sql) && /status = 'declined'/i.test(sql)) {
      const [id, companyId, reason] = params as [string, string, string | null]
      const row = this.rentalRequests.find((r) => r.id === id && r.company_id === companyId)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'declined'
      row.declined_at = new Date().toISOString()
      row.decline_reason = reason
      row.updated_at = row.declined_at
      return { rows: [{ ...row }], rowCount: 1 }
    }

    // ---- inventory_items lookup for approve ----
    if (/from inventory_items[\s\S]+id = any/i.test(sql)) {
      const [companyId, ids] = params as [string, string[]]
      const rows = this.inventoryItems.filter((i) => i.company_id === companyId && ids.includes(i.id))
      return { rows, rowCount: rows.length }
    }

    // ---- rentals insert (mirrors apps/api/src/routes/rentals.ts shape) ----
    if (/^insert into rentals/i.test(sql)) {
      const [companyId, _projectId, customerId, description, dailyRate, deliveredOn] = params as [
        string,
        string | null,
        string | null,
        string,
        number,
        string,
      ]
      const id = `rental-${this.rentals.length + 1}`
      const now = new Date().toISOString()
      const row = {
        id,
        company_id: companyId,
        project_id: null,
        customer_id: customerId,
        item_description: description,
        daily_rate: dailyRate,
        delivered_on: deliveredOn,
        returned_on: null,
        invoice_cadence_days: 7,
        next_invoice_at: deliveredOn,
        status: 'active',
        notes: null,
        version: 1,
        created_at: now,
        updated_at: now,
      }
      this.rentals.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // ---- ledger inserts (sync_events + mutation_outbox) ----
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(pool: FakePool, overrides: Partial<Parameters<typeof handleRentalRequestRoutes>[2]> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  return {
    responses,
    reads,
    ctx: {
      pool: pool as unknown as Parameters<typeof handleRentalRequestRoutes>[2]['pool'],
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' as const },
      currentUserId: 'user-1',
      requireRole: () => true,
      readBody: async () => {
        const body = reads.shift() ?? {}
        return body as Record<string, unknown>
      },
      sendJson: (status: number, body: unknown) => {
        responses.push({ status, body })
      },
      ...overrides,
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function seedRequest(pool: FakePool, overrides: Partial<RentalRequestSeed> = {}): RentalRequestSeed {
  const now = new Date().toISOString()
  const row: RentalRequestSeed = {
    id: `req-${pool.rentalRequests.length + 1}`,
    company_id: 'co-1',
    share_link_id: 'link-1',
    customer_id: 'cust-1',
    items: [{ inventory_item_id: 'inv-1', qty: 1, start: '2026-06-01', end: null, delivery: 'pickup' }],
    requested_start: '2026-06-01',
    requested_end: null,
    contact_name: 'Sam Foreman',
    contact_email: 'sam@example.com',
    contact_phone: null,
    notes: null,
    status: 'pending',
    approved_at: null,
    approved_by: null,
    approved_by_user_id: null,
    rejected_at: null,
    declined_at: null,
    decline_reason: null,
    converted_rental_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
  pool.rentalRequests.push(row)
  return row
}

function seedCatalogItem(pool: FakePool, overrides: Partial<InventoryItemSeed> = {}): InventoryItemSeed {
  const row: InventoryItemSeed = {
    id: 'inv-1',
    company_id: 'co-1',
    description: 'Scaffold tower',
    default_rental_rate: '40.00',
    ...overrides,
  }
  pool.inventoryItems.push(row)
  return row
}

describe('handleRentalRequestRoutes — GET /api/rental-requests', () => {
  it('lists pending requests for admin/office and joins customer name', async () => {
    const pool = new FakePool()
    pool.customers.push({ id: 'cust-1', company_id: 'co-1', name: 'Acme Builders', external_id: null })
    seedRequest(pool)
    seedRequest(pool, { id: 'req-2', status: 'approved' })
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleRentalRequestRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/rental-requests?status=pending'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { rentalRequests: Array<{ id: string; customer_name: string | null }> }
    expect(body.rentalRequests).toHaveLength(1)
    expect(body.rentalRequests[0]?.id).toBe('req-1')
    expect(body.rentalRequests[0]?.customer_name).toBe('Acme Builders')
  })

  it('rejects unsupported status filters with 400', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleRentalRequestRoutes({ method: 'GET' } as never, buildUrl('/api/rental-requests?status=bogus'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 403 when requireRole rejects (non-admin/office caller)', async () => {
    const pool = new FakePool()
    seedRequest(pool)
    const denied = makeCtx(pool, {
      requireRole: (_allowed) => {
        // Mirror the production helper: it sends the 403 itself and
        // returns false. Tests assert that no further response was queued.
        return false
      },
    })
    await handleRentalRequestRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/rental-requests?status=pending'),
      denied.ctx,
    )
    expect(denied.responses).toHaveLength(0)
  })
})

describe('handleRentalRequestRoutes — POST /:id/approve', () => {
  it('creates a rentals row, marks the request approved, stamps approved_at + approved_by_user_id', async () => {
    const pool = new FakePool()
    seedCatalogItem(pool)
    const seeded = seedRequest(pool)
    const { ctx, responses } = makeCtx(pool)
    await handleRentalRequestRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-requests/${seeded.id}/approve`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect(pool.rentals).toHaveLength(1)
    const updated = pool.rentalRequests[0]!
    expect(updated.status).toBe('approved')
    expect(updated.approved_at).not.toBeNull()
    expect(updated.approved_by_user_id).toBe('user-1')
    expect(updated.converted_rental_id).toBe(pool.rentals[0]!.id)
    const body = responses[0]?.body as { rental_id: string; rentals: unknown[] }
    expect(body.rental_id).toBe(pool.rentals[0]!.id)
    expect(body.rentals).toHaveLength(1)
  })

  it('is idempotent — re-approving returns the existing rental id without duplicating', async () => {
    const pool = new FakePool()
    seedCatalogItem(pool)
    const seeded = seedRequest(pool)
    const first = makeCtx(pool)
    await handleRentalRequestRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-requests/${seeded.id}/approve`),
      first.ctx,
    )
    expect(pool.rentals).toHaveLength(1)
    const firstRentalId = pool.rentals[0]!.id

    const second = makeCtx(pool)
    await handleRentalRequestRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-requests/${seeded.id}/approve`),
      second.ctx,
    )
    expect(second.responses[0]?.status).toBe(200)
    const body = second.responses[0]?.body as { idempotent: boolean; rental_id: string }
    expect(body.idempotent).toBe(true)
    expect(body.rental_id).toBe(firstRentalId)
    // No second rental row.
    expect(pool.rentals).toHaveLength(1)
  })

  it('returns 404 when the request does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleRentalRequestRoutes({ method: 'POST' } as never, buildUrl('/api/rental-requests/missing/approve'), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('returns 409 when trying to approve a previously declined request', async () => {
    const pool = new FakePool()
    seedRequest(pool, { status: 'declined', declined_at: new Date().toISOString(), decline_reason: 'no stock' })
    const { ctx, responses } = makeCtx(pool)
    await handleRentalRequestRoutes({ method: 'POST' } as never, buildUrl(`/api/rental-requests/req-1/approve`), ctx)
    expect(responses[0]?.status).toBe(409)
  })
})

describe('handleRentalRequestRoutes — POST /:id/decline', () => {
  it('marks the request declined with stamped declined_at + reason', async () => {
    const pool = new FakePool()
    const seeded = seedRequest(pool)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ decline_reason: 'inventory unavailable' })
    await handleRentalRequestRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-requests/${seeded.id}/decline`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    const updated = pool.rentalRequests[0]!
    expect(updated.status).toBe('declined')
    expect(updated.declined_at).not.toBeNull()
    expect(updated.decline_reason).toBe('inventory unavailable')
  })

  it('is idempotent — re-declining returns the existing reason', async () => {
    const pool = new FakePool()
    const seeded = seedRequest(pool)
    const first = makeCtx(pool)
    first.reads.push({ decline_reason: 'first reason' })
    await handleRentalRequestRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-requests/${seeded.id}/decline`),
      first.ctx,
    )
    const firstDeclinedAt = pool.rentalRequests[0]!.declined_at

    const second = makeCtx(pool)
    second.reads.push({ decline_reason: 'second reason — should not overwrite' })
    await handleRentalRequestRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-requests/${seeded.id}/decline`),
      second.ctx,
    )
    expect(second.responses[0]?.status).toBe(200)
    const body = second.responses[0]?.body as { idempotent: boolean }
    expect(body.idempotent).toBe(true)
    expect(pool.rentalRequests[0]?.declined_at).toBe(firstDeclinedAt)
    expect(pool.rentalRequests[0]?.decline_reason).toBe('first reason')
  })

  it('returns 409 when the request was already approved', async () => {
    const pool = new FakePool()
    seedRequest(pool, { status: 'approved', approved_at: new Date().toISOString(), converted_rental_id: 'rental-99' })
    const { ctx, responses } = makeCtx(pool)
    await handleRentalRequestRoutes({ method: 'POST' } as never, buildUrl('/api/rental-requests/req-1/decline'), ctx)
    expect(responses[0]?.status).toBe(409)
  })
})
