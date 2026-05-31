import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleTakeoffDraftRoutes, type TakeoffDraftRouteCtx } from './takeoff-drafts.js'

// ---------------------------------------------------------------------------
// In-memory pg double — covers what the new
// POST /api/projects/:id/takeoff-drafts/:draftId/promote route reads and
// writes. Mirrors the simple stubs other route tests (daily-logs,
// rental-requests) use rather than spinning the dockerised Postgres for a
// pure unit-level path.
//
// Scope: the promote handler issues exactly one `select` against
// takeoff_drafts (gated by company_id + project_id + soft-delete), an
// `insert into takeoff_measurements` per promoted quantity, then the
// recordMutationLedger fan-out (sync_events / mutation_outbox / audit_events).
// Everything else (capture POST, draft CRUD) is exercised by integration
// tests against the real DB.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  drafts: Row[] = []
  measurements: Row[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []
  auditEvents: Row[] = []
  /** (company_id, project_id) -> division_code. Used by the catalog
   *  enforcement path on overrides. */
  projectDivisions = new Map<string, string | null>()
  /** Curated (company_id, service_item_code, division_code) tuples backing
   *  service_item_divisions for the override-catalog enforcement check. */
  serviceItemDivisions: Array<{ company_id: string; service_item_code: string; division_code: string }> = []

  /** (company_id|id) -> { name, deleted } backing the projects JOIN in the
   *  company-wide review feed (GET /api/takeoff-drafts). */
  projects = new Map<string, { name: string; deleted: boolean }>()

  setProject(companyId: string, projectId: string, name: string, deleted = false) {
    this.projects.set(`${companyId}|${projectId}`, { name, deleted })
  }

  setProjectDivision(companyId: string, projectId: string, divisionCode: string | null) {
    this.projectDivisions.set(`${companyId}|${projectId}`, divisionCode)
  }

  seedCatalog(companyId: string, code: string, divisionCode: string) {
    this.serviceItemDivisions.push({ company_id: companyId, service_item_code: code, division_code: divisionCode })
  }

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined, info: () => undefined, error: () => undefined } as unknown as pino.Logger,
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

    // ---- projects: division_code lookup for catalog enforcement ----
    if (/^select division_code from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const key = `${companyId}|${projectId}`
      const divisionCode = this.projectDivisions.has(key) ? (this.projectDivisions.get(key) ?? null) : null
      return { rows: [{ division_code: divisionCode }], rowCount: 1 }
    }

    // ---- service_item_divisions: batch lookup via loadServiceItemCatalogIndex ----
    if (/from service_item_divisions/i.test(sql)) {
      const [companyId, codes] = params as [string, string[]]
      const rows = this.serviceItemDivisions.filter(
        (row) => row.company_id === companyId && codes.includes(row.service_item_code),
      )
      return { rows, rowCount: rows.length }
    }

    // ---- takeoff_drafts: company-wide review feed (GET /api/takeoff-drafts) ----
    // Reproduces the handler's WHERE/JOIN/ORDER from the SQL text + params so
    // we exercise the real filter wiring rather than a hand-rolled mirror.
    if (/from takeoff_drafts d\s+join projects p/i.test(sql)) {
      const companyId = params[0] as string
      // The handler appends `d.source = $2` only when a ?source= filter is set.
      const sourceFilter = /d\.source = \$2/.test(sql) ? (params[1] as string) : null
      const reviewOnly = /d\.review_required = true/.test(sql)
      const rows = this.drafts
        .filter((d) => d.company_id === companyId)
        .filter((d) => d.deleted_at === null)
        .filter((d) => d.source !== 'manual')
        .filter((d) => d.takeoff_result_json != null)
        .filter((d) => (sourceFilter ? d.source === sourceFilter : true))
        .filter((d) => (reviewOnly ? d.review_required === true : true))
        .filter((d) => {
          const proj = this.projects.get(`${companyId}|${d.project_id as string}`)
          return proj != null && !proj.deleted
        })
        .map((d) => {
          const proj = this.projects.get(`${companyId}|${d.project_id as string}`)
          const result = d.takeoff_result_json as { quantities?: unknown[] } | null
          const quantities = result && Array.isArray(result.quantities) ? result.quantities.length : 0
          return {
            id: d.id,
            project_id: d.project_id,
            project_name: proj?.name ?? null,
            name: d.name,
            source: d.source,
            kind: d.kind ?? 'takeoff',
            review_required: d.review_required,
            quantities_count: quantities,
            created_at: d.created_at,
          }
        })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      return { rows, rowCount: rows.length }
    }

    // ---- takeoff_drafts: ownership + stored-result lookup ----
    if (/^select id, takeoff_result_json, source[\s\S]+from takeoff_drafts/i.test(sql)) {
      const [companyId, projectId, draftId] = params as [string, string, string]
      const row = this.drafts.find(
        (d) => d.company_id === companyId && d.project_id === projectId && d.id === draftId && d.deleted_at === null,
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // ---- takeoff_measurements: insert (promote path) ----
    if (/^insert into takeoff_measurements/i.test(sql)) {
      const [companyId, projectId, serviceItemCode, quantity, unit, notes, geometry, draftId] = params as [
        string,
        string,
        string,
        number,
        string,
        string | null,
        string,
        string,
      ]
      const row: Row = {
        id: `m-${this.measurements.length + 1}`,
        project_id: projectId,
        blueprint_document_id: null,
        page_id: null,
        service_item_code: serviceItemCode,
        quantity: String(quantity),
        unit,
        notes,
        geometry: JSON.parse(geometry),
        division_code: null,
        elevation: null,
        image_thumbnail: null,
        draft_id: draftId,
        version: 1,
        deleted_at: null,
        created_at: '2026-05-10T00:00:00.000Z',
        company_id: companyId,
      }
      this.measurements.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // ---- ledger fan-out (recordMutationLedger) ----
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'

type Role = 'admin' | 'foreman' | 'office' | 'member'

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: Role = 'foreman',
  currentUserId = 'user-1',
): { ctx: TakeoffDraftRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role },
      currentUserId,
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

function seedDraftWithResult(
  pool: FakePool,
  overrides: Partial<Row> = {},
  takeoffResultOverrides: Record<string, unknown> = {},
) {
  // Minimal shape — only the fields the promote handler actually reads.
  // (The capture path validates the full TakeoffResult schema before we
  // reach this row, so we lean on that contract.)
  const takeoffResultJson = {
    schemaVersion: '1.0.0',
    takeoffId: '99999999-9999-4999-8999-999999999999',
    projectId: PROJECT_ID,
    capturedAt: '2026-05-10T00:00:00.000Z',
    producedAt: '2026-05-10T00:00:00.000Z',
    source: 'blueprint.vision',
    pipelineVersion: '0.1.0',
    units: 'imperial',
    quantities: [
      {
        id: 'q-floor',
        description: 'Gypsum board ceiling',
        masterformatCode: '09 29 00',
        unit: 'sqft',
        value: 240.5,
        confidence: 0.82,
        provenance: {
          kind: 'blueprint',
          pdfSha256: 'a'.repeat(64),
          pageIndex: 0,
          bbox: [0, 0, 10, 10],
          detector: 'd',
          detectorVersion: '1',
        },
        geometryRefs: ['surface-1'],
      },
      {
        id: 'q-door',
        description: 'Wood door (generic)',
        masterformatCode: '08 14 00',
        unit: 'ea',
        value: 3,
        confidence: 0.65,
        provenance: {
          kind: 'blueprint',
          pdfSha256: 'b'.repeat(64),
          pageIndex: 0,
          bbox: [0, 0, 10, 10],
          detector: 'd',
          detectorVersion: '1',
        },
      },
      // No masterformat/uniformat/omniclass — must be skipped without override.
      {
        id: 'q-orphan',
        description: 'Unclassified',
        unit: 'sqft',
        value: 12,
        confidence: 0.55,
        provenance: { kind: 'manual', userId: 'u' },
      },
    ],
    geometry: {
      surfaces: [
        {
          id: 'surface-1',
          kind: 'floor',
          polygon: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
        },
      ],
    },
    ...takeoffResultOverrides,
  }
  pool.drafts.push({
    id: DRAFT_ID,
    company_id: COMPANY_ID,
    project_id: PROJECT_ID,
    name: 'Capture #1',
    type: 'measurement',
    status: 'active',
    source: 'blueprint_vision',
    review_required: true,
    pipeline_version: '0.1.0',
    takeoff_result_json: takeoffResultJson,
    version: 1,
    deleted_at: null,
    created_at: '2026-05-09T08:00:00.000Z',
    updated_at: '2026-05-09T08:00:00.000Z',
    ...overrides,
  })
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

const PROMOTE_PATH = `/api/projects/${PROJECT_ID}/takeoff-drafts/${DRAFT_ID}/promote`

describe('handleTakeoffDraftRoutes — POST /promote', () => {
  it('promotes selected quantities into takeoff_measurements rows with derived service_item_code', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    const { ctx, responses } = makeCtx(pool, { quantity_ids: ['q-floor', 'q-door'] })

    const handled = await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)

    const body = responses[0]?.body as {
      measurements: Array<Record<string, unknown>>
      promoted_count: number
      skipped_count: number
      skipped: Array<{ quantity_id: string; reason: string }>
    }
    expect(body.promoted_count).toBe(2)
    expect(body.skipped_count).toBe(0)
    expect(body.measurements).toHaveLength(2)
    expect(body.measurements[0]?.service_item_code).toBe('09 29 00')
    expect(body.measurements[0]?.quantity).toBe('240.5')
    expect(body.measurements[0]?.unit).toBe('sqft')
    expect(body.measurements[0]?.draft_id).toBe(DRAFT_ID)
    // Geometry resolves through the captured surface so the canvas can
    // render the promoted polygon without a follow-up fetch.
    const firstGeo = body.measurements[0]?.geometry as Record<string, unknown>
    expect(firstGeo.kind).toBe('capture')
    expect(firstGeo.surfaceId).toBe('surface-1')
    expect(firstGeo.polygon).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
    // Notes embed a provenance trail.
    expect(String(body.measurements[0]?.notes)).toMatch(/promoted from blueprint/i)
    expect(String(body.measurements[0]?.notes)).toMatch(/confidence=0\.82/)
    expect(body.measurements[1]?.service_item_code).toBe('08 14 00')

    // takeoff_result_json on the draft is unchanged — promotion is additive.
    expect(pool.drafts[0]?.takeoff_result_json).toBeTruthy()
    expect(pool.measurements).toHaveLength(2)
    // Mutation ledger fans out once per promoted measurement.
    expect(pool.syncEvents).toHaveLength(2)
    expect(pool.outbox).toHaveLength(2)
    expect(pool.auditEvents).toHaveLength(2)
  })

  it('honors per-quantity service_item_code overrides', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    // Override codes must exist in the curated catalog now (matches takeoff-write).
    pool.seedCatalog(COMPANY_ID, '09 29 00.10', 'D9')
    const { ctx, responses } = makeCtx(pool, {
      quantity_ids: ['q-floor'],
      service_item_code_overrides: { 'q-floor': '09 29 00.10' },
    })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const body = responses[0]?.body as { measurements: Array<Record<string, unknown>> }
    expect(body.measurements[0]?.service_item_code).toBe('09 29 00.10')
  })

  it('skips quantities with no derivable service_item_code and reports them', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    const { ctx, responses } = makeCtx(pool, { quantity_ids: ['q-floor', 'q-orphan'] })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status).toBe(201)
    const body = responses[0]?.body as {
      promoted_count: number
      skipped_count: number
      skipped: Array<{ quantity_id: string; reason: string }>
    }
    expect(body.promoted_count).toBe(1)
    expect(body.skipped_count).toBe(1)
    expect(body.skipped[0]?.quantity_id).toBe('q-orphan')
    expect(body.skipped[0]?.reason).toMatch(/no service_item_code/i)
  })

  it('skipped quantities can be salvaged via an override', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    pool.seedCatalog(COMPANY_ID, '01 00 00', 'D1')
    const { ctx, responses } = makeCtx(pool, {
      quantity_ids: ['q-orphan'],
      service_item_code_overrides: { 'q-orphan': '01 00 00' },
    })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const body = responses[0]?.body as { promoted_count: number; skipped_count: number }
    expect(body.promoted_count).toBe(1)
    expect(body.skipped_count).toBe(0)
  })

  it('returns 400 when quantity_ids is missing or empty', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    const { ctx, responses } = makeCtx(pool, {})

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toMatch(/quantity_ids/i)
  })

  it('returns 400 when quantity_ids contains only blank strings', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    const { ctx, responses } = makeCtx(pool, { quantity_ids: ['', '   '] })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 400 when project id is not a uuid', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    const { ctx, responses } = makeCtx(pool, { quantity_ids: ['q-floor'] })

    await handleTakeoffDraftRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/not-a-uuid/takeoff-drafts/${DRAFT_ID}/promote`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 404 when draft is missing or hidden by tenant isolation', async () => {
    const pool = new FakePool()
    // Seed under a *different* company — same project/draft ids must
    // resolve to 404 for our requester.
    seedDraftWithResult(pool, { company_id: OTHER_COMPANY_ID })
    const { ctx, responses } = makeCtx(pool, { quantity_ids: ['q-floor'] })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status).toBe(404)
    expect((responses[0]?.body as { error: string }).error).toMatch(/draft not found/i)
    expect(pool.measurements).toHaveLength(0)
  })

  it('returns 404 when the draft exists but has no captured TakeoffResult', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool, { takeoff_result_json: null })
    const { ctx, responses } = makeCtx(pool, { quantity_ids: ['q-floor'] })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status).toBe(404)
    expect((responses[0]?.body as { error: string }).error).toMatch(/no captured/i)
    expect(pool.measurements).toHaveLength(0)
  })

  it('returns 422 when every selected quantity has to be skipped', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    const { ctx, responses } = makeCtx(pool, { quantity_ids: ['q-orphan', 'q-missing'] })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status).toBe(422)
    const body = responses[0]?.body as { skipped: Array<{ quantity_id: string; reason: string }> }
    expect(body.skipped.map((s) => s.quantity_id).sort()).toEqual(['q-missing', 'q-orphan'])
    // No measurements written because no row prepared cleanly.
    expect(pool.measurements).toHaveLength(0)
  })

  it('forbids requesters whose role is not admin/foreman/office', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    const { ctx, responses } = makeCtx(pool, { quantity_ids: ['q-floor'] }, 'member')

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status).toBe(403)
    expect(pool.measurements).toHaveLength(0)
  })

  it('rejects malformed service_item_code_overrides (non-object)', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    const { ctx, responses } = makeCtx(pool, {
      quantity_ids: ['q-floor'],
      service_item_code_overrides: ['09 29 00'],
    })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  // ---- override-path curated catalog enforcement (PR follow-up) ------------
  // The AI-derived quantity codes intentionally bypass the
  // service_item_divisions gate so capture proposals can flow into the review
  // queue. An explicit operator override is the inverse case: treat it as if
  // it had been typed straight into takeoff-write.ts and reject anything that
  // isn't in the curated catalog.
  it('promotes when override matches a curated catalog code', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    pool.seedCatalog(COMPANY_ID, '09 29 00.10', 'D9')
    const { ctx, responses } = makeCtx(pool, {
      quantity_ids: ['q-floor'],
      service_item_code_overrides: { 'q-floor': '09 29 00.10' },
    })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const body = responses[0]?.body as {
      measurements: Array<Record<string, unknown>>
      promoted_count: number
    }
    expect(body.promoted_count).toBe(1)
    expect(body.measurements[0]?.service_item_code).toBe('09 29 00.10')
    expect(pool.measurements).toHaveLength(1)
  })

  it('returns 422 when override targets a code missing from the curated catalog', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    // Catalog deliberately empty — the override must be rejected before any
    // insert lands in takeoff_measurements.
    const { ctx, responses } = makeCtx(pool, {
      quantity_ids: ['q-floor'],
      service_item_code_overrides: { 'q-floor': 'BOGUS 99 99' },
    })

    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), ctx)
    expect(responses[0]?.status).toBe(422)
    const body = responses[0]?.body as {
      error: string
      rejected: Array<{ quantity_id: string; service_item_code: string; reason: string }>
      rejected_codes: string[]
    }
    expect(body.error).toMatch(/curated catalog/i)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0]?.quantity_id).toBe('q-floor')
    expect(body.rejected[0]?.service_item_code).toBe('BOGUS 99 99')
    expect(body.rejected_codes).toEqual(['BOGUS 99 99'])
    // No measurements written and no ledger entries fired — the rejection
    // happens before the mutation tx.
    expect(pool.measurements).toHaveLength(0)
    expect(pool.syncEvents).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
    expect(pool.auditEvents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/takeoff-drafts — company-wide AI-takeoff review feed.
// ---------------------------------------------------------------------------

const FEED_PATH = '/api/takeoff-drafts'

type FeedRow = {
  id: string
  project_id: string
  project_name: string
  name: string
  source: string
  kind: string
  review_required: boolean
  quantities_count: number
  created_at: string
}

/** Push a feed-shaped draft row. Defaults to a review-required
 *  blueprint_vision draft with a 2-quantity stored result. */
function seedFeedDraft(pool: FakePool, overrides: Partial<Row> = {}) {
  pool.drafts.push({
    id: `draft-${pool.drafts.length + 1}`,
    company_id: COMPANY_ID,
    project_id: PROJECT_ID,
    name: `Capture #${pool.drafts.length + 1}`,
    type: 'measurement',
    kind: 'takeoff',
    status: 'active',
    source: 'blueprint_vision',
    review_required: true,
    pipeline_version: '0.1.0',
    takeoff_result_json: { quantities: [{ id: 'q1' }, { id: 'q2' }] },
    version: 1,
    deleted_at: null,
    created_at: '2026-05-09T08:00:00.000Z',
    updated_at: '2026-05-09T08:00:00.000Z',
    ...overrides,
  })
}

describe('handleTakeoffDraftRoutes — GET /api/takeoff-drafts (company feed)', () => {
  it('lists capture drafts across projects with project_name + quantities_count', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Maple Tower')
    seedFeedDraft(pool)
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(FEED_PATH), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { drafts: FeedRow[] }
    expect(body.drafts).toHaveLength(1)
    expect(body.drafts[0]?.project_name).toBe('Maple Tower')
    expect(body.drafts[0]?.source).toBe('blueprint_vision')
    expect(body.drafts[0]?.quantities_count).toBe(2)
    expect(body.drafts[0]?.review_required).toBe(true)
  })

  it('surfaces the draft kind (count vs takeoff) so the queue can route review', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'P')
    seedFeedDraft(pool, { id: 'takeoff-draft', kind: 'takeoff', created_at: '2026-05-20T00:00:00.000Z' })
    seedFeedDraft(pool, { id: 'count-draft', kind: 'count', created_at: '2026-05-10T00:00:00.000Z' })
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(FEED_PATH), ctx)
    const body = responses[0]?.body as { drafts: FeedRow[] }
    const byId = new Map(body.drafts.map((d) => [d.id, d.kind]))
    expect(byId.get('takeoff-draft')).toBe('takeoff')
    expect(byId.get('count-draft')).toBe('count')
  })

  it('orders newest-first by created_at', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'P')
    seedFeedDraft(pool, { id: 'older', created_at: '2026-05-01T00:00:00.000Z' })
    seedFeedDraft(pool, { id: 'newer', created_at: '2026-05-20T00:00:00.000Z' })
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(FEED_PATH), ctx)
    const body = responses[0]?.body as { drafts: FeedRow[] }
    expect(body.drafts.map((d) => d.id)).toEqual(['newer', 'older'])
  })

  it('excludes manual drafts, drafts without a stored result, and soft-deleted ones', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'P')
    seedFeedDraft(pool, { id: 'keep' })
    seedFeedDraft(pool, { id: 'manual', source: 'manual' })
    seedFeedDraft(pool, { id: 'no-result', takeoff_result_json: null })
    seedFeedDraft(pool, { id: 'deleted', deleted_at: '2026-05-10T00:00:00.000Z' })
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(FEED_PATH), ctx)
    const body = responses[0]?.body as { drafts: FeedRow[] }
    expect(body.drafts.map((d) => d.id)).toEqual(['keep'])
  })

  it('hides drafts whose project has been soft-deleted', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Gone', true)
    seedFeedDraft(pool)
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(FEED_PATH), ctx)
    const body = responses[0]?.body as { drafts: FeedRow[] }
    expect(body.drafts).toHaveLength(0)
  })

  it('filters by ?source=', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'P')
    seedFeedDraft(pool, { id: 'bp', source: 'blueprint_vision' })
    seedFeedDraft(pool, { id: 'drone', source: 'drone' })
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(`${FEED_PATH}?source=blueprint_vision`), ctx)
    const body = responses[0]?.body as { drafts: FeedRow[] }
    expect(body.drafts.map((d) => d.id)).toEqual(['bp'])
  })

  it('filters by ?review_required=1', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'P')
    seedFeedDraft(pool, { id: 'flagged', review_required: true })
    seedFeedDraft(pool, { id: 'clean', review_required: false })
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(`${FEED_PATH}?review_required=1`), ctx)
    const body = responses[0]?.body as { drafts: FeedRow[] }
    expect(body.drafts.map((d) => d.id)).toEqual(['flagged'])
  })

  it('returns 400 for an unknown ?source= value', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(`${FEED_PATH}?source=manual`), ctx)
    expect(responses[0]?.status).toBe(400)
    expect((responses[0]?.body as { error: string }).error).toMatch(/source must be one of/i)
  })

  it('only returns the requesting tenant drafts', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Mine')
    pool.setProject(OTHER_COMPANY_ID, PROJECT_ID, 'Theirs')
    seedFeedDraft(pool, { id: 'mine' })
    seedFeedDraft(pool, { id: 'theirs', company_id: OTHER_COMPANY_ID })
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(FEED_PATH), ctx)
    const body = responses[0]?.body as { drafts: FeedRow[] }
    expect(body.drafts.map((d) => d.id)).toEqual(['mine'])
  })
})
