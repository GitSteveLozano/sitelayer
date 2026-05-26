import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleEstimateRoutes, type EstimateRouteCtx } from './estimate.js'

// ---------------------------------------------------------------------------
// In-memory pg double for PATCH /api/estimate-lines/:id. Matches the SQL the
// route + recordMutationLedger + getScopeVsBid emit by substring. Mirrors the
// stub style of estimate-shares.test.ts; not a general SQL emulator.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type EstimateLineRow = {
  id: string
  company_id: string
  project_id: string
  draft_id: string | null
  service_item_code: string
  quantity: string
  unit: string
  rate: string
  amount: string
  division_code: string | null
  created_at: string
}

class FakePool {
  lines: EstimateLineRow[] = []
  projects: Array<{ company_id: string; id: string; bid_total: number }> = []
  /** (company_id, service_item_code) -> allowed division codes (presence => curated). */
  catalog = new Map<string, Set<string>>()
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
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // Catalog existence: "select exists( select 1 from service_item_divisions ... ) as exists"
    if (/from service_item_divisions/i.test(sql) && /as exists/i.test(sql)) {
      const hasDivisionFilter = /division_code = \$3/.test(sql)
      const [companyId, code, division] = params as [string, string, string | undefined]
      const allowed = this.catalog.get(`${companyId}:${code}`)
      const exists = hasDivisionFilter
        ? Boolean(allowed && division !== undefined && allowed.has(division))
        : Boolean(allowed)
      return { rows: [{ exists }], rowCount: 1 }
    }

    // Initial line read (route): "select id, project_id, draft_id, service_item_code, ... from estimate_lines where company_id = $1 and id = $2"
    if (
      /from estimate_lines/i.test(sql) &&
      /where company_id = \$1 and id = \$2/.test(sql) &&
      /select id, project_id/i.test(sql)
    ) {
      const [companyId, id] = params as [string, string]
      const line = this.lines.find((l) => l.company_id === companyId && l.id === id)
      return { rows: line ? [{ ...line }] : [], rowCount: line ? 1 : 0 }
    }

    // Update line
    if (/^update estimate_lines/i.test(sql)) {
      const [companyId, id, quantity, rate, amount] = params as [string, string, string, string, string]
      const line = this.lines.find((l) => l.company_id === companyId && l.id === id)
      if (!line) return { rows: [], rowCount: 0 }
      line.quantity = quantity
      line.rate = rate
      line.amount = amount
      return {
        rows: [
          {
            id: line.id,
            service_item_code: line.service_item_code,
            quantity: line.quantity,
            unit: line.unit,
            rate: line.rate,
            amount: line.amount,
            division_code: line.division_code,
            created_at: line.created_at,
          },
        ],
        rowCount: 1,
      }
    }

    // getScopeVsBid: project bid_total
    if (/select bid_total from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [{ bid_total: project.bid_total }] : [], rowCount: project ? 1 : 0 }
    }

    // resolveDefaultDraftId — only hit when draftId is null. Our test seeds a
    // draft on the line so getScopeVsBid passes draftId through and skips this,
    // but handle it defensively.
    if (/from takeoff_drafts/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }

    // getScopeVsBid: list lines (has "from estimate_lines" + "order by created_at")
    if (/from\s+estimate_lines/i.test(sql) && /order by created_at/i.test(sql)) {
      const draftScoped = /draft_id = \$3/.test(sql)
      const [companyId, projectId, draftId] = params as [string, string, string | undefined]
      const rows = this.lines
        .filter(
          (l) =>
            l.company_id === companyId &&
            l.project_id === projectId &&
            (draftScoped ? l.draft_id === draftId : l.draft_id === null),
        )
        .map((l) => ({
          id: l.id,
          service_item_code: l.service_item_code,
          quantity: l.quantity,
          unit: l.unit,
          rate: l.rate,
          amount: l.amount,
          division_code: l.division_code,
          created_at: l.created_at,
        }))
      return { rows, rowCount: rows.length }
    }

    if (/^insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeCtx(pool: FakePool, overrides: Partial<EstimateRouteCtx> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  const ctx: EstimateRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' },
    currentUserId: 'u-1',
    requireRole: () => true,
    readBody: async () => (reads.shift() ?? {}) as Record<string, unknown>,
    sendJson: (status: number, body: unknown) => {
      responses.push({ status, body })
    },
    sendPdf: async () => undefined,
    ...overrides,
  }
  return { ctx, responses, reads }
}

function seedLine(pool: FakePool, overrides: Partial<EstimateLineRow> = {}) {
  const line: EstimateLineRow = {
    id: '11111111-1111-4111-8111-111111111111',
    company_id: 'co-1',
    project_id: 'p-1',
    draft_id: 'd-1',
    service_item_code: 'SVC-1',
    quantity: '100',
    unit: 'sqft',
    rate: '25',
    amount: '2500',
    division_code: 'DIV-1',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
  pool.lines.push(line)
  pool.projects.push({ company_id: 'co-1', id: line.project_id, bid_total: 5000 })
  // Curate the catalog so the line's (code, division) passes enforcement.
  pool.catalog.set(`co-1:${line.service_item_code}`, new Set(line.division_code ? [line.division_code] : []))
  return line
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleEstimateRoutes — PATCH /api/estimate-lines/:id', () => {
  it('updates quantity, recomputes amount, and returns the refreshed scope_vs_bid', async () => {
    const pool = new FakePool()
    const line = seedLine(pool)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ quantity: 200 })

    const handled = await handleEstimateRoutes(
      { method: 'PATCH' } as never,
      buildUrl(`/api/estimate-lines/${line.id}`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as {
      line: { quantity: string; rate: string; amount: string }
      scope_vs_bid: { scope_total: number; lines: Array<{ id: string }> }
    }
    expect(Number(body.line.quantity)).toBe(200)
    expect(Number(body.line.rate)).toBe(25)
    expect(Number(body.line.amount)).toBe(5000)
    expect(body.scope_vs_bid.scope_total).toBe(5000)
    expect(body.scope_vs_bid.lines[0]?.id).toBe(line.id)
    // A sync_event + outbox row are emitted for the edit.
    expect(pool.syncEvents).toHaveLength(1)
    expect(pool.outbox).toHaveLength(1)
  })

  it('updates rate while leaving quantity untouched', async () => {
    const pool = new FakePool()
    const line = seedLine(pool)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ rate: 30 })

    await handleEstimateRoutes({ method: 'PATCH' } as never, buildUrl(`/api/estimate-lines/${line.id}`), ctx)
    const body = responses[0]?.body as { line: { quantity: string; rate: string; amount: string } }
    expect(Number(body.line.quantity)).toBe(100)
    expect(Number(body.line.rate)).toBe(30)
    expect(Number(body.line.amount)).toBe(3000)
  })

  it('returns 409 when expected_amount does not match the stored amount', async () => {
    const pool = new FakePool()
    const line = seedLine(pool)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ quantity: 200, expected_amount: 9999 })

    await handleEstimateRoutes({ method: 'PATCH' } as never, buildUrl(`/api/estimate-lines/${line.id}`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect((responses[0]?.body as { current_amount: number }).current_amount).toBe(2500)
    // No write happened.
    expect(pool.outbox).toHaveLength(0)
    expect(line.quantity).toBe('100')
  })

  it('passes the optimistic guard when expected_amount matches', async () => {
    const pool = new FakePool()
    const line = seedLine(pool)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ quantity: 120, expected_amount: 2500 })

    await handleEstimateRoutes({ method: 'PATCH' } as never, buildUrl(`/api/estimate-lines/${line.id}`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { line: { amount: string } }
    expect(Number(body.line.amount)).toBe(3000)
  })

  it('returns 422 when the service item is not in the curated catalog', async () => {
    const pool = new FakePool()
    const line = seedLine(pool)
    // Drop catalog curation for this item.
    pool.catalog.delete(`co-1:${line.service_item_code}`)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ quantity: 200 })

    await handleEstimateRoutes({ method: 'PATCH' } as never, buildUrl(`/api/estimate-lines/${line.id}`), ctx)
    expect(responses[0]?.status).toBe(422)
    expect(pool.outbox).toHaveLength(0)
  })

  it('returns 404 when the line does not exist for the company', async () => {
    const pool = new FakePool()
    seedLine(pool)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ quantity: 200 })

    await handleEstimateRoutes(
      { method: 'PATCH' } as never,
      buildUrl('/api/estimate-lines/22222222-2222-4222-8222-222222222222'),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })

  it('returns 400 for a non-uuid line id', async () => {
    const pool = new FakePool()
    seedLine(pool)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ quantity: 200 })

    await handleEstimateRoutes({ method: 'PATCH' } as never, buildUrl('/api/estimate-lines/not-a-uuid'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 400 when neither quantity nor rate is supplied', async () => {
    const pool = new FakePool()
    const line = seedLine(pool)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({})

    await handleEstimateRoutes({ method: 'PATCH' } as never, buildUrl(`/api/estimate-lines/${line.id}`), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 400 for a negative quantity', async () => {
    const pool = new FakePool()
    const line = seedLine(pool)
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ quantity: -5 })

    await handleEstimateRoutes({ method: 'PATCH' } as never, buildUrl(`/api/estimate-lines/${line.id}`), ctx)
    expect(responses[0]?.status).toBe(400)
  })
})
