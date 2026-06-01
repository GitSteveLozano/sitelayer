import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleScaffoldOpsRoutes, type ScaffoldOpsRouteCtx } from './scaffold-ops.js'

// ---------------------------------------------------------------------------
// scaffold_ops_approval — BOM /events envelope (Gap 4/5).
//
// Verifies the canonical ADR-5 POST /api/boms/:id/events route:
//   - APPROVE with the correct state_version → 200 + bumped version
//   - stale state_version → 409
//   - empty body → 400 (parse error)
//   - SUPERSEDE links superseded_by + lands in `superseded`
//   - SUPERSEDE on an approved BOM is legal; APPROVE on superseded → 409
//
// Uses a hand-written FakePool that pattern-matches the boms SQL, the same
// approach as qbo.test.ts.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type BomRow = {
  id: string
  company_id: string
  project_id: string
  source: string
  source_ref: string | null
  name: string
  notes: string | null
  status: string
  state_version: number
  approved_at: string | null
  approved_by: string | null
  superseded_by: string | null
  superseded_at: string | null
  superseded_by_user: string | null
  total_weight_kg: number
  total_lines: number
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

class FakePool {
  boms: BomRow[] = []
  workflowEventLog: Row[] = []

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
    if (/^\s*insert into workflow_event_log/i.test(sql)) {
      this.workflowEventLog.push({ params })
      return { rows: [], rowCount: 1 }
    }
    // boms read / lock
    if (/from boms/i.test(sql) && /select/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.boms.find((b) => b.company_id === companyId && b.id === id && b.deleted_at === null)
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    // boms update (dispatchBomEvent persist)
    if (/^update boms/i.test(sql)) {
      const [
        companyId,
        id,
        status,
        stateVersion,
        approvedAt,
        approvedBy,
        supersededBy,
        supersededAt,
        supersededByUser,
      ] = params as [
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
      const row = this.boms.find((b) => b.company_id === companyId && b.id === id && b.deleted_at === null)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.approved_at = approvedAt
      row.approved_by = approvedBy
      row.superseded_by = supersededBy
      row.superseded_at = supersededAt
      row.superseded_by_user = supersededByUser
      row.version += 1
      return { rows: [{ ...row }], rowCount: 1 }
    }
    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function seedBom(pool: FakePool, overrides: Partial<BomRow> = {}): BomRow {
  const row: BomRow = {
    id: overrides.id ?? 'bom-1',
    company_id: overrides.company_id ?? 'co-1',
    project_id: overrides.project_id ?? 'proj-1',
    source: 'manual',
    source_ref: null,
    name: 'Tower BOM',
    notes: null,
    status: overrides.status ?? 'draft',
    state_version: overrides.state_version ?? 1,
    approved_at: overrides.approved_at ?? null,
    approved_by: overrides.approved_by ?? null,
    superseded_by: overrides.superseded_by ?? null,
    superseded_at: overrides.superseded_at ?? null,
    superseded_by_user: overrides.superseded_by_user ?? null,
    total_weight_kg: 0,
    total_lines: 0,
    version: overrides.version ?? 1,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
  }
  pool.boms.push(row)
  return row
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'office' | 'member' = 'admin',
): { ctx: ScaffoldOpsRouteCtx; responses: Array<{ status: number; body: unknown }> } {
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

describe('POST /api/boms/:id/events — APPROVE', () => {
  it('APPROVE with correct state_version → 200 + bumped version + event-log row', async () => {
    const pool = new FakePool()
    seedBom(pool, { id: 'bom-1', status: 'draft', state_version: 1 })
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleScaffoldOpsRoutes({ method: 'POST' } as never, buildUrl('/api/boms/bom-1/events'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { state: string; state_version: number; next_events: Array<{ type: string }> }
    expect(body.state).toBe('approved')
    expect(body.state_version).toBe(2)
    expect(body.next_events.map((e) => e.type)).toEqual(['SUPERSEDE'])
    expect(pool.workflowEventLog).toHaveLength(1)
  })

  it('stale state_version → 409', async () => {
    const pool = new FakePool()
    seedBom(pool, { id: 'bom-1', status: 'draft', state_version: 4 })
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleScaffoldOpsRoutes({ method: 'POST' } as never, buildUrl('/api/boms/bom-1/events'), ctx)
    expect(responses[0]?.status).toBe(409)
  })

  it('empty body → 400 (parse error)', async () => {
    const pool = new FakePool()
    seedBom(pool, { id: 'bom-1' })
    const { ctx, responses } = makeCtx(pool, {})
    await handleScaffoldOpsRoutes({ method: 'POST' } as never, buildUrl('/api/boms/bom-1/events'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('non-admin/office → 403', async () => {
    const pool = new FakePool()
    seedBom(pool, { id: 'bom-1' })
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 }, 'member')
    await handleScaffoldOpsRoutes({ method: 'POST' } as never, buildUrl('/api/boms/bom-1/events'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('404 on unknown bom', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleScaffoldOpsRoutes({ method: 'POST' } as never, buildUrl('/api/boms/nope/events'), ctx)
    expect(responses[0]?.status).toBe(404)
  })
})

describe('POST /api/boms/:id/events — SUPERSEDE', () => {
  it('SUPERSEDE on an approved BOM links superseded_by and lands in superseded', async () => {
    const pool = new FakePool()
    seedBom(pool, { id: 'bom-1', status: 'approved', state_version: 2, approved_by: 'office' })
    const { ctx, responses } = makeCtx(pool, {
      event: 'SUPERSEDE',
      state_version: 2,
      superseded_by_bom_id: 'bom-2',
    })
    await handleScaffoldOpsRoutes({ method: 'POST' } as never, buildUrl('/api/boms/bom-1/events'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { state: string; superseded_by: string | null; next_events: unknown[] }
    expect(body.state).toBe('superseded')
    expect(body.superseded_by).toBe('bom-2')
    expect(body.next_events).toEqual([])
    expect(pool.boms[0]?.superseded_by).toBe('bom-2')
    expect(pool.boms[0]?.superseded_by_user).toBe('u-1')
  })

  it('APPROVE on a superseded BOM → 409 illegal transition', async () => {
    const pool = new FakePool()
    seedBom(pool, { id: 'bom-1', status: 'superseded', state_version: 3 })
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 3 })
    await handleScaffoldOpsRoutes({ method: 'POST' } as never, buildUrl('/api/boms/bom-1/events'), ctx)
    expect(responses[0]?.status).toBe(409)
  })
})

describe('POST /api/boms/:id/approve — deprecated alias still works', () => {
  it('empty body dispatches APPROVE through the reducer', async () => {
    const pool = new FakePool()
    seedBom(pool, { id: 'bom-1', status: 'draft', state_version: 1 })
    const { ctx, responses } = makeCtx(pool, {})
    await handleScaffoldOpsRoutes({ method: 'POST' } as never, buildUrl('/api/boms/bom-1/approve'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { status: string }
    expect(body.status).toBe('approved')
    expect(pool.workflowEventLog).toHaveLength(1)
  })
})
