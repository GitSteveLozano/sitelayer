import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleRentalEventRoutes } from './rental-events.js'
import type { RentalEventRouteCtx } from './rental-events.js'

// ---------------------------------------------------------------------------
// Rental workflow event surface — GET snapshot, POST events. Mirrors the
// rental-billing-state test corpus: assert the version-conflict guard, the
// workflow_event_log row, the audit_events row, and the
// illegal-transition 409 path. Tests run against a FakePool that mimics the
// minimum subset of SQL the route exercises.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

interface RentalEventRow {
  id: string
  company_id: string
  project_id: string | null
  customer_id: string | null
  item_description: string
  daily_rate: string
  delivered_on: string
  returned_on: string | null
  next_invoice_at: string | null
  invoice_cadence_days: number
  last_invoice_amount: string | null
  last_invoiced_through: string | null
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
  state_version: number
  returned_at: string | null
  returned_by: string | null
  closed_at: string | null
  closed_by: string | null
}

class FakePool {
  rentals: RentalEventRow[] = []
  workflowEvents: Array<{
    event_type: string
    state_version: number
    entity_id: string
    workflow_name: string
  }> = []
  syncEvents: Row[] = []
  outbox: Array<{
    mutation_type: string
    idempotency_key: string
    entity_type: string
    entity_id: string
  }> = []
  auditEvents: Array<{ entity_type: string; action: string; entity_id: string }> = []

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

    if (/from rentals/i.test(sql) && /where/i.test(sql) && !/^update/i.test(sql)) {
      // select / for update / by id
      const [companyId, rentalId] = params as [string, string]
      const row = this.rentals.find((r) => r.company_id === companyId && r.id === rentalId && !r.deleted_at)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (/^update rentals/i.test(sql)) {
      const [companyId, rentalId, status, stateVersion, returnedAt, returnedBy, closedAt, closedBy] = params as [
        string,
        string,
        string,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
      ]
      const row = this.rentals.find((r) => r.company_id === companyId && r.id === rentalId)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.returned_at = returnedAt
      row.returned_by = returnedBy
      row.closed_at = closedAt
      row.closed_by = closedBy
      if (status === 'returned' && !row.returned_on) {
        row.returned_on = new Date().toISOString().slice(0, 10)
      }
      row.version += 1
      row.updated_at = new Date().toISOString()
      return { rows: [row], rowCount: 1 }
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
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({
        entity_type: params[3] as string,
        entity_id: params[4] as string,
        mutation_type: params[5] as string,
        idempotency_key: params[7] as string,
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({
        entity_type: params[3] as string,
        entity_id: params[4] as string,
        action: params[5] as string,
      })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

const RENTAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function seedRental(pool: FakePool, overrides: Partial<RentalEventRow> = {}): RentalEventRow {
  const row: RentalEventRow = {
    id: RENTAL_ID,
    company_id: 'co-1',
    project_id: null,
    customer_id: null,
    item_description: 'Scaffold tower',
    daily_rate: '12.50',
    delivered_on: '2026-05-01',
    returned_on: null,
    next_invoice_at: null,
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

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'office' | 'member' = 'admin',
): { ctx: RentalEventRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
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

describe('handleRentalEventRoutes — GET /api/rentals/:id', () => {
  it('returns a WorkflowSnapshot with state, state_version, context, and next_events', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleRentalEventRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/rentals/${RENTAL_ID}`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const snap = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string }>
      context: { status: string }
    }
    expect(snap.state).toBe('active')
    expect(snap.state_version).toBe(1)
    expect(snap.context.status).toBe('active')
    expect(snap.next_events.map((e) => e.type).sort()).toEqual(['CLOSE', 'RETURN'])
  })

  it('returns 404 for an unknown rental id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleRentalEventRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/rentals/${RENTAL_ID}`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(404)
  })

  it('returns 400 when id is not a uuid', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleRentalEventRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/rentals/not-a-uuid'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(400)
  })
})

describe('handleRentalEventRoutes — POST /api/rentals/:id/events', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'RETURN', state_version: 1 }, 'member')
    await handleRentalEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rentals/${RENTAL_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(403)
  })

  it('rejects invalid uuids with 400', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'RETURN', state_version: 1 })
    await handleRentalEventRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/rentals/not-a-uuid/events'),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('rejects worker-only events (INVOICE_QUEUED) at the request parser', async () => {
    const pool = new FakePool()
    seedRental(pool, { status: 'returned', state_version: 2 })
    const { ctx, responses } = makeCtx(pool, { event: 'INVOICE_QUEUED', state_version: 2 })
    await handleRentalEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rentals/${RENTAL_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
    expect(pool.workflowEvents).toHaveLength(0)
  })

  it('RETURN: transitions active → returned, writes workflow_event_log + audit_events', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'RETURN', state_version: 1 })
    await handleRentalEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rentals/${RENTAL_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.rentals[0]?.status).toBe('returned')
    expect(pool.rentals[0]?.state_version).toBe(2)
    expect(pool.rentals[0]?.returned_by).toBe('u-1')
    expect(pool.rentals[0]?.returned_at).not.toBeNull()
    // returned_on backfilled from the reducer's update branch
    expect(pool.rentals[0]?.returned_on).not.toBeNull()
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]?.event_type).toBe('RETURN')
    expect(pool.workflowEvents[0]?.state_version).toBe(1)
    expect(pool.workflowEvents[0]?.workflow_name).toBe('rental')
    // Two audit rows fire: one inside the tx via recordMutationLedger →
    // isAuditableEntity('rental') → recordAudit (since we added 'rental'
    // to the audit allowlist as part of this Phase 2 migration), and one
    // outside the tx via the route's explicit recordAudit. This mirrors
    // the rental-billing-state pattern.
    expect(pool.auditEvents.length).toBeGreaterThanOrEqual(1)
    expect(pool.auditEvents[0]?.entity_type).toBe('rental')
    expect(pool.auditEvents[0]?.action).toBe('event:return')
    // The event surface writes a ledger row keyed on state_version (per the
    // canonical workflow pattern). Rental has no external-system side effect
    // for RETURN — the worker's rental-invoice runner handles the QBO push
    // via a separate cadence — so the mutation_outbox row here is the
    // standard ledger entry (key: rental:event:<id>:<state_version>), not
    // a worker dispatch token.
    const ledgerRow = pool.outbox.find((r) => r.entity_type === 'rental')
    expect(ledgerRow?.idempotency_key).toBe(`rental:event:${RENTAL_ID}:2`)
    expect(ledgerRow?.mutation_type).toBe('event:return')
  })

  it('CLOSE: transitions active → closed', async () => {
    const pool = new FakePool()
    seedRental(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'CLOSE', state_version: 1 })
    await handleRentalEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rentals/${RENTAL_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.rentals[0]?.status).toBe('closed')
    expect(pool.rentals[0]?.state_version).toBe(2)
    expect(pool.rentals[0]?.closed_by).toBe('u-1')
    expect(pool.workflowEvents[0]?.event_type).toBe('CLOSE')
  })

  it('CLOSE: works from returned and invoiced_pending', async () => {
    for (const fromState of ['returned', 'invoiced_pending']) {
      const pool = new FakePool()
      seedRental(pool, { status: fromState, state_version: 2 })
      const { ctx, responses } = makeCtx(pool, { event: 'CLOSE', state_version: 2 })
      await handleRentalEventRoutes(
        { method: 'POST' } as never,
        buildUrl(`/api/rentals/${RENTAL_ID}/events`),
        ctx,
      )
      expect(responses[0]?.status, `from ${fromState}: ${JSON.stringify(responses[0]?.body)}`).toBe(200)
      expect(pool.rentals[0]?.status).toBe('closed')
    }
  })

  it('returns 409 on stale state_version, with the current snapshot for reload', async () => {
    const pool = new FakePool()
    seedRental(pool, { state_version: 5 })
    const { ctx, responses } = makeCtx(pool, { event: 'CLOSE', state_version: 1 })
    await handleRentalEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rentals/${RENTAL_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
    const body = responses[0]?.body as { snapshot: { state_version: number } }
    expect(body.snapshot.state_version).toBe(5)
    expect(pool.workflowEvents).toHaveLength(0)
  })

  it('returns 409 on illegal transition (RETURN from closed)', async () => {
    const pool = new FakePool()
    seedRental(pool, { status: 'closed', state_version: 4 })
    const { ctx, responses } = makeCtx(pool, { event: 'RETURN', state_version: 4 })
    await handleRentalEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rentals/${RENTAL_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
    expect(pool.workflowEvents).toHaveLength(0)
  })

  it('returns 404 when rental not found', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'CLOSE', state_version: 1 })
    await handleRentalEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rentals/${RENTAL_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleRentalEventRoutes — non-matching paths', () => {
  it('returns false for non-rental paths', async () => {
    const pool = new FakePool()
    const { ctx } = makeCtx(pool)
    expect(
      await handleRentalEventRoutes({ method: 'GET' } as never, buildUrl('/api/projects/x'), ctx),
    ).toBe(false)
  })

  it('returns false for POST /api/rentals/:id/return (legacy route — defer)', async () => {
    const pool = new FakePool()
    const { ctx } = makeCtx(pool)
    expect(
      await handleRentalEventRoutes(
        { method: 'POST' } as never,
        buildUrl(`/api/rentals/${RENTAL_ID}/return`),
        ctx,
      ),
    ).toBe(false)
  })
})
