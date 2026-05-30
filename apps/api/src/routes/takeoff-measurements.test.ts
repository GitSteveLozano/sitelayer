import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleTakeoffMeasurementRoutes, type TakeoffMeasurementRouteCtx } from './takeoff-measurements.js'

// ---------------------------------------------------------------------------
// PlanSwift Phase 2: PATCH /api/takeoff/measurements/:id assembly attach.
//
// Focused on the new `assembly_id` validation + conditional column write:
//   - assembly_id: <active uuid>  → attach, 200
//   - assembly_id: <unknown uuid> → 404 (no cross-company / deleted attach)
//   - assembly_id: <bad uuid>     → 400
//   - assembly_id: null           → detach, 200
//   - assembly_id absent          → column left unchanged
// ---------------------------------------------------------------------------

const COMPANY_ID = 'co-1'
const MEASUREMENT_ID = '11111111-1111-4111-8111-111111111111'
const ASSEMBLY_ID = '22222222-2222-4222-8222-222222222222'

type MeasurementRow = {
  id: string
  company_id: string
  project_id: string
  assembly_id: string | null
  version: number
  deleted_at: string | null
}

class FakePool {
  measurement: MeasurementRow = {
    id: MEASUREMENT_ID,
    company_id: COMPANY_ID,
    project_id: 'p-1',
    assembly_id: null,
    version: 3,
    deleted_at: null,
  }
  /** active assembly ids for the company. */
  assemblies = new Set<string>([ASSEMBLY_ID])

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

  private row() {
    return {
      id: this.measurement.id,
      project_id: this.measurement.project_id,
      blueprint_document_id: null,
      page_id: null,
      service_item_code: 'EIFS',
      quantity: '1000',
      unit: 'sqft',
      notes: null,
      geometry: {},
      elevation: null,
      is_deduction: false,
      assembly_id: this.measurement.assembly_id,
      version: this.measurement.version,
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    if (/^(begin|commit|rollback)/i.test(sql) || /^select set_config/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    // assembly existence check
    if (/^select id from service_item_assemblies/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const ok = companyId === COMPANY_ID && this.assemblies.has(id)
      return { rows: ok ? [{ id }] : [], rowCount: ok ? 1 : 0 }
    }
    // the UPDATE
    if (/^update takeoff_measurements/i.test(sql)) {
      // params order matches the route: ..., $13 attachAssembly, $14 nextAssemblyId
      const attachAssembly = params[12] as boolean
      const nextAssemblyId = params[13] as string | null
      if (attachAssembly) this.measurement.assembly_id = nextAssemblyId
      this.measurement.version += 1
      return { rows: [this.row()], rowCount: 1 }
    }
    if (/^insert into (sync_events|mutation_outbox|audit_events)/i.test(sql)) {
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeCtx(pool: FakePool) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  const ctx: TakeoffMeasurementRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role: 'admin' },
    requireRole: () => true,
    readBody: async () => (reads.shift() ?? {}) as Record<string, unknown>,
    sendJson: (status, body) => {
      responses.push({ status, body })
    },
    checkVersion: async () => true,
    assertBlueprintDocumentsBelongToProject: async () => undefined,
  }
  return { ctx, responses, reads }
}

const url = (p: string) => new URL(`http://localhost${p}`)

describe('PATCH /api/takeoff/measurements/:id assembly attach', () => {
  it('attaches a valid active assembly', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ assembly_id: ASSEMBLY_ID })
    const handled = await handleTakeoffMeasurementRoutes(
      { method: 'PATCH', headers: {} } as never,
      url(`/api/takeoff/measurements/${MEASUREMENT_ID}`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect(pool.measurement.assembly_id).toBe(ASSEMBLY_ID)
  })

  it('detaches when assembly_id is null', async () => {
    const pool = new FakePool()
    pool.measurement.assembly_id = ASSEMBLY_ID
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ assembly_id: null })
    await handleTakeoffMeasurementRoutes(
      { method: 'PATCH', headers: {} } as never,
      url(`/api/takeoff/measurements/${MEASUREMENT_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect(pool.measurement.assembly_id).toBeNull()
  })

  it('404s on an unknown/cross-company assembly id', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    const unknown = '99999999-9999-4999-8999-999999999999'
    reads.push({ assembly_id: unknown })
    await handleTakeoffMeasurementRoutes(
      { method: 'PATCH', headers: {} } as never,
      url(`/api/takeoff/measurements/${MEASUREMENT_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
    expect(pool.measurement.assembly_id).toBeNull()
  })

  it('400s on a malformed assembly uuid', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ assembly_id: 'not-a-uuid' })
    await handleTakeoffMeasurementRoutes(
      { method: 'PATCH', headers: {} } as never,
      url(`/api/takeoff/measurements/${MEASUREMENT_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('leaves assembly_id unchanged when absent from the body (patches another field)', async () => {
    const pool = new FakePool()
    pool.measurement.assembly_id = ASSEMBLY_ID
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ notes: 'just a note edit' })
    await handleTakeoffMeasurementRoutes(
      { method: 'PATCH', headers: {} } as never,
      url(`/api/takeoff/measurements/${MEASUREMENT_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect(pool.measurement.assembly_id).toBe(ASSEMBLY_ID)
  })
})
