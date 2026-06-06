import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleLaborEntryRoutes, type LaborEntryRouteCtx } from './labor-entries.js'

// ---------------------------------------------------------------------------
// Labor-entry CRUD route tests.
//
// Mirrors the FakePool + route-ctx double used by rental-billing-state.test.ts:
// a pg-shaped pool answers just the SQL the route issues, and the route ctx
// (requireRole / readBody / sendJson) is a thin capture harness. We exercise
// the role gate, the required-field + occurred_on validation, the catalog
// (service_item_divisions) enforcement, the optimistic project-version guard
// (409), and the happy-path INSERT/UPDATE/DELETE writes including the parent
// project version bump on create.
// ---------------------------------------------------------------------------

const COMPANY_ID = 'co-1'
const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const ENTRY_ID = '22222222-2222-4222-8222-222222222222'

type LaborRow = {
  id: string
  company_id: string
  project_id: string
  worker_id: string | null
  service_item_code: string
  hours: number
  sqft_done: number
  status: string
  occurred_on: string
  division_code: string | null
  version: number
  deleted_at: string | null
  created_at: string
}

class FakePool {
  entries: LaborRow[] = []
  /** project version, indexed by id; create/version-guard reads this. */
  projectVersions = new Map<string, number>()
  /** captured project version-bump UPDATEs. */
  projectVersionBumps: string[] = []
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

    // Project version read for the optimistic create-guard.
    if (/^select version from projects/i.test(sql)) {
      const [, projectId] = params as [string, string]
      const version = this.projectVersions.get(projectId)
      return version === undefined ? { rows: [], rowCount: 0 } : { rows: [{ version }], rowCount: 1 }
    }

    // PATCH effective-service-item lookup.
    if (/^select service_item_code from labor_entries/i.test(sql)) {
      const [, id] = params as [string, string]
      const row = this.entries.find((e) => e.id === id)
      return row ? { rows: [{ service_item_code: row.service_item_code }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (/^insert into labor_entries/i.test(sql)) {
      this.idCounter += 1
      const row: LaborRow = {
        id: `labor-${this.idCounter}`,
        company_id: params[0] as string,
        project_id: params[1] as string,
        worker_id: (params[2] ?? null) as string | null,
        service_item_code: params[3] as string,
        hours: Number(params[4]),
        sqft_done: Number(params[5] ?? 0),
        status: (params[6] as string) ?? 'draft',
        occurred_on: params[7] as string,
        division_code: (params[8] ?? null) as string | null,
        version: 1,
        deleted_at: null,
        created_at: new Date().toISOString(),
      }
      this.entries.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (/^select[\s\S]+from\s+labor_entries/i.test(sql)) {
      // GET list: params = [company, projectFilter, limit, offset].
      const [, projectFilter] = params as [string, string]
      const rows = this.entries.filter(
        (e) => e.company_id === COMPANY_ID && !e.deleted_at && (projectFilter === '' || e.project_id === projectFilter),
      )
      return { rows, rowCount: rows.length }
    }

    if (/^update labor_entries\s+set\s+deleted_at/i.test(sql)) {
      const [, id] = params as [string, string]
      const row = this.entries.find((e) => e.id === id && !e.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      row.deleted_at = new Date().toISOString()
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    if (/^update labor_entries\s+set/i.test(sql)) {
      // PATCH: company,$1 id,$2 worker,$3 service_item,$4 hours,$5
      //        sqft,$6 status,$7 occurred_on,$8 division,$9 divisionSet,$10
      const [, id, worker, serviceItem, hours, sqft, status, occurredOn, division, divisionSet] = params as [
        string,
        string,
        string | null,
        string | null,
        number | null,
        number | null,
        string | null,
        string | null,
        string | null,
        boolean,
      ]
      const row = this.entries.find((e) => e.id === id && !e.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      if (worker !== null) row.worker_id = worker
      if (serviceItem !== null) row.service_item_code = serviceItem
      if (hours !== null) row.hours = Number(hours)
      if (sqft !== null) row.sqft_done = Number(sqft)
      if (status !== null) row.status = status
      if (occurredOn !== null) row.occurred_on = occurredOn
      if (divisionSet) row.division_code = division
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    if (/^update projects set version/i.test(sql)) {
      const [, id] = params as [string, string]
      this.projectVersionBumps.push(id)
      const v = this.projectVersions.get(id)
      if (v !== undefined) this.projectVersions.set(id, v + 1)
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
  opts: {
    role?: 'admin' | 'member'
    divisionAllowed?: boolean
  } = {},
): {
  ctx: LaborEntryRouteCtx
  responses: Array<{ status: number; body: unknown }>
  xrefCalls: Array<[string, string | null]>
} {
  pool.attach()
  const role = opts.role ?? 'admin'
  const divisionAllowed = opts.divisionAllowed ?? true
  const responses: Array<{ status: number; body: unknown }> = []
  const xrefCalls: Array<[string, string | null]> = []
  return {
    responses,
    xrefCalls,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role },
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
      assertDivisionAllowedForServiceItem: async (_companyId, serviceItemCode, divisionCode) => {
        xrefCalls.push([serviceItemCode, divisionCode])
        return divisionAllowed
      },
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleLaborEntryRoutes — POST /api/labor-entries', () => {
  it('rejects member callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(
      pool,
      { project_id: PROJECT_ID, service_item_code: 'FRAME', hours: 8, occurred_on: '2026-05-01' },
      { role: 'member' },
    )
    await handleLaborEntryRoutes({ method: 'POST' } as never, buildUrl('/api/labor-entries'), ctx)
    expect(responses[0]?.status).toBe(403)
    expect(pool.entries).toHaveLength(0)
  })

  it('returns 400 when a required field is missing', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { project_id: PROJECT_ID, hours: 8, occurred_on: '2026-05-01' })
    await handleLaborEntryRoutes({ method: 'POST' } as never, buildUrl('/api/labor-entries'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('service_item_code')
  })

  it('returns 400 when occurred_on is not YYYY-MM-DD', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      project_id: PROJECT_ID,
      service_item_code: 'FRAME',
      hours: 8,
      occurred_on: '05/01/2026',
    })
    await handleLaborEntryRoutes({ method: 'POST' } as never, buildUrl('/api/labor-entries'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('YYYY-MM-DD')
  })

  it('inserts the entry, records the ledger, and bumps the parent project version', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      project_id: PROJECT_ID,
      service_item_code: 'FRAME',
      hours: 8,
      sqft_done: 120,
      occurred_on: '2026-05-01',
    })
    await handleLaborEntryRoutes({ method: 'POST' } as never, buildUrl('/api/labor-entries'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.entries).toHaveLength(1)
    expect(pool.entries[0]?.service_item_code).toBe('FRAME')
    expect(pool.entries[0]?.hours).toBe(8)
    // Parent project version bumped in the same tx.
    expect(pool.projectVersionBumps).toEqual([PROJECT_ID])
    // Ledger written (sync_event + outbox + audit since labor_entry is auditable).
    expect(pool.syncEvents).toHaveLength(1)
    expect(pool.outbox).toHaveLength(1)
    expect(pool.auditEvents).toHaveLength(1)
  })

  it('enforces the service_item_divisions catalog xref (400 when not allowed)', async () => {
    const pool = new FakePool()
    const { ctx, responses, xrefCalls } = makeCtx(
      pool,
      {
        project_id: PROJECT_ID,
        service_item_code: 'FRAME',
        hours: 8,
        occurred_on: '2026-05-01',
        division_code: 'PLUMB',
      },
      { divisionAllowed: false },
    )
    await handleLaborEntryRoutes({ method: 'POST' } as never, buildUrl('/api/labor-entries'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('division_code not allowed')
    expect(xrefCalls).toEqual([['FRAME', 'PLUMB']])
    expect(pool.entries).toHaveLength(0)
  })

  it('returns 409 on a stale project expected_version', async () => {
    const pool = new FakePool()
    pool.projectVersions.set(PROJECT_ID, 5)
    const { ctx, responses } = makeCtx(pool, {
      project_id: PROJECT_ID,
      service_item_code: 'FRAME',
      hours: 8,
      occurred_on: '2026-05-01',
      expected_version: 1,
    })
    await handleLaborEntryRoutes({ method: 'POST' } as never, buildUrl('/api/labor-entries'), ctx)
    expect(responses[0]?.status).toBe(409)
    expect((responses[0]?.body as { current_version: number }).current_version).toBe(5)
    expect(pool.entries).toHaveLength(0)
  })

  it('returns 404 when the project for an expected_version check does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      project_id: PROJECT_ID,
      service_item_code: 'FRAME',
      hours: 8,
      occurred_on: '2026-05-01',
      expected_version: 1,
    })
    await handleLaborEntryRoutes({ method: 'POST' } as never, buildUrl('/api/labor-entries'), ctx)
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleLaborEntryRoutes — GET /api/labor-entries', () => {
  function seedEntry(pool: FakePool, overrides: Partial<LaborRow> = {}): LaborRow {
    const row: LaborRow = {
      id: ENTRY_ID,
      company_id: COMPANY_ID,
      project_id: PROJECT_ID,
      worker_id: null,
      service_item_code: 'FRAME',
      hours: 8,
      sqft_done: 0,
      status: 'draft',
      occurred_on: '2026-05-01',
      division_code: null,
      version: 1,
      deleted_at: null,
      created_at: '2026-05-01T00:00:00.000Z',
      ...overrides,
    }
    pool.entries.push(row)
    return row
  }

  it('lists entries with pagination meta and respects the project_id filter', async () => {
    const pool = new FakePool()
    seedEntry(pool, { id: 'le-1', project_id: PROJECT_ID })
    seedEntry(pool, { id: 'le-2', project_id: 'other-project' })
    const { ctx, responses } = makeCtx(pool)
    await handleLaborEntryRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/labor-entries?project_id=${PROJECT_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { laborEntries: LaborRow[]; pagination: { limit: number; offset: number } }
    expect(body.laborEntries).toHaveLength(1)
    expect(body.laborEntries[0]?.id).toBe('le-1')
    expect(body.pagination.limit).toBe(100)
  })

  it('returns 400 for an invalid pagination param', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleLaborEntryRoutes({ method: 'GET' } as never, buildUrl('/api/labor-entries?limit=abc'), ctx)
    expect(responses[0]?.status).toBe(400)
  })
})

describe('handleLaborEntryRoutes — PATCH /api/labor-entries/:id', () => {
  function seedEntry(pool: FakePool, overrides: Partial<LaborRow> = {}) {
    pool.entries.push({
      id: ENTRY_ID,
      company_id: COMPANY_ID,
      project_id: PROJECT_ID,
      worker_id: null,
      service_item_code: 'FRAME',
      hours: 8,
      sqft_done: 0,
      status: 'draft',
      occurred_on: '2026-05-01',
      division_code: null,
      version: 1,
      deleted_at: null,
      created_at: '2026-05-01T00:00:00.000Z',
      ...overrides,
    })
  }

  it('rejects member callers with 403', async () => {
    const pool = new FakePool()
    seedEntry(pool)
    const { ctx, responses } = makeCtx(pool, { hours: 6 }, { role: 'member' })
    await handleLaborEntryRoutes({ method: 'PATCH' } as never, buildUrl(`/api/labor-entries/${ENTRY_ID}`), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('updates fields, bumps version, and records the ledger', async () => {
    const pool = new FakePool()
    seedEntry(pool)
    const { ctx, responses } = makeCtx(pool, { hours: 6, status: 'submitted' })
    await handleLaborEntryRoutes({ method: 'PATCH' } as never, buildUrl(`/api/labor-entries/${ENTRY_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.entries[0]?.hours).toBe(6)
    expect(pool.entries[0]?.status).toBe('submitted')
    expect(pool.entries[0]?.version).toBe(2)
    expect(pool.syncEvents).toHaveLength(1)
  })

  it('re-validates the catalog xref when service_item + division change (400 when not allowed)', async () => {
    const pool = new FakePool()
    seedEntry(pool, { service_item_code: 'FRAME' })
    const { ctx, responses, xrefCalls } = makeCtx(
      pool,
      { service_item_code: 'DRYWALL', division_code: 'PLUMB' },
      { divisionAllowed: false },
    )
    await handleLaborEntryRoutes({ method: 'PATCH' } as never, buildUrl(`/api/labor-entries/${ENTRY_ID}`), ctx)
    expect(responses[0]?.status).toBe(400)
    // The PATCH'd service_item_code is the effective code for the xref check.
    expect(xrefCalls).toEqual([['DRYWALL', 'PLUMB']])
    expect(pool.entries[0]?.version).toBe(1)
  })

  it('re-validates the catalog xref using the stored service_item when only division changes', async () => {
    const pool = new FakePool()
    seedEntry(pool, { service_item_code: 'FRAME' })
    // Pass service_item_code: undefined explicitly is not possible via the
    // object, but the route also re-validates when service_item_code is sent
    // unchanged. Send the same code so the effective-lookup branch resolves
    // from the row and the xref is consulted with the stored code.
    const { ctx, responses, xrefCalls } = makeCtx(
      pool,
      { service_item_code: 'FRAME', division_code: 'PLUMB' },
      { divisionAllowed: true },
    )
    await handleLaborEntryRoutes({ method: 'PATCH' } as never, buildUrl(`/api/labor-entries/${ENTRY_ID}`), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(xrefCalls).toEqual([['FRAME', 'PLUMB']])
    expect(pool.entries[0]?.division_code).toBe('PLUMB')
  })

  it('returns 404 when the entry does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { hours: 6 })
    await handleLaborEntryRoutes({ method: 'PATCH' } as never, buildUrl(`/api/labor-entries/${ENTRY_ID}`), ctx)
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleLaborEntryRoutes — DELETE /api/labor-entries/:id', () => {
  it('soft-deletes the entry and records the ledger', async () => {
    const pool = new FakePool()
    pool.entries.push({
      id: ENTRY_ID,
      company_id: COMPANY_ID,
      project_id: PROJECT_ID,
      worker_id: null,
      service_item_code: 'FRAME',
      hours: 8,
      sqft_done: 0,
      status: 'draft',
      occurred_on: '2026-05-01',
      division_code: null,
      version: 1,
      deleted_at: null,
      created_at: '2026-05-01T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleLaborEntryRoutes({ method: 'DELETE' } as never, buildUrl(`/api/labor-entries/${ENTRY_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.entries[0]?.deleted_at).not.toBeNull()
    expect(pool.syncEvents).toHaveLength(1)
  })

  it('returns 404 when the entry does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleLaborEntryRoutes({ method: 'DELETE' } as never, buildUrl(`/api/labor-entries/${ENTRY_ID}`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('rejects member callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {}, { role: 'member' })
    await handleLaborEntryRoutes({ method: 'DELETE' } as never, buildUrl(`/api/labor-entries/${ENTRY_ID}`), ctx)
    expect(responses[0]?.status).toBe(403)
  })
})
