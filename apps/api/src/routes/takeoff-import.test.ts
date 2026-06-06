import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleTakeoffImportRoutes, type TakeoffImportRouteCtx } from './takeoff-import.js'

// ---------------------------------------------------------------------------
// CSV/bulk takeoff-import route tests.
//
// POST /api/projects/:id/takeoff/import takes pre-parsed JSON rows (the
// browser handles CSV dialects) and writes one takeoff_measurement +
// one takeoff_measurement_tag per row inside a single tx. We assert the
// role gate, uuid + row validation (per-row error indices), the 1000-row
// cap, the project / page ownership 404s, and the happy-path per-row write
// with the [imported:<label>] notes prefix.
// ---------------------------------------------------------------------------

const COMPANY_ID = 'co-1'
const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const PAGE_ID = '22222222-2222-4222-8222-222222222222'
const DOC_ID = '33333333-3333-4333-8333-333333333333'
const DEFAULT_DRAFT_ID = '44444444-4444-4444-8444-444444444444'

class FakePool {
  projectExists = true
  /** Resolved by resolveDefaultDraftId; null ⇒ project has no active draft (409). */
  defaultDraftId: string | null = DEFAULT_DRAFT_ID
  /** Draft ids that validateDraftId(explicit) treats as belonging to the project. */
  validDraftIds = new Set<string>()
  /** page_id -> blueprint_document_id; null entry = page lookup returns nothing. */
  pages = new Map<string, string | null>()
  measurements: Array<Record<string, unknown>> = []
  tags: Array<Record<string, unknown>> = []
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

    if (/select exists\(select 1 from projects/i.test(sql)) {
      return { rows: [{ exists: this.projectExists }], rowCount: 1 }
    }

    if (/from takeoff_drafts/i.test(sql)) {
      // validateDraftId passes (company, project, id); resolveDefaultDraftId
      // passes only (company, project). Distinguish on param arity.
      if (params.length >= 3) {
        const draftId = params[2] as string
        return this.validDraftIds.has(draftId) ? { rows: [{ id: draftId }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      return this.defaultDraftId ? { rows: [{ id: this.defaultDraftId }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (/from blueprint_pages/i.test(sql)) {
      const [, pageId] = params as [string, string]
      const doc = this.pages.get(pageId)
      return doc ? { rows: [{ blueprint_document_id: doc }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (/^insert into takeoff_measurements/i.test(sql)) {
      this.idCounter += 1
      const id = `meas-${this.idCounter}`
      this.measurements.push({
        id,
        company_id: params[0],
        project_id: params[1],
        blueprint_document_id: params[2],
        page_id: params[3],
        service_item_code: params[4],
        quantity: params[5],
        unit: params[6],
        notes: params[7],
        draft_id: params[8],
      })
      return { rows: [{ id }], rowCount: 1 }
    }

    if (/^insert into takeoff_measurement_tags/i.test(sql)) {
      const id = `tag-${this.tags.length + 1}`
      this.tags.push({
        id,
        company_id: params[0],
        measurement_id: params[1],
        service_item_code: params[2],
        quantity: params[3],
        unit: params[4],
        rate: params[5],
      })
      return { rows: [{ id }], rowCount: 1 }
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
  role: 'admin' | 'member' = 'admin',
): { ctx: TakeoffImportRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role },
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

function buildUrl(projectId: string): URL {
  return new URL(`http://localhost/api/projects/${projectId}/takeoff/import`)
}

describe('handleTakeoffImportRoutes — POST /api/projects/:id/takeoff/import', () => {
  it('returns false for non-import paths so the router falls through', async () => {
    const pool = new FakePool()
    const { ctx } = makeCtx(pool)
    const handled = await handleTakeoffImportRoutes({ method: 'GET' } as never, buildUrl(PROJECT_ID), ctx)
    expect(handled).toBe(false)
  })

  it('rejects member callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { rows: [{ service_item_code: 'FRAME', quantity: 10 }] }, 'member')
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(403)
    expect(pool.measurements).toHaveLength(0)
  })

  it('returns 400 for an invalid project uuid', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { rows: [{ service_item_code: 'FRAME', quantity: 10 }] })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl('not-a-uuid'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('valid uuid')
  })

  it('returns 400 when rows[] is missing or empty', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { rows: [] })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('rows[]')
  })

  it('returns 413 when the import exceeds 1000 rows', async () => {
    const pool = new FakePool()
    const rows = Array.from({ length: 1001 }, () => ({ service_item_code: 'FRAME', quantity: 1 }))
    const { ctx, responses } = makeCtx(pool, { rows })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(413)
  })

  it('returns 400 with the row index when a row has no service_item_code', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      rows: [
        { service_item_code: 'FRAME', quantity: 10 },
        { service_item_code: '', quantity: 5 },
      ],
    })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('rows[1].service_item_code')
    expect(pool.measurements).toHaveLength(0)
  })

  it('returns 400 with the row index for a negative quantity', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      rows: [{ service_item_code: 'FRAME', quantity: -3 }],
    })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('rows[0].quantity')
  })

  it('returns 400 for a non-uuid page_id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      rows: [{ service_item_code: 'FRAME', quantity: 10 }],
      page_id: 'not-a-uuid',
    })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('page_id')
  })

  it('returns 404 when the project does not exist', async () => {
    const pool = new FakePool()
    pool.projectExists = false
    const { ctx, responses } = makeCtx(pool, { rows: [{ service_item_code: 'FRAME', quantity: 10 }] })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(404)
    expect((responses[0]?.body as { error: string }).error).toContain('project not found')
    expect(pool.measurements).toHaveLength(0)
  })

  it('returns 404 when the page_id is not on this project', async () => {
    const pool = new FakePool()
    // page lookup returns nothing.
    const { ctx, responses } = makeCtx(pool, {
      rows: [{ service_item_code: 'FRAME', quantity: 10 }],
      page_id: PAGE_ID,
    })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(404)
    expect((responses[0]?.body as { error: string }).error).toContain('page not found')
  })

  it('writes one measurement + tag per row with the imported notes prefix', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      rows: [
        { service_item_code: 'FRAME', quantity: 12.5, unit: 'lf', rate: 3.25, notes: 'north wall' },
        { service_item_code: 'DRYWALL', quantity: 200 },
      ],
      source_label: 'planswift',
    })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const body = responses[0]?.body as {
      imported: number
      measurements: Array<{ measurement_id: string; tag_id: string }>
      source_label: string
    }
    expect(body.imported).toBe(2)
    expect(body.source_label).toBe('planswift')
    expect(body.measurements).toHaveLength(2)
    expect(pool.measurements).toHaveLength(2)
    expect(pool.tags).toHaveLength(2)
    // First row: explicit unit, rate threads to the tag, notes prefixed.
    expect(pool.measurements[0]?.unit).toBe('lf')
    expect(pool.measurements[0]?.quantity).toBe(12.5)
    expect(pool.measurements[0]?.notes).toBe('[imported:planswift] north wall')
    expect(pool.tags[0]?.rate).toBe(3.25)
    // Second row: defaults — unit 'sqft', rate 0, notes prefix with no suffix.
    expect(pool.measurements[1]?.unit).toBe('sqft')
    expect(pool.measurements[1]?.notes).toBe('[imported:planswift]')
    expect(pool.tags[1]?.rate).toBe(0)
    // Both rows land in the project's resolved default draft (draft_id is
    // NOT NULL on takeoff_measurements post-#270).
    expect(pool.measurements[0]?.draft_id).toBe(DEFAULT_DRAFT_ID)
    expect(pool.measurements[1]?.draft_id).toBe(DEFAULT_DRAFT_ID)
    // One import ledger row (takeoff_import is not auditable, so no audit row).
    expect(pool.syncEvents).toHaveLength(1)
    expect(pool.outbox).toHaveLength(1)
    expect(pool.auditEvents).toHaveLength(0)
  })

  it('returns 409 when the project has no active default draft', async () => {
    const pool = new FakePool()
    pool.defaultDraftId = null
    const { ctx, responses } = makeCtx(pool, { rows: [{ service_item_code: 'FRAME', quantity: 10 }] })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(409)
    expect((responses[0]?.body as { error: string }).error).toContain('default draft')
    expect(pool.measurements).toHaveLength(0)
  })

  it('routes imported rows to an explicit valid draft_id', async () => {
    const pool = new FakePool()
    pool.validDraftIds.add(DEFAULT_DRAFT_ID)
    const { ctx, responses } = makeCtx(pool, {
      rows: [{ service_item_code: 'FRAME', quantity: 10 }],
      draft_id: DEFAULT_DRAFT_ID,
    })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.measurements[0]?.draft_id).toBe(DEFAULT_DRAFT_ID)
  })

  it('returns 400 for an explicit draft_id that does not belong to the project', async () => {
    const pool = new FakePool()
    // validDraftIds intentionally empty ⇒ validateDraftId returns false.
    const { ctx, responses } = makeCtx(pool, {
      rows: [{ service_item_code: 'FRAME', quantity: 10 }],
      draft_id: DEFAULT_DRAFT_ID,
    })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toContain('draft_id does not belong')
    expect(pool.measurements).toHaveLength(0)
  })

  it('threads the resolved blueprint_document_id when a valid page_id is supplied', async () => {
    const pool = new FakePool()
    pool.pages.set(PAGE_ID, DOC_ID)
    const { ctx, responses } = makeCtx(pool, {
      rows: [{ service_item_code: 'FRAME', quantity: 10 }],
      page_id: PAGE_ID,
    })
    await handleTakeoffImportRoutes({ method: 'POST' } as never, buildUrl(PROJECT_ID), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.measurements[0]?.page_id).toBe(PAGE_ID)
    expect(pool.measurements[0]?.blueprint_document_id).toBe(DOC_ID)
  })
})
