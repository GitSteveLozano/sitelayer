import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleRentalRoutes, type RentalRouteCtx } from './rentals.js'
import type { RentalRow } from '@sitelayer/queue'

// ---------------------------------------------------------------------------
// Rental CRUD + workflow-transition route tests.
//
// FakePool double answering the rentals SQL (list / create / versioned
// patch+delete / RETURN workflow transition). We assert the role gate
// (admin/office only), the date + numeric validation, the project/customer
// FK 404s, the PATCH guards that hand status/returned_on ownership to the
// rental workflow (409), the optimistic version conflict, and the RETURN
// transition that flips active → returned through the pure reducer with a
// workflow_event_log row.
// ---------------------------------------------------------------------------

const COMPANY_ID = 'co-1'
const RENTAL_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333'

type StoredRental = RentalRow & {
  state_version: number
  returned_at: string | null
  returned_by: string | null
  closed_at: string | null
  closed_by: string | null
}

class FakePool {
  rentals: StoredRental[] = []
  projects = new Set<string>()
  customers = new Set<string>()
  workflowEvents: Array<{ event_type: string; state_version: number; entity_id: string; workflow_name: string }> = []
  syncEvents: unknown[][] = []
  outbox: unknown[][] = []
  auditEvents: unknown[][] = []
  private idCounter = 0

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

    // FK existence checks for create.
    if (/^select 1 from projects/i.test(sql)) {
      const [, id] = params as [string, string]
      return this.projects.has(id) ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/^select 1 from customers/i.test(sql)) {
      const [, id] = params as [string, string]
      return this.customers.has(id) ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    // checkVersion lookup (used by patchVersionedEntity/deleteVersionedEntity
    // to disambiguate 404 vs 409). Returns the row version.
    if (/^select version from rentals/i.test(sql)) {
      const [, id] = params as [string, string]
      const row = this.rentals.find((r) => r.id === id && !r.deleted_at)
      return row ? { rows: [{ version: row.version }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    // Workflow locked-row read (for update).
    if (/from rentals[\s\S]+for update/i.test(sql)) {
      const [, id] = params as [string, string]
      const row = this.rentals.find((r) => r.id === id && !r.deleted_at)
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (/^insert into rentals/i.test(sql)) {
      this.idCounter += 1
      const row: StoredRental = {
        id: `rental-${this.idCounter}`,
        company_id: params[0] as string,
        project_id: (params[1] ?? null) as string | null,
        customer_id: (params[2] ?? null) as string | null,
        item_description: params[3] as string,
        daily_rate: String(params[4]),
        delivered_on: params[5] as string,
        returned_on: (params[6] ?? null) as string | null,
        invoice_cadence_days: Number(params[7]),
        next_invoice_at: (params[8] ?? null) as string | null,
        last_invoice_amount: null,
        last_invoiced_through: null,
        status: 'active',
        notes: (params[9] ?? null) as string | null,
        version: 1,
        deleted_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        state_version: 1,
        returned_at: null,
        returned_by: null,
        closed_at: null,
        closed_by: null,
      }
      this.rentals.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // Workflow transition UPDATE (sets status + state_version + returned_*).
    if (/^update rentals\s+set\s+status\s*=\s*\$3/i.test(sql)) {
      const [, id, status, stateVersion, returnedAt, returnedBy, closedAt, closedBy] = params as [
        string,
        string,
        string,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
      ]
      const row = this.rentals.find((r) => r.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.returned_at = returnedAt
      row.returned_by = returnedBy
      row.closed_at = closedAt
      row.closed_by = closedBy
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    // Return-reconciliation UPDATE (qty_good etc.).
    if (/^update rentals set\s+qty_good/i.test(sql)) {
      const id = params[5] as string
      const row = this.rentals.find((r) => r.id === id)
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    // Soft-delete UPDATE.
    if (/^\s*update rentals\s+set\s+deleted_at/i.test(sql)) {
      const [, id, expectedVersion] = params as [string, string, number | null]
      const row = this.rentals.find((r) => r.id === id && !r.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      if (expectedVersion !== null && row.version !== expectedVersion) return { rows: [], rowCount: 0 }
      row.deleted_at = new Date().toISOString()
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    // Field-update UPDATE (patch).
    if (/^\s*update rentals\s+set[\s\S]+item_description\s*=\s*coalesce/i.test(sql)) {
      const id = params[1] as string
      const expectedVersion = params[10] as number | null
      const row = this.rentals.find((r) => r.id === id && !r.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      if (expectedVersion !== null && row.version !== expectedVersion) return { rows: [], rowCount: 0 }
      if (params[2] !== null) row.item_description = params[2] as string
      if (params[3] !== null) row.daily_rate = String(params[3])
      if (params[7] !== null) row.notes = params[7] as string
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    // GET list.
    if (/^\s*select[\s\S]+from\s+rentals/i.test(sql)) {
      let rows = this.rentals.filter((r) => r.company_id === COMPANY_ID && !r.deleted_at)
      if (/status = 'active'/i.test(sql)) rows = rows.filter((r) => r.status === 'active')
      else if (/status in \('returned', 'invoiced_pending'\)/i.test(sql))
        rows = rows.filter((r) => r.status === 'returned' || r.status === 'invoiced_pending')
      else if (/status = 'closed'/i.test(sql)) rows = rows.filter((r) => r.status === 'closed')
      return { rows, rowCount: rows.length }
    }

    if (/^\s*insert into workflow_event_log/i.test(sql)) {
      this.workflowEvents.push({
        workflow_name: params[1] as string,
        entity_id: params[4] as string,
        state_version: params[5] as number,
        event_type: params[6] as string,
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push(params)
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push(params)
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push(params)
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'office' | 'member' = 'admin',
): { ctx: RentalRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role },
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
      // checkVersion mirrors the server: returns true when the row matches
      // (or no expected_version supplied); on a stale version it sends 409
      // and returns false. Used by patch/deleteVersionedEntity.
      checkVersion: async (_table, _where, paramsIn, expectedVersion) => {
        const id = paramsIn[1] as string
        const row = pool.rentals.find((r) => r.id === id && !r.deleted_at)
        if (!row) return true // real 404
        if (expectedVersion !== null && row.version !== expectedVersion) {
          responses.push({ status: 409, body: { error: 'version conflict', current_version: row.version } })
          return false
        }
        return true
      },
    },
  }
}

function seedRental(pool: FakePool, overrides: Partial<StoredRental> = {}): StoredRental {
  const row: StoredRental = {
    id: RENTAL_ID,
    company_id: COMPANY_ID,
    project_id: PROJECT_ID,
    customer_id: CUSTOMER_ID,
    item_description: 'Scaffold tower',
    daily_rate: '25.00',
    delivered_on: '2026-05-01',
    returned_on: null,
    next_invoice_at: '2026-05-08T00:00:00.000Z',
    invoice_cadence_days: 7,
    last_invoice_amount: null,
    last_invoiced_through: null,
    status: 'active',
    notes: null,
    version: 1,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    state_version: 1,
    returned_at: null,
    returned_by: null,
    closed_at: null,
    closed_by: null,
    ...overrides,
  }
  pool.rentals.push(row)
  return row
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleRentalRoutes — GET /api/rentals', () => {
  it('lists active rentals by default', async () => {
    const pool = new FakePool()
    seedRental(pool, { id: 'r-active', status: 'active' })
    seedRental(pool, { id: 'r-closed', status: 'closed' })
    const { ctx, responses } = makeCtx(pool)
    await handleRentalRoutes({ method: 'GET' } as never, buildUrl('/api/rentals'), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { rentals: RentalRow[] }
    expect(body.rentals).toHaveLength(1)
    expect(body.rentals[0]?.id).toBe('r-active')
  })

  it('filters returned rentals (returned + invoiced_pending)', async () => {
    const pool = new FakePool()
    seedRental(pool, { id: 'r-ret', status: 'returned' })
    seedRental(pool, { id: 'r-inv', status: 'invoiced_pending' })
    seedRental(pool, { id: 'r-active', status: 'active' })
    const { ctx, responses } = makeCtx(pool)
    await handleRentalRoutes({ method: 'GET' } as never, buildUrl('/api/rentals?status=returned'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { rentals: RentalRow[] }).rentals).toHaveLength(2)
  })

  it('returns 400 for an unknown status filter', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleRentalRoutes({ method: 'GET' } as never, buildUrl('/api/rentals?status=bogus'), ctx)
    expect(responses[0]?.status).toBe(400)
  })
})

describe('handleRentalRoutes — POST /api/rentals', () => {
  it('rejects member callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { item_description: 'X', delivered_on: '2026-05-01' }, 'member')
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl('/api/rentals'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('returns 400 when item_description is missing', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { delivered_on: '2026-05-01' })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl('/api/rentals'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('item_description')
  })

  it('returns 400 when delivered_on is not a valid date', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { item_description: 'Tower', delivered_on: '05-01-2026' })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl('/api/rentals'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('delivered_on')
  })

  it('returns 400 for a negative daily_rate', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      item_description: 'Tower',
      delivered_on: '2026-05-01',
      daily_rate: -5,
    })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl('/api/rentals'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('daily_rate')
  })

  it('returns 404 when project_id is not in the company', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      item_description: 'Tower',
      delivered_on: '2026-05-01',
      daily_rate: 25,
      project_id: PROJECT_ID,
    })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl('/api/rentals'), ctx)
    expect(responses[0]?.status).toBe(404)
    expect((responses[0]?.body as { error: string }).error).toContain('project_id not found')
  })

  it('returns 404 when customer_id is not in the company', async () => {
    const pool = new FakePool()
    pool.projects.add(PROJECT_ID)
    const { ctx, responses } = makeCtx(pool, {
      item_description: 'Tower',
      delivered_on: '2026-05-01',
      daily_rate: 25,
      project_id: PROJECT_ID,
      customer_id: CUSTOMER_ID,
    })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl('/api/rentals'), ctx)
    expect(responses[0]?.status).toBe(404)
    expect((responses[0]?.body as { error: string }).error).toContain('customer_id not found')
  })

  it('creates the rental, defaults status=active, and records the ledger', async () => {
    const pool = new FakePool()
    pool.projects.add(PROJECT_ID)
    pool.customers.add(CUSTOMER_ID)
    const { ctx, responses } = makeCtx(pool, {
      item_description: 'Scaffold tower',
      delivered_on: '2026-05-01',
      daily_rate: 25,
      invoice_cadence_days: 14,
      project_id: PROJECT_ID,
      customer_id: CUSTOMER_ID,
      notes: 'leave at gate',
    })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl('/api/rentals'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.rentals).toHaveLength(1)
    expect(pool.rentals[0]?.status).toBe('active')
    expect(pool.rentals[0]?.invoice_cadence_days).toBe(14)
    expect(pool.syncEvents).toHaveLength(1)
    expect(pool.auditEvents).toHaveLength(1)
  })
})

describe('handleRentalRoutes — PATCH /api/rentals/:id', () => {
  it('rejects a direct status write with 409 (workflow owns status)', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, { status: 'closed' })
    await handleRentalRoutes({ method: 'PATCH' } as never, buildUrl(`/api/rentals/${RENTAL_ID}`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect((responses[0]?.body as { error: string }).error).toContain('owned by the rental workflow')
  })

  it('rejects a returned_on date write with 409 (use /return)', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, { returned_on: '2026-05-10' })
    await handleRentalRoutes({ method: 'PATCH' } as never, buildUrl(`/api/rentals/${RENTAL_ID}`), ctx)
    expect(responses[0]?.status).toBe(409)
  })

  it('updates editable fields and bumps version', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, { item_description: 'Bigger tower', daily_rate: 40 })
    await handleRentalRoutes({ method: 'PATCH' } as never, buildUrl(`/api/rentals/${RENTAL_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.rentals[0]?.item_description).toBe('Bigger tower')
    expect(pool.rentals[0]?.daily_rate).toBe('40')
    expect(pool.rentals[0]?.version).toBe(2)
  })

  it('returns 409 on a stale expected_version', async () => {
    const pool = new FakePool()
    seedRental(pool, { version: 5 })
    const { ctx, responses } = makeCtx(pool, { item_description: 'X', expected_version: 1 })
    await handleRentalRoutes({ method: 'PATCH' } as never, buildUrl(`/api/rentals/${RENTAL_ID}`), ctx)
    expect(responses[0]?.status).toBe(409)
    // Unchanged.
    expect(pool.rentals[0]?.version).toBe(5)
  })

  it('returns 404 when the rental does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { item_description: 'X' })
    await handleRentalRoutes({ method: 'PATCH' } as never, buildUrl(`/api/rentals/${RENTAL_ID}`), ctx)
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleRentalRoutes — DELETE /api/rentals/:id', () => {
  it('soft-deletes the rental', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, {})
    await handleRentalRoutes({ method: 'DELETE' } as never, buildUrl(`/api/rentals/${RENTAL_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.rentals[0]?.deleted_at).not.toBeNull()
  })

  it('returns 404 when the rental does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {})
    await handleRentalRoutes({ method: 'DELETE' } as never, buildUrl(`/api/rentals/${RENTAL_ID}`), ctx)
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleRentalRoutes — POST /api/rentals/:id/return', () => {
  it('rejects member callers with 403', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, { qty_good: 1 }, 'member')
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl(`/api/rentals/${RENTAL_ID}/return`), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('returns 400 when qty fields are negative', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, { qty_good: -1 })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl(`/api/rentals/${RENTAL_ID}/return`), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 400 when the qty breakdown does not sum to original_qty', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, { qty_good: 1, qty_damaged: 1, qty_lost: 1, original_qty: 10 })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl(`/api/rentals/${RENTAL_ID}/return`), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('original_qty')
  })

  it('returns 404 when the rental does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { qty_good: 1 })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl(`/api/rentals/${RENTAL_ID}/return`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('flips active → returned through the reducer and writes a workflow_event_log row', async () => {
    const pool = new FakePool()
    seedRental(pool, { status: 'active', state_version: 1 })
    const { ctx, responses } = makeCtx(pool, { qty_good: 3, qty_damaged: 0, qty_lost: 0, original_qty: 3 })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl(`/api/rentals/${RENTAL_ID}/return`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.rentals[0]?.status).toBe('returned')
    expect(pool.rentals[0]?.state_version).toBe(2)
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]?.event_type).toBe('RETURN')
    expect(pool.workflowEvents[0]?.state_version).toBe(1)
    expect(pool.workflowEvents[0]?.workflow_name).toBe('rental')
  })

  it('returns 409 on an illegal transition (RETURN from a closed rental)', async () => {
    const pool = new FakePool()
    seedRental(pool, { status: 'closed', state_version: 3 })
    const { ctx, responses } = makeCtx(pool, { qty_good: 1, qty_damaged: 0, qty_lost: 0, original_qty: 1 })
    await handleRentalRoutes({ method: 'POST' } as never, buildUrl(`/api/rentals/${RENTAL_ID}/return`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect(pool.workflowEvents).toHaveLength(0)
  })
})
