import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleEstimateRoutes, type EstimateRouteCtx } from './estimate.js'

// In-memory pg double for GET /api/projects/:id/estimate/rollup (gap G4). The
// route runs one grouped select against estimate_lines; we return canned group
// rows and capture which column the axis whitelist mapped to, proving no raw
// caller axis string ever reaches the SQL.

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

class FakePool {
  rollupRows: Array<Record<string, unknown>> = []
  lastAxisCol: string | null = null

  attach() {
    attachMutationTx({ pool: this as unknown as Pool, logger: { warn: () => undefined } as unknown as pino.Logger })
  }
  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }
  async connect() {
    return { query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params), release: () => undefined }
  }
  private dispatch(sqlRaw: string, _params: unknown[]) {
    const sql = sqlRaw.trim()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }
    if (/from estimate_lines/i.test(sql)) {
      const m = sql.match(/coalesce\(nullif\(trim\((\w+)\)/)
      this.lastAxisCol = m?.[1] ?? null
      return { rows: this.rollupRows, rowCount: this.rollupRows.length }
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 120)}`)
  }
}

function makeCtx(pool: FakePool, overrides: Partial<EstimateRouteCtx> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const ctx: EstimateRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' as const },
    currentUserId: 'u-1',
    requireRole: () => true,
    readBody: async () => ({}),
    sendJson: (status, b) => responses.push({ status, body: b }),
    sendPdf: async () => undefined,
    sendFileContent: () => undefined,
    ...overrides,
  }
  return { ctx, responses }
}

const url = (path: string) => new URL(`http://localhost${path}`)
const ROLLUP = (qs = '') => url(`/api/projects/${PROJECT_ID}/estimate/rollup${qs}`)
const ROLLUP_CSV = (qs = '') => url(`/api/projects/${PROJECT_ID}/estimate/rollup.csv${qs}`)

describe('handleEstimateRoutes — GET /estimate/rollup (gap G4)', () => {
  it('rolls up by kind with subtotals + grand total', async () => {
    const pool = new FakePool()
    pool.rollupRows = [
      { group_key: 'material', line_count: 3, quantity: '120', amount: '4500.00' },
      { group_key: 'labor', line_count: 2, quantity: '40', amount: '2000.00' },
    ]
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleEstimateRoutes({ method: 'GET' } as never, ROLLUP('?axis=kind'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { axis: string; groups: unknown[]; group_count: number; total_amount: string }
    expect(body.axis).toBe('kind')
    expect(body.group_count).toBe(2)
    expect(body.total_amount).toBe('6500.00')
    expect(pool.lastAxisCol).toBe('kind') // whitelisted column, not the raw axis
  })

  it('defaults to the division axis', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleEstimateRoutes({ method: 'GET' } as never, ROLLUP(), ctx)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { axis: string }).axis).toBe('division')
    expect(pool.lastAxisCol).toBe('division_code')
  })

  it('accepts the G4 org-tag axes (phase) now that estimate_lines carry them', async () => {
    const pool = new FakePool()
    pool.rollupRows = [{ group_key: 'Phase 2', line_count: 5, quantity: '300', amount: '7850.00' }]
    const { ctx, responses } = makeCtx(pool)
    await handleEstimateRoutes({ method: 'GET' } as never, ROLLUP('?axis=phase'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { axis: string }).axis).toBe('phase')
    expect(pool.lastAxisCol).toBe('phase')
  })

  it('rejects an unknown axis (400) without touching the db — whitelist keeps raw input out of SQL', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleEstimateRoutes({ method: 'GET' } as never, ROLLUP('?axis=phase%3B%20drop%20table'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect(pool.lastAxisCol).toBeNull()
  })

  it('rejects a non-uuid project id (400)', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleEstimateRoutes(
      { method: 'GET' } as never,
      url('/api/projects/not-a-uuid/estimate/rollup?axis=kind'),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('does not run the rollup when the role gate denies', async () => {
    const pool = new FakePool()
    const { ctx } = makeCtx(pool, { requireRole: () => false })
    const handled = await handleEstimateRoutes({ method: 'GET' } as never, ROLLUP('?axis=kind'), ctx)
    expect(handled).toBe(true)
    expect(pool.lastAxisCol).toBeNull()
  })

  it('renders the rollup as a downloadable CSV report', async () => {
    const pool = new FakePool()
    pool.rollupRows = [
      { group_key: 'material', line_count: 3, quantity: '120', amount: '4500.00' },
      { group_key: 'labor', line_count: 2, quantity: '40', amount: '2000.00' },
    ]
    const files: Array<{ mime: string; name: string; content: string }> = []
    const { ctx } = makeCtx(pool, {
      sendFileContent: (mime, name, content) => files.push({ mime, name, content: String(content) }),
    })
    const handled = await handleEstimateRoutes({ method: 'GET' } as never, ROLLUP_CSV('?axis=kind'), ctx)
    expect(handled).toBe(true)
    expect(files).toHaveLength(1)
    expect(files[0]!.mime).toContain('text/csv')
    expect(files[0]!.name).toBe('estimate-rollup-kind.csv')
    expect(files[0]!.content).toContain('material')
    expect(files[0]!.content).toContain('4500.00')
    expect(files[0]!.content).toContain('Total')
    expect(files[0]!.content).toContain('6500.00') // 4500 + 2000
    expect(pool.lastAxisCol).toBe('kind')
  })

  it('rejects an unknown axis for the CSV report (400)', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleEstimateRoutes({ method: 'GET' } as never, ROLLUP_CSV('?axis=bogus'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect(pool.lastAxisCol).toBeNull()
  })
})
