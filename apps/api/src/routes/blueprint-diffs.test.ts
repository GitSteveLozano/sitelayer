import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleBlueprintDiffRoutes, type BlueprintDiffRouteCtx } from './blueprint-diffs.js'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const DOC_ID = '22222222-2222-4222-8222-222222222222'
const NEW_PAGE_ID = '33333333-3333-4333-8333-333333333333'
const PRIOR_PAGE_ID = '44444444-4444-4444-8444-444444444444'
const M1 = '55555555-5555-4555-8555-555555555555'
const M2 = '66666666-6666-4666-8666-666666666666'

/**
 * Fake pool that satisfies `withCompanyClient` (connect → begin read only →
 * set_config → query → commit) and answers the two queries the diff route
 * issues: the document existence check and the diffs join.
 */
class FakePool {
  documentExists = true
  diffRows: Array<Record<string, unknown>> = []

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  private dispatch(sqlRaw: string, _params: unknown[]) {
    const sql = sqlRaw.trim().toLowerCase()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('from blueprint_documents') && sql.includes('exists')) {
      return { rows: [{ exists: this.documentExists }], rowCount: 1 }
    }
    if (sql.includes('from blueprint_page_diffs')) {
      return { rows: this.diffRows, rowCount: this.diffRows.length }
    }
    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeCtx(pool: FakePool): {
  ctx: BlueprintDiffRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', role: 'admin', created_at: '' },
      requireRole: () => true,
      sendJson: (status, body) => responses.push({ status, body }),
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function mockReq(method: string) {
  return { method, headers: {} } as never
}

describe('handleBlueprintDiffRoutes — GET /api/blueprints/:id/diffs', () => {
  it('returns stored diffs + a deduped affected-measurement rollup', async () => {
    const pool = new FakePool()
    pool.diffRows = [
      {
        id: 'diff-1',
        new_page_id: NEW_PAGE_ID,
        prior_page_id: PRIOR_PAGE_ID,
        new_page_number: 1,
        prior_page_number: 1,
        change_kind: 'modified',
        bbox_x: '10.0000',
        bbox_y: '10.0000',
        bbox_w: '20.0000',
        bbox_h: '20.0000',
        confidence: '0.900',
        affected_measurement_ids: [M1, M2],
        notes: null,
        created_at: '2026-06-01T00:00:00Z',
      },
      {
        id: 'diff-2',
        new_page_id: NEW_PAGE_ID,
        prior_page_id: null,
        new_page_number: 1,
        prior_page_number: null,
        change_kind: 'added',
        bbox_x: '40.0000',
        bbox_y: '40.0000',
        bbox_w: '10.0000',
        bbox_h: '10.0000',
        confidence: '1.000',
        // M1 repeats across diffs — the rollup must dedupe it.
        affected_measurement_ids: [M1],
        notes: null,
        created_at: '2026-06-01T00:01:00Z',
      },
    ]
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleBlueprintDiffRoutes(mockReq('GET'), buildUrl(`/api/blueprints/${DOC_ID}/diffs`), ctx)

    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    const res = responses[0]!
    expect(res.status).toBe(200)
    const body = res.body as {
      diffs: unknown[]
      affected_measurement_ids: string[]
      affected_measurement_count: number
    }
    expect(body.diffs).toHaveLength(2)
    expect([...body.affected_measurement_ids].sort()).toEqual([M1, M2].sort())
    expect(body.affected_measurement_count).toBe(2)
  })

  it('returns an empty rollup when no diffs are populated (badge hides)', async () => {
    const pool = new FakePool()
    pool.diffRows = []
    const { ctx, responses } = makeCtx(pool)

    await handleBlueprintDiffRoutes(mockReq('GET'), buildUrl(`/api/blueprints/${DOC_ID}/diffs`), ctx)

    expect(responses).toEqual([
      { status: 200, body: { diffs: [], affected_measurement_ids: [], affected_measurement_count: 0 } },
    ])
  })

  it('404s when the blueprint document is not in the company scope', async () => {
    const pool = new FakePool()
    pool.documentExists = false
    const { ctx, responses } = makeCtx(pool)

    await handleBlueprintDiffRoutes(mockReq('GET'), buildUrl(`/api/blueprints/${DOC_ID}/diffs`), ctx)

    expect(responses).toEqual([{ status: 404, body: { error: 'blueprint document not found' } }])
  })

  it('400s on a non-uuid document id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleBlueprintDiffRoutes(mockReq('GET'), buildUrl('/api/blueprints/not-a-uuid/diffs'), ctx)

    expect(responses).toEqual([{ status: 400, body: { error: 'document id must be a valid uuid' } }])
  })

  it('does not handle non-GET methods or unrelated paths', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    const post = await handleBlueprintDiffRoutes(mockReq('POST'), buildUrl(`/api/blueprints/${DOC_ID}/diffs`), ctx)
    const other = await handleBlueprintDiffRoutes(mockReq('GET'), buildUrl(`/api/blueprints/${DOC_ID}/pages`), ctx)

    expect(post).toBe(false)
    expect(other).toBe(false)
    expect(responses).toEqual([])
  })
})
