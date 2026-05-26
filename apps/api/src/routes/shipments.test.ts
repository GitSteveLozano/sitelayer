import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleShipmentRoutes, type ShipmentRouteCtx } from './shipments.js'

// ---------------------------------------------------------------------------
// Shipment deterministic-workflow surface — snapshot / events. Mirrors
// rental-billing-state.test.ts: assert the WorkflowSnapshot envelope on GET,
// the version-conflict guard, the illegal-transition guard, and the
// shipment_events + workflow_event_log rows written inside the event tx.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type ShipmentRow = {
  id: string
  company_id: string
  project_id: string
  direction: string
  status: string
  state_version: number
  scheduled_for: string | null
  shipped_at: string | null
  delivered_at: string | null
  confirmed_by: string | null
  driver: string | null
  ticket_number: string | null
  notes: string | null
  version: number
  deleted_at: string | null
  [key: string]: unknown
}

class FakePool {
  shipments: ShipmentRow[] = []
  lines: Array<{ company_id: string; shipment_id: string; id: string }> = []
  shipmentEvents: Array<{
    shipment_id: string
    event_type: string
    state_before: string | null
    state_after: string | null
    state_version: number
  }> = []
  workflowEvents: Array<{ workflow_name: string; entity_id: string; state_version: number; event_type: string }> = []
  auditEvents: Row[] = []

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

    if (/^update shipments/i.test(sql)) {
      const [companyId, id, status, stateVersion, shippedAt, deliveredAt, confirmedBy, driver, ticketNumber] =
        params as [
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
      const row = this.shipments.find((r) => r.company_id === companyId && r.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.shipped_at = shippedAt
      row.delivered_at = deliveredAt
      row.confirmed_by = confirmedBy
      row.driver = driver
      row.ticket_number = ticketNumber
      row.version += 1
      row.updated_at = new Date().toISOString()
      return { rows: [row], rowCount: 1 }
    }

    if (/from shipments/i.test(sql) && /where/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.shipments.find((r) => r.company_id === companyId && r.id === id && !r.deleted_at)
      // Return a snapshot copy — a real SELECT row is independent of the
      // stored row, so a later UPDATE in the same tx must not retroactively
      // mutate the value the handler captured pre-update (state_before).
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }

    if (/from shipment_lines/i.test(sql)) {
      const [companyId, shipmentId] = params as [string, string]
      const rows = this.lines.filter((l) => l.company_id === companyId && l.shipment_id === shipmentId)
      return { rows, rowCount: rows.length }
    }

    if (/from shipment_events/i.test(sql)) {
      const [companyId, shipmentId] = params as [string, string]
      const rows = this.shipmentEvents.filter(
        (e) => (e as { company_id?: string }).company_id === companyId && e.shipment_id === shipmentId,
      )
      return { rows, rowCount: rows.length }
    }

    if (/^\s*insert into shipment_events/i.test(sql)) {
      this.shipmentEvents.push({
        company_id: params[0] as string,
        shipment_id: params[1] as string,
        event_type: params[2] as string,
        state_before: params[4] as string | null,
        state_after: params[5] as string | null,
        state_version: params[6] as number,
      } as never)
      return { rows: [], rowCount: 1 }
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

    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

const SHIPMENT_ID = 's1111111-1111-4111-8111-111111111111'

function seedShipment(pool: FakePool, overrides: Partial<ShipmentRow> = {}): ShipmentRow {
  const row: ShipmentRow = {
    id: SHIPMENT_ID,
    company_id: 'co-1',
    project_id: 'p-1',
    bom_id: null,
    source_branch_id: null,
    destination_location_id: null,
    direction: 'outbound',
    status: 'planned',
    state_version: 1,
    scheduled_for: '2026-05-10',
    shipped_at: null,
    delivered_at: null,
    confirmed_by: null,
    driver: null,
    ticket_number: null,
    notes: null,
    workflow_engine: 'postgres',
    workflow_run_id: null,
    version: 1,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
  pool.shipments.push(row)
  return row
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'member' = 'admin',
): { ctx: ShipmentRouteCtx; responses: Array<{ status: number; body: unknown }> } {
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
    } as ShipmentRouteCtx,
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleShipmentRoutes — GET /api/shipments/:id', () => {
  it('returns a WorkflowSnapshot with state, state_version, context, and next_events', async () => {
    const pool = new FakePool()
    seedShipment(pool)
    const { ctx, responses } = makeCtx(pool)
    await handleShipmentRoutes({ method: 'GET' } as never, buildUrl(`/api/shipments/${SHIPMENT_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const snap = responses[0]?.body as {
      state: string
      state_version: number
      context: { id: string; lines: unknown[]; events: unknown[] }
      next_events: Array<{ type: string }>
    }
    expect(snap.state).toBe('planned')
    expect(snap.state_version).toBe(1)
    expect(snap.context.id).toBe(SHIPMENT_ID)
    expect(Array.isArray(snap.context.lines)).toBe(true)
    expect(Array.isArray(snap.context.events)).toBe(true)
    expect(snap.next_events.map((e) => e.type).sort()).toEqual(['SHIP', 'START_PICKING', 'VOID'])
  })

  it('returns 404 for an unknown shipment id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleShipmentRoutes({ method: 'GET' } as never, buildUrl(`/api/shipments/${SHIPMENT_ID}`), ctx)
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleShipmentRoutes — POST /api/shipments/:id/events', () => {
  it('rejects callers without a write role with 403', async () => {
    const pool = new FakePool()
    seedShipment(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'START_PICKING', state_version: 1 }, 'member')
    await handleShipmentRoutes({ method: 'POST' } as never, buildUrl(`/api/shipments/${SHIPMENT_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('START_PICKING: transitions planned → picking and writes both event rows', async () => {
    const pool = new FakePool()
    seedShipment(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'START_PICKING', state_version: 1 })
    await handleShipmentRoutes({ method: 'POST' } as never, buildUrl(`/api/shipments/${SHIPMENT_ID}/events`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.shipments[0]?.status).toBe('picking')
    expect(pool.shipments[0]?.state_version).toBe(2)
    // shipment_events (human trail) + workflow_event_log (replay corpus)
    expect(pool.shipmentEvents).toHaveLength(1)
    expect(pool.shipmentEvents[0]?.event_type).toBe('START_PICKING')
    expect(pool.shipmentEvents[0]?.state_before).toBe('planned')
    expect(pool.shipmentEvents[0]?.state_after).toBe('picking')
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]?.workflow_name).toBe('shipment')
    expect(pool.workflowEvents[0]?.event_type).toBe('START_PICKING')
    // state_version BEFORE the transition.
    expect(pool.workflowEvents[0]?.state_version).toBe(1)
    // Response is the fresh WorkflowSnapshot.
    const snap = responses[0]?.body as { state: string; state_version: number; next_events: Array<{ type: string }> }
    expect(snap.state).toBe('picking')
    expect(snap.state_version).toBe(2)
    expect(snap.next_events.map((e) => e.type).sort()).toEqual(['SHIP', 'VOID'])
  })

  it('SHIP: transitions and persists shipped_at + driver from the payload', async () => {
    const pool = new FakePool()
    seedShipment(pool, { status: 'picking', state_version: 2 })
    const { ctx, responses } = makeCtx(pool, {
      event: 'SHIP',
      state_version: 2,
      payload: { shipped_at: '2026-05-11T08:00:00.000Z', driver: 'Dana' },
    })
    await handleShipmentRoutes({ method: 'POST' } as never, buildUrl(`/api/shipments/${SHIPMENT_ID}/events`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.shipments[0]?.status).toBe('shipped')
    expect(pool.shipments[0]?.shipped_at).toBe('2026-05-11T08:00:00.000Z')
    expect(pool.shipments[0]?.driver).toBe('Dana')
  })

  it('returns 409 on stale state_version without writing event rows', async () => {
    const pool = new FakePool()
    seedShipment(pool, { state_version: 5 })
    const { ctx, responses } = makeCtx(pool, { event: 'START_PICKING', state_version: 1 })
    await handleShipmentRoutes({ method: 'POST' } as never, buildUrl(`/api/shipments/${SHIPMENT_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect((responses[0]?.body as { snapshot?: { state_version: number } }).snapshot?.state_version).toBe(5)
    expect(pool.shipmentEvents).toHaveLength(0)
    expect(pool.workflowEvents).toHaveLength(0)
  })

  it('returns 409 on an illegal transition (CONFIRM_DELIVERY from planned)', async () => {
    const pool = new FakePool()
    seedShipment(pool, { status: 'planned', state_version: 1 })
    const { ctx, responses } = makeCtx(pool, { event: 'CONFIRM_DELIVERY', state_version: 1 })
    await handleShipmentRoutes({ method: 'POST' } as never, buildUrl(`/api/shipments/${SHIPMENT_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect(pool.shipmentEvents).toHaveLength(0)
  })

  it('returns 400 on an unknown event type', async () => {
    const pool = new FakePool()
    seedShipment(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'NOPE', state_version: 1 })
    await handleShipmentRoutes({ method: 'POST' } as never, buildUrl(`/api/shipments/${SHIPMENT_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(400)
  })
})
