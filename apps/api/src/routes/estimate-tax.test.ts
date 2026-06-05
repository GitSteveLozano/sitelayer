import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleEstimateRoutes, type EstimateRouteCtx } from './estimate.js'

// In-memory pg double for the sales-tax endpoints (gap G4):
//   GET /api/projects/:id/estimate/tax  — taxable/non-taxable breakdown + total
//   PUT /api/projects/:id/estimate/tax  — set project.tax_rate

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

class FakePool {
  taxRate = '0.0825'
  taxable = '10000.00'
  nonTaxable = '4000.00'
  projectMissing = false
  updatedRate: string | null = null

  attach() {
    attachMutationTx({ pool: this as unknown as Pool, logger: { warn: () => undefined } as unknown as pino.Logger })
  }
  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }
  async connect() {
    return { query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params), release: () => undefined }
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
    if (/^select tax_rate from projects/i.test(sql)) {
      return this.projectMissing ? { rows: [], rowCount: 0 } : { rows: [{ tax_rate: this.taxRate }], rowCount: 1 }
    }
    if (/from estimate_lines/i.test(sql)) {
      return { rows: [{ taxable: this.taxable, non_taxable: this.nonTaxable }], rowCount: 1 }
    }
    if (/^update projects set tax_rate/i.test(sql)) {
      if (this.projectMissing) return { rows: [], rowCount: 0 }
      this.updatedRate = String(params[0])
      return { rows: [{ id: 'p', tax_rate: this.updatedRate }], rowCount: 1 }
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 120)}`)
  }
}

function makeCtx(pool: FakePool, body: Record<string, unknown> = {}, overrides: Partial<EstimateRouteCtx> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const ctx: EstimateRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' as const },
    currentUserId: 'u-1',
    requireRole: () => true,
    readBody: async () => body,
    sendJson: (status, b) => responses.push({ status, body: b }),
    sendPdf: async () => undefined,
    sendFileContent: () => undefined,
    ...overrides,
  }
  return { ctx, responses }
}

const url = (path: string) => new URL(`http://localhost${path}`)
const TAX = (qs = '') => url(`/api/projects/${PROJECT_ID}/estimate/tax${qs}`)

describe('handleEstimateRoutes — estimate sales tax (gap G4)', () => {
  it('GET computes taxable/non-taxable subtotal, tax, and grand total at the project rate', async () => {
    const pool = new FakePool() // rate 0.0825, taxable 10000, non-taxable 4000
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleEstimateRoutes({ method: 'GET' } as never, TAX(), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(responses[0]?.body).toMatchObject({
      tax_rate: 0.0825,
      taxable_subtotal: '10000.00',
      non_taxable_subtotal: '4000.00',
      tax_amount: '825.00', // 10000 * 0.0825
      grand_total: '14825.00', // 10000 + 4000 + 825
    })
  })

  it('GET honors a ?rate= what-if override', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleEstimateRoutes({ method: 'GET' } as never, TAX('?rate=0.1'), ctx)
    expect(responses[0]?.body).toMatchObject({ tax_rate: 0.1, tax_amount: '1000.00', grand_total: '15000.00' })
  })

  it('GET rejects an out-of-range ?rate=', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleEstimateRoutes({ method: 'GET' } as never, TAX('?rate=2'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('GET 404s a missing project', async () => {
    const pool = new FakePool()
    pool.projectMissing = true
    const { ctx, responses } = makeCtx(pool)
    await handleEstimateRoutes({ method: 'GET' } as never, TAX(), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('PUT sets the project tax rate', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { tax_rate: 0.07 })
    await handleEstimateRoutes({ method: 'PUT' } as never, TAX(), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toMatchObject({ tax_rate: 0.07 })
    expect(pool.updatedRate).toBe('0.07')
  })

  it('PUT rejects an out-of-range tax_rate', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { tax_rate: 1.5 })
    await handleEstimateRoutes({ method: 'PUT' } as never, TAX(), ctx)
    expect(responses[0]?.status).toBe(400)
    expect(pool.updatedRate).toBeNull()
  })
})
