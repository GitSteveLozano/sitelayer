import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleDamageChargeRoutes, type DamageChargeRouteCtx } from './damage-charges.js'

// ---------------------------------------------------------------------------
// Damage-charge settlement workflow surface — snapshot + events. Mirrors the
// rental-billing-state tests: assert the WorkflowSnapshot envelope, the
// version-conflict guard, the workflow_event_log row, and the INVOICE →
// damage_charge_invoice_push outbox stable-key hand-off to the QBO worker.
// ---------------------------------------------------------------------------

type ChargeRow = {
  id: string
  company_id: string
  status: string
  state_version: number
  invoiced_at: string | null
  invoiced_by: string | null
  waived_at: string | null
  waived_by: string | null
  waive_reason: string | null
  version: number
  deleted_at: string | null
} & Record<string, unknown>

class FakePool {
  charges: ChargeRow[] = []
  workflowEvents: Array<{
    workflow_name: string
    entity_id: string
    state_version: number
    event_type: string
  }> = []
  outbox: Array<{
    mutation_type: string
    idempotency_key: string
    entity_type: string
    entity_id: string
  }> = []

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

    if (/from damage_charges/i.test(sql) && /where/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.charges.find((c) => c.company_id === companyId && c.id === id && !c.deleted_at)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (/^update damage_charges/i.test(sql)) {
      const [companyId, id, status, stateVersion, invoicedAt, invoicedBy, waivedAt, waivedBy, waiveReason] = params as [
        string,
        string,
        string,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ]
      const row = this.charges.find((c) => c.company_id === companyId && c.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.invoiced_at = invoicedAt
      row.invoiced_by = invoicedBy
      row.waived_at = waivedAt
      row.waived_by = waivedBy
      row.waive_reason = waiveReason
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
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({
        entity_type: params[3] as string,
        entity_id: params[4] as string,
        mutation_type: params[5] as string,
        idempotency_key: params[7] as string,
      })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

const CHARGE_ID = 'd1111111-1111-4111-8111-111111111111'

function seedCharge(pool: FakePool, overrides: Partial<ChargeRow> = {}): ChargeRow {
  const row: ChargeRow = {
    id: CHARGE_ID,
    company_id: 'co-1',
    project_id: 'p-1',
    customer_id: 'cust-1',
    shipment_id: null,
    shipment_line_id: null,
    inventory_item_id: null,
    catalog_part_id: null,
    kind: 'damage',
    quantity: '2',
    unit_amount: '50.00',
    total_amount: '100.00',
    description: '2x cuplock standard, bent',
    taxable: true,
    status: 'open',
    state_version: 1,
    qbo_invoice_id: null,
    invoiced_at: null,
    invoiced_by: null,
    waived_at: null,
    waived_by: null,
    waive_reason: null,
    notes: null,
    version: 1,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
  pool.charges.push(row)
  return row
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'member' = 'admin',
): { ctx: DamageChargeRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      currentUserId: 'u-1',
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
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

describe('handleDamageChargeRoutes — GET /api/damage-charges/:id', () => {
  it('returns a WorkflowSnapshot with state, state_version, context, and next_events', async () => {
    const pool = new FakePool()
    seedCharge(pool)
    const { ctx, responses } = makeCtx(pool)
    await handleDamageChargeRoutes({ method: 'GET' } as never, buildUrl(`/api/damage-charges/${CHARGE_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const snap = responses[0]?.body as {
      state: string
      state_version: number
      context: { id: string; description: string }
      next_events: Array<{ type: string }>
    }
    expect(snap.state).toBe('open')
    expect(snap.state_version).toBe(1)
    expect(snap.context.id).toBe(CHARGE_ID)
    expect(snap.context.description).toBe('2x cuplock standard, bent')
    expect(snap.next_events.map((e) => e.type).sort()).toEqual(['INVOICE', 'WAIVE'])
  })

  it('returns no next_events for a terminal (invoiced) charge', async () => {
    const pool = new FakePool()
    seedCharge(pool, { status: 'invoiced', state_version: 2 })
    const { ctx, responses } = makeCtx(pool)
    await handleDamageChargeRoutes({ method: 'GET' } as never, buildUrl(`/api/damage-charges/${CHARGE_ID}`), ctx)
    const snap = responses[0]?.body as { next_events: unknown[] }
    expect(snap.next_events).toHaveLength(0)
  })

  it('returns 404 for an unknown charge id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleDamageChargeRoutes({ method: 'GET' } as never, buildUrl(`/api/damage-charges/${CHARGE_ID}`), ctx)
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleDamageChargeRoutes — POST /api/damage-charges/:id/events', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    seedCharge(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'INVOICE', state_version: 1 }, 'member')
    await handleDamageChargeRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/damage-charges/${CHARGE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(403)
  })

  it('INVOICE: transitions open → invoiced, writes a workflow_event_log row and the QBO push outbox row', async () => {
    const pool = new FakePool()
    seedCharge(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'INVOICE', state_version: 1 })
    await handleDamageChargeRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/damage-charges/${CHARGE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const snap = responses[0]?.body as { state: string; state_version: number }
    expect(snap.state).toBe('invoiced')
    expect(snap.state_version).toBe(2)
    expect(pool.charges[0]?.status).toBe('invoiced')
    expect(pool.charges[0]?.invoiced_by).toBe('u-1')
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]?.event_type).toBe('INVOICE')
    expect(pool.workflowEvents[0]?.state_version).toBe(1)
    expect(pool.workflowEvents[0]?.workflow_name).toBe('damage_charge_settlement')
    const pushRow = pool.outbox.find((r) => r.mutation_type === 'damage_charge_invoice_push')
    expect(pushRow).toBeDefined()
    // Stable per-charge key (same as the legacy /invoice route) so retries
    // collapse onto one outbox row.
    expect(pushRow?.idempotency_key).toBe(`damage_charge_invoice:${CHARGE_ID}`)
    expect(pushRow?.entity_type).toBe('damage_charge')
  })

  it('WAIVE: transitions open → waived, stamps the reason, no outbox row', async () => {
    const pool = new FakePool()
    seedCharge(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'WAIVE', state_version: 1, waive_reason: 'goodwill' })
    await handleDamageChargeRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/damage-charges/${CHARGE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.charges[0]?.status).toBe('waived')
    expect(pool.charges[0]?.waive_reason).toBe('goodwill')
    expect(pool.charges[0]?.waived_by).toBe('u-1')
    expect(pool.outbox).toHaveLength(0)
  })

  it('returns 409 on stale state_version without writing the outbox row', async () => {
    const pool = new FakePool()
    seedCharge(pool, { state_version: 5 })
    const { ctx, responses } = makeCtx(pool, { event: 'INVOICE', state_version: 1 })
    await handleDamageChargeRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/damage-charges/${CHARGE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
    expect(pool.outbox).toHaveLength(0)
    expect(pool.workflowEvents).toHaveLength(0)
  })

  it('returns 409 on illegal transition (INVOICE from invoiced)', async () => {
    const pool = new FakePool()
    seedCharge(pool, { status: 'invoiced', state_version: 2 })
    const { ctx, responses } = makeCtx(pool, { event: 'INVOICE', state_version: 2 })
    await handleDamageChargeRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/damage-charges/${CHARGE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
  })

  it('returns 404 for an unknown charge id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'INVOICE', state_version: 1 })
    await handleDamageChargeRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/damage-charges/${CHARGE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })

  it('returns 400 for a malformed event body', async () => {
    const pool = new FakePool()
    seedCharge(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'NOPE', state_version: 1 })
    await handleDamageChargeRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/damage-charges/${CHARGE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })
})
