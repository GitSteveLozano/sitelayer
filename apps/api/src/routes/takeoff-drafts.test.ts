import { afterEach, describe, expect, it } from 'vitest'
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
  corrections: Row[] = []
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

  /** Latest-blueprint lookup the live gemini capture path resolves its
   *  storage input from. */
  blueprintDocs: Array<{ company_id: string; project_id: string; storage_path: string; file_name: string }> = []

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

    // ---- projects: tenancy existence check (capture POST) ----
    if (/^select id from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const proj = this.projects.get(`${companyId}|${projectId}`)
      const rows = proj && !proj.deleted ? [{ id: projectId }] : []
      return { rows, rowCount: rows.length }
    }

    // ---- blueprint_documents: latest-blueprint lookup (live gemini enqueue) ----
    if (/^select storage_path, file_name from blueprint_documents/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const rows = this.blueprintDocs.filter((b) => b.company_id === companyId && b.project_id === projectId)
      const latest = rows[rows.length - 1]
      return {
        rows: latest ? [{ storage_path: latest.storage_path, file_name: latest.file_name }] : [],
        rowCount: latest ? 1 : 0,
      }
    }

    // ---- takeoff_drafts: capture insert (sync 'ready' + async 'processing') ----
    if (/^insert into takeoff_drafts \([\s\S]*source, takeoff_result_json/i.test(sql)) {
      const isLive = /'processing'/.test(sql)
      const base = {
        id: `draft-${this.drafts.length + 1}`,
        type: 'measurement',
        status: 'active',
        takeoff_result_blob_uri: null,
        capture_error: null,
        capture_token_usage: null,
        version: 1,
        deleted_at: null,
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      }
      let row: Row
      if (isLive) {
        const [companyId, projectId, name, draftKind, kind] = params as [string, string, string, string, string]
        row = {
          ...base,
          company_id: companyId,
          project_id: projectId,
          name,
          kind: draftKind,
          source: kind,
          takeoff_result_json: null,
          review_required: false,
          pipeline_version: null,
          count_scope_json: null,
          capture_status: 'processing',
          capture_provenance: null,
        }
      } else {
        const [
          companyId,
          projectId,
          name,
          draftKind,
          kind,
          resultJson,
          reviewRequired,
          pipelineVersion,
          countScope,
          provenance,
        ] = params as [string, string, string, string, string, string, boolean, string, string | null, string]
        row = {
          ...base,
          company_id: companyId,
          project_id: projectId,
          name,
          kind: draftKind,
          source: kind,
          takeoff_result_json: JSON.parse(resultJson),
          review_required: reviewRequired,
          pipeline_version: pipelineVersion,
          count_scope_json: countScope ? JSON.parse(countScope) : null,
          capture_status: 'ready',
          capture_provenance: provenance,
        }
      }
      this.drafts.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // ---- takeoff_drafts: result poll (GET /api/takeoff-drafts/:id/result) ----
    if (/^select takeoff_result_json, source, review_required, pipeline_version,\s*capture_status/i.test(sql)) {
      const [companyId, draftId] = params as [string, string]
      const d = this.drafts.find((r) => r.company_id === companyId && r.id === draftId && r.deleted_at === null)
      if (!d) return { rows: [], rowCount: 0 }
      return {
        rows: [
          {
            takeoff_result_json: d.takeoff_result_json ?? null,
            source: d.source,
            review_required: d.review_required ?? false,
            pipeline_version: d.pipeline_version ?? null,
            capture_status: d.capture_status ?? 'ready',
            capture_provenance: d.capture_provenance ?? null,
            capture_error: d.capture_error ?? null,
            capture_token_usage: d.capture_token_usage ?? null,
          },
        ],
        rowCount: 1,
      }
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

    // ---- takeoff_ai_corrections: insert (promote flywheel, gap G2) ----
    if (/^insert into takeoff_ai_corrections/i.test(sql)) {
      const [
        company_id,
        project_id,
        draft_id,
        measurement_id,
        quantity_id,
        source,
        ai_value,
        ai_unit,
        ai_confidence,
        ai_service_item_code,
        ai_quantity_kind,
        ai_detector,
        ai_detector_version,
        ai_quantity_json,
        final_value,
        final_unit,
        final_service_item_code,
        service_item_code_changed,
        created_by_user_id,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        number,
        string,
        number | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        number,
        string,
        string,
        boolean,
        string | null,
      ]
      this.corrections.push({
        company_id,
        project_id,
        draft_id,
        measurement_id,
        quantity_id,
        decision: 'kept',
        source,
        ai_value,
        ai_unit,
        ai_confidence,
        ai_service_item_code,
        ai_quantity_kind,
        ai_detector,
        ai_detector_version,
        ai_quantity_json,
        final_value,
        final_unit,
        final_service_item_code,
        service_item_code_changed,
        value_changed: false,
        created_by_user_id,
      })
      return { rows: [], rowCount: 1 }
    }
    // ---- takeoff_ai_corrections: read (GET .../takeoff-ai-corrections) ----
    if (/from takeoff_ai_corrections/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const changedOnly = /service_item_code_changed or value_changed/i.test(sql)
      const rows = this.corrections
        .filter((r) => r.company_id === companyId && r.project_id === projectId)
        .filter((r) => (changedOnly ? Boolean(r.service_item_code_changed) || Boolean(r.value_changed) : true))
      return { rows, rowCount: rows.length }
    }

    // ---- ledger fan-out (recordMutationLedger) ----
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      // Emulate the real ON CONFLICT (company_id, idempotency_key) upsert so
      // the capture tests can assert the stable per-draft idempotency key
      // collapses replayed enqueues onto one row. recordMutationOutbox binds
      // company_id at $1 and idempotency_key at $8.
      const key = `${String(params[0])}|${String(params[7])}`
      const existing = this.outbox.find((r) => {
        const p = r.params as unknown[]
        return `${String(p[0])}|${String(p[7])}` === key
      })
      if (existing) {
        existing.params = params
        return { rows: [], rowCount: 1 }
      }
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
    // Flywheel (gap G2): each promoted quantity captured an AI-vs-final
    // correction row. No code was overridden here, so each kept its AI-derived
    // code and the correction is marked unchanged — but the immutable AI
    // proposal (value/confidence/detector) is preserved as training data.
    expect(pool.corrections).toHaveLength(2)
    const floorCorr = pool.corrections.find((c) => c.quantity_id === 'q-floor') as Record<string, unknown>
    expect(floorCorr.ai_service_item_code).toBe('09 29 00')
    expect(floorCorr.final_service_item_code).toBe('09 29 00')
    expect(floorCorr.service_item_code_changed).toBe(false)
    expect(floorCorr.ai_value).toBe(240.5)
    expect(floorCorr.final_value).toBe(240.5)
    expect(floorCorr.ai_confidence).toBe(0.82)
    expect(floorCorr.ai_detector).toBe('d')
    expect(floorCorr.measurement_id).toBe('m-1')
    expect(floorCorr.source).toBe('blueprint_vision')
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
    // Flywheel (gap G2): the operator reclassified the AI's code — the
    // highest-signal correction. The row pairs the AI-derived code with the
    // human-final code and flags the change for training.
    expect(pool.corrections).toHaveLength(1)
    const corr = pool.corrections[0] as Record<string, unknown>
    expect(corr.ai_service_item_code).toBe('09 29 00')
    expect(corr.final_service_item_code).toBe('09 29 00.10')
    expect(corr.service_item_code_changed).toBe(true)
  })

  it('exposes the captured corrections via GET, with a changed_only filter', async () => {
    const pool = new FakePool()
    seedDraftWithResult(pool)
    pool.seedCatalog(COMPANY_ID, '09 29 00.10', 'D9')
    // Promote two: q-door keeps its AI code; q-floor is reclassified (override).
    const promote = makeCtx(pool, {
      quantity_ids: ['q-floor', 'q-door'],
      service_item_code_overrides: { 'q-floor': '09 29 00.10' },
    })
    await handleTakeoffDraftRoutes({ method: 'POST' } as never, buildUrl(PROMOTE_PATH), promote.ctx)
    expect(promote.responses[0]?.status, JSON.stringify(promote.responses[0]?.body)).toBe(201)

    // Full list returns both corrections.
    const all = makeCtx(pool, {})
    await handleTakeoffDraftRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/takeoff-ai-corrections`),
      all.ctx,
    )
    const allBody = all.responses[0]?.body as { corrections: Array<Record<string, unknown>>; count: number }
    expect(allBody.count).toBe(2)

    // changed_only returns just the reclassified one.
    const changed = makeCtx(pool, {})
    await handleTakeoffDraftRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/takeoff-ai-corrections?changed_only=1`),
      changed.ctx,
    )
    const changedBody = changed.responses[0]?.body as { corrections: Array<Record<string, unknown>>; count: number }
    expect(changedBody.count).toBe(1)
    expect(changedBody.corrections[0]?.quantity_id).toBe('q-floor')
    expect(changedBody.corrections[0]?.service_item_code_changed).toBe(true)
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

// ---------------------------------------------------------------------------
// POST /api/projects/:id/takeoff-drafts/capture — async split (2026-06-12).
//
// LIVE blueprint_vision captures return a 202 'processing' draft and enqueue
// exactly ONE dedicated takeoff_capture_pipeline outbox row (stable per-draft
// idempotency key); the deterministic dry-run stub stays synchronous (201)
// with honest 'stub-dry-run' provenance. The provider call itself is covered
// by packages/pipe-blueprint/src/live-capture.test.ts and the worker runner
// tests (apps/worker/src/runners/takeoff-capture.test.ts).
// ---------------------------------------------------------------------------
const CAPTURE_PATH = `/api/projects/${PROJECT_ID}/takeoff-drafts/capture`

type CaptureOutboxRow = { mutationType: string; idempotencyKey: string; payload: Record<string, unknown> }

function captureOutboxRows(pool: FakePool): CaptureOutboxRow[] {
  // recordMutationOutbox binds: $1 company, $4 entity_type, $5 entity_id,
  // $6 mutation_type, $7 payload (json string), $8 idempotency_key.
  return pool.outbox
    .map((r) => r.params as unknown[])
    .map((p) => ({
      mutationType: String(p[5]),
      idempotencyKey: String(p[7]),
      payload: JSON.parse(String(p[6])) as Record<string, unknown>,
    }))
    .filter((r) => r.mutationType === 'takeoff_capture_pipeline')
}

const captureReq = { method: 'POST', headers: {} } as never

describe('handleTakeoffDraftRoutes — POST capture (async split)', () => {
  afterEach(() => {
    delete process.env.BLUEPRINT_VISION_MODE
    delete process.env.GEMINI_API_KEY
  })

  it('dry-run stays synchronous: 201 ready draft, stub-dry-run provenance, NO pipeline enqueue', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Maple Tower')
    const { ctx, responses } = makeCtx(pool, { kind: 'blueprint_vision', payload: { dryRun: true } })

    const handled = await handleTakeoffDraftRoutes(captureReq, buildUrl(CAPTURE_PATH), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const body = responses[0]?.body as {
      draft: Record<string, unknown>
      result_summary: Record<string, unknown>
    }
    expect(body.draft.capture_status).toBe('ready')
    expect(body.draft.capture_provenance).toBe('stub-dry-run')
    expect(body.result_summary.status).toBe('ready')
    expect(body.result_summary.provenance).toBe('stub-dry-run')
    expect(body.result_summary.mode).toBe('dry-run')
    expect(body.result_summary.quantities_count).toBeGreaterThan(0)
    // No dedicated pipeline row — only the generic 'create' ledger anchor.
    expect(captureOutboxRows(pool)).toHaveLength(0)
  })

  it('no-provider env behaves like dry-run even without payload.dryRun (no keys ⇒ no live call)', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Maple Tower')
    const { ctx, responses } = makeCtx(pool, { kind: 'blueprint_vision', payload: {} })

    await handleTakeoffDraftRoutes(captureReq, buildUrl(CAPTURE_PATH), ctx)
    expect(responses[0]?.status).toBe(201)
    const body = responses[0]?.body as { draft: Record<string, unknown> }
    expect(body.draft.capture_status).toBe('ready')
    expect(body.draft.capture_provenance).toBe('stub-dry-run')
    expect(captureOutboxRows(pool)).toHaveLength(0)
  })

  it('LIVE gemini capture: 202 processing draft + exactly one enqueue with a stable per-draft key', async () => {
    process.env.BLUEPRINT_VISION_MODE = 'gemini'
    process.env.GEMINI_API_KEY = 'test-key'
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Maple Tower')
    pool.blueprintDocs.push({
      company_id: COMPANY_ID,
      project_id: PROJECT_ID,
      storage_path: `${COMPANY_ID}/bp-1/plan.pdf`,
      file_name: 'plan.pdf',
    })
    const { ctx, responses } = makeCtx(pool, { kind: 'blueprint_vision', payload: {} })

    await handleTakeoffDraftRoutes(captureReq, buildUrl(CAPTURE_PATH), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(202)
    const body = responses[0]?.body as {
      draft: Record<string, unknown>
      result_summary: Record<string, unknown>
    }
    expect(body.draft.capture_status).toBe('processing')
    expect(body.draft.takeoff_result_json).toBeNull()
    expect(body.draft.capture_provenance).toBeNull()
    expect(body.result_summary.status).toBe('processing')
    expect(body.result_summary.provider).toBe('gemini')

    const rows = captureOutboxRows(pool)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.idempotencyKey).toBe(`takeoff_capture:run:${body.draft.id as string}`)
    expect(rows[0]!.payload).toMatchObject({
      draft_id: body.draft.id,
      project_id: PROJECT_ID,
      kind: 'blueprint_vision',
      provider: 'gemini',
      storage_path: `${COMPANY_ID}/bp-1/plan.pdf`,
    })
  })

  it('re-POST is a fresh draft with its own single enqueue; same-key replays collapse onto one row', async () => {
    process.env.BLUEPRINT_VISION_MODE = 'gemini'
    process.env.GEMINI_API_KEY = 'test-key'
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Maple Tower')
    pool.blueprintDocs.push({
      company_id: COMPANY_ID,
      project_id: PROJECT_ID,
      storage_path: `${COMPANY_ID}/bp-1/plan.pdf`,
      file_name: 'plan.pdf',
    })

    const first = makeCtx(pool, { kind: 'blueprint_vision', payload: {} })
    await handleTakeoffDraftRoutes(captureReq, buildUrl(CAPTURE_PATH), first.ctx)
    const second = makeCtx(pool, { kind: 'blueprint_vision', payload: {} })
    await handleTakeoffDraftRoutes(captureReq, buildUrl(CAPTURE_PATH), second.ctx)

    const rows = captureOutboxRows(pool)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2)
    // Each draft has exactly one pipeline row.
    for (const draft of pool.drafts) {
      expect(rows.filter((r) => r.payload.draft_id === draft.id)).toHaveLength(1)
    }
    // A replayed enqueue with the SAME key (worker crash / retry) upserts the
    // existing row instead of creating a second unit of work.
    const replayParams = pool.outbox.find((r) => String((r.params as unknown[])[5]) === 'takeoff_capture_pipeline')!
      .params as unknown[]
    await pool.query(
      `insert into mutation_outbox (company_id, device_id, actor_user_id, entity_type, entity_id, mutation_type, payload, idempotency_key, status) values (...) on conflict do update`,
      replayParams,
    )
    expect(captureOutboxRows(pool)).toHaveLength(2)
  })

  it('LIVE gemini with no blueprint on file falls back to the synchronous stub with honest provenance', async () => {
    process.env.BLUEPRINT_VISION_MODE = 'gemini'
    process.env.GEMINI_API_KEY = 'test-key'
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Maple Tower')
    const { ctx, responses } = makeCtx(pool, { kind: 'blueprint_vision', payload: {} })

    await handleTakeoffDraftRoutes(captureReq, buildUrl(CAPTURE_PATH), ctx)
    expect(responses[0]?.status).toBe(201)
    const body = responses[0]?.body as { draft: Record<string, unknown> }
    expect(body.draft.capture_status).toBe('ready')
    expect(body.draft.capture_provenance).toBe('stub-dry-run')
    expect(captureOutboxRows(pool)).toHaveLength(0)
  })

  it('count-scope captures stay synchronous even with a live provider configured', async () => {
    process.env.BLUEPRINT_VISION_MODE = 'gemini'
    process.env.GEMINI_API_KEY = 'test-key'
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Maple Tower')
    pool.blueprintDocs.push({
      company_id: COMPANY_ID,
      project_id: PROJECT_ID,
      storage_path: `${COMPANY_ID}/bp-1/plan.pdf`,
      file_name: 'plan.pdf',
    })
    const { ctx, responses } = makeCtx(pool, {
      kind: 'blueprint_vision',
      draft_kind: 'count',
      payload: { count_scope: { symbol: { label: 'Outlet' }, sheets: ['M-101'], sensitivity: 'NORMAL' } },
    })

    await handleTakeoffDraftRoutes(captureReq, buildUrl(CAPTURE_PATH), ctx)
    expect(responses[0]?.status).toBe(201)
    const body = responses[0]?.body as { draft: Record<string, unknown> }
    expect(body.draft.capture_provenance).toBe('stub-dry-run')
    expect(captureOutboxRows(pool)).toHaveLength(0)
  })

  it('non-AI pipelines (roomplan et al) report deterministic provenance', async () => {
    const pool = new FakePool()
    pool.setProject(COMPANY_ID, PROJECT_ID, 'Maple Tower')
    const { ctx, responses } = makeCtx(pool, {
      kind: 'roomplan',
      payload: {
        capturedRoomJsonUri: 'scenario://room.json',
        capturedRoomJson: {
          version: 1,
          identifier: 'room-1',
          walls: [
            {
              identifier: 'wall-1',
              category: 'wall',
              confidence: 'high',
              dimensions: [4, 2.4, 0.1],
              transform: [
                [1, 0, 0, 0],
                [0, 1, 0, 0],
                [0, 0, 1, 0],
                [2, 1.2, 0, 1],
              ],
            },
          ],
        },
      },
    })

    await handleTakeoffDraftRoutes(captureReq, buildUrl(CAPTURE_PATH), ctx)
    // 201 deterministic parse (or 422 if the fixture shape is rejected — the
    // assertion below pins the 201 contract).
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const body = responses[0]?.body as { draft: Record<string, unknown>; result_summary: Record<string, unknown> }
    expect(body.draft.capture_provenance).toBe('deterministic')
    expect(body.result_summary.provenance).toBe('deterministic')
    expect(captureOutboxRows(pool)).toHaveLength(0)
  })
})

describe('handleTakeoffDraftRoutes — GET /api/takeoff-drafts/:id/result (poll-until-ready)', () => {
  it('reports processing with a null result while the worker owns the draft', async () => {
    const pool = new FakePool()
    seedFeedDraft(pool, {
      id: DRAFT_ID,
      takeoff_result_json: null,
      capture_status: 'processing',
      capture_provenance: null,
    })
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(`/api/takeoff-drafts/${DRAFT_ID}/result`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as Record<string, unknown>
    expect(body.status).toBe('processing')
    expect(body.takeoff_result).toBeNull()
  })

  it('surfaces a failed capture with the provider error and zero fabricated rows', async () => {
    const pool = new FakePool()
    seedFeedDraft(pool, {
      id: DRAFT_ID,
      takeoff_result_json: null,
      capture_status: 'failed',
      capture_error: 'gemini gemini-3.1-flash-lite returned HTTP 429: quota',
      capture_provenance: null,
    })
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(`/api/takeoff-drafts/${DRAFT_ID}/result`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as Record<string, unknown>
    expect(body.status).toBe('failed')
    expect(body.error).toMatch(/HTTP 429/)
    expect(body.takeoff_result).toBeNull()
  })

  it('returns the result with provenance + token usage once ready', async () => {
    const pool = new FakePool()
    seedFeedDraft(pool, {
      id: DRAFT_ID,
      capture_status: 'ready',
      capture_provenance: 'gemini-live',
      capture_token_usage: {
        provider: 'gemini',
        model: 'gemini-3.1-flash-lite',
        input_tokens: 1234,
        output_tokens: 88,
      },
    })
    const { ctx, responses } = makeCtx(pool)

    await handleTakeoffDraftRoutes({ method: 'GET' } as never, buildUrl(`/api/takeoff-drafts/${DRAFT_ID}/result`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as Record<string, unknown>
    expect(body.status).toBe('ready')
    expect(body.provenance).toBe('gemini-live')
    expect(body.token_usage).toMatchObject({ input_tokens: 1234, output_tokens: 88 })
    expect(body.takeoff_result).toBeTruthy()
  })
})
