import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleBlueprintRoutes, type BlueprintRouteCtx } from './blueprints.js'
import type { BlueprintStorage } from '../storage.js'

// ---------------------------------------------------------------------------
// blueprint_documents CRUD + version-copy. Multipart upload paths are
// covered by a dedicated integration test against busboy; here we exercise
// the JSON body / metadata flow and the version-copy fan-out that drives
// the in-tx takeoff_measurements batched-insert (N+1 fix).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakeStorage implements BlueprintStorage {
  backend = 'local-fs' as const
  bucket: string | null = null
  files = new Map<string, Buffer>()
  copies: Array<{ from: string; to: string }> = []
  deletes: string[] = []

  async put(key: string, contents: Buffer) {
    this.files.set(key, contents)
  }
  async putStream() {
    /* not exercised */
  }
  async get(key: string) {
    return this.files.get(key) ?? Buffer.from('blueprint')
  }
  async copy(sourceKey: string, destKey: string) {
    this.copies.push({ from: sourceKey, to: destKey })
    const data = this.files.get(sourceKey)
    if (data) this.files.set(destKey, data)
  }
  async deleteObject(key: string) {
    this.deletes.push(key)
    this.files.delete(key)
  }
  async getDownloadUrl() {
    return null
  }
}

class FakePool {
  blueprints: Array<{
    id: string
    company_id: string
    project_id: string
    file_name: string
    storage_path: string
    preview_type: string
    calibration_length: string | null
    calibration_unit: string | null
    sheet_scale: string | null
    version: number
    deleted_at: string | null
    replaces_blueprint_document_id: string | null
    created_at: string
  }> = []
  measurements: Array<{
    id: string
    company_id: string
    project_id: string
    blueprint_document_id: string
    service_item_code: string
    quantity: string
    unit: string
    notes: string | null
    geometry: unknown
    division_code: string | null
    deleted_at: string | null
    created_at: string
  }> = []
  syncEvents: Row[] = []
  outbox: Array<{ mutation_type: string; entity_type: string; entity_id: string }> = []
  auditEvents: Row[] = []
  queryLog: string[] = []
  private nextMeasurementId = 1

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
    this.queryLog.push(sql)
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // List per project
    if (/from blueprint_documents/i.test(sql) && /order by version desc/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const rows = this.blueprints
        .filter((b) => b.company_id === companyId && b.project_id === projectId && !b.deleted_at)
        .map((b) => ({ ...b, file_url: `/api/blueprints/${b.id}/file` }))
      return { rows, rowCount: rows.length }
    }

    // Version next select
    if (/coalesce\(max\(version\), 0\) \+ 1/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const matching = this.blueprints.filter((b) => b.company_id === companyId && b.project_id === projectId)
      const max = matching.reduce((m, b) => Math.max(m, b.version), 0)
      return { rows: [{ version: max + 1 }], rowCount: 1 }
    }

    // Source select for version copy
    if (
      /from blueprint_documents/i.test(sql) &&
      /select id, project_id, file_name, storage_path/i.test(sql) &&
      /id = \$2/i.test(sql)
    ) {
      const [companyId, id] = params as [string, string]
      const row = this.blueprints.find((b) => b.company_id === companyId && b.id === id && !b.deleted_at)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // Get file metadata
    if (/select file_name, storage_path from blueprint_documents/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.blueprints.find((b) => b.company_id === companyId && b.id === id && !b.deleted_at)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // Insert
    if (/^\s*insert into blueprint_documents/i.test(sql)) {
      const [
        id,
        companyId,
        projectId,
        fileName,
        storagePath,
        previewType,
        calLength,
        calUnit,
        sheetScale,
        version,
        replacesId,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
        string | null,
      ]
      const row = {
        id,
        company_id: companyId,
        project_id: projectId,
        file_name: fileName,
        storage_path: storagePath,
        preview_type: previewType ?? 'storage_path',
        calibration_length: calLength,
        calibration_unit: calUnit,
        sheet_scale: sheetScale,
        version,
        deleted_at: null,
        replaces_blueprint_document_id: replacesId,
        created_at: new Date().toISOString(),
      }
      this.blueprints.push(row)
      return {
        rows: [{ ...row, file_url: `/api/blueprints/${row.id}/file` }],
        rowCount: 1,
      }
    }

    // PATCH update
    if (/^update blueprint_documents/i.test(sql) && /set\s+file_name\s*=/i.test(sql)) {
      const [companyId, id, fileName, storagePath, previewType, calLength, calUnit, sheetScale, expectedVersion] =
        params as [
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          number | null,
        ]
      const row = this.blueprints.find((b) => b.company_id === companyId && b.id === id && !b.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      if (expectedVersion != null && row.version !== expectedVersion) return { rows: [], rowCount: 0 }
      if (fileName !== null) row.file_name = fileName
      if (storagePath !== null) row.storage_path = storagePath
      if (previewType !== null) row.preview_type = previewType
      if (calLength !== null) row.calibration_length = calLength
      if (calUnit !== null) row.calibration_unit = calUnit
      if (sheetScale !== null) row.sheet_scale = sheetScale
      row.version += 1
      return {
        rows: [{ ...row, file_url: `/api/blueprints/${row.id}/file` }],
        rowCount: 1,
      }
    }

    // DELETE soft-delete
    if (/^update blueprint_documents/i.test(sql) && /set deleted_at\s*=\s*now\(\)/i.test(sql)) {
      const [companyId, id, expectedVersion] = params as [string, string, number | null]
      const row = this.blueprints.find((b) => b.company_id === companyId && b.id === id && !b.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      if (expectedVersion != null && row.version !== expectedVersion) return { rows: [], rowCount: 0 }
      row.deleted_at = new Date().toISOString()
      row.version += 1
      return { rows: [{ ...row, file_url: `/api/blueprints/${row.id}/file` }], rowCount: 1 }
    }

    // takeoff_measurements: source select for version copy
    if (/from takeoff_measurements/i.test(sql) && /select project_id, service_item_code/i.test(sql)) {
      const [companyId, sourceBlueprintId] = params as [string, string]
      const rows = this.measurements.filter(
        (m) => m.company_id === companyId && m.blueprint_document_id === sourceBlueprintId && !m.deleted_at,
      )
      return { rows, rowCount: rows.length }
    }

    // takeoff_measurements: batched insert for version copy (N+1 fix)
    if (/^\s*insert into takeoff_measurements/i.test(sql) && /from unnest/i.test(sql)) {
      const [
        companyId,
        blueprintId,
        projectIds,
        serviceItemCodes,
        quantities,
        units,
        notesArr,
        geometries,
        divisionCodes,
      ] = params as [string, string, string[], string[], string[], string[], string[], string[], Array<string | null>]
      for (let i = 0; i < projectIds.length; i += 1) {
        this.measurements.push({
          id: `m-${this.nextMeasurementId++}`,
          company_id: companyId,
          project_id: projectIds[i]!,
          blueprint_document_id: blueprintId,
          service_item_code: serviceItemCodes[i]!,
          quantity: quantities[i]!,
          unit: units[i]!,
          notes: notesArr[i] ?? null,
          geometry: JSON.parse(geometries[i] ?? '{}'),
          division_code: divisionCodes[i] ?? null,
          deleted_at: null,
          created_at: new Date().toISOString(),
        })
      }
      return { rows: [], rowCount: projectIds.length }
    }

    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({
        entity_type: params[3] as string,
        entity_id: params[4] as string,
        mutation_type: params[5] as string,
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const BLUEPRINT_ID = '22222222-2222-4222-8222-222222222222'

function makeCtx(
  pool: FakePool,
  storage: FakeStorage,
  body: Record<string, unknown> = {},
  role: 'admin' | 'foreman' | 'member' = 'admin',
  companyOverride?: { id: string; slug: string; name?: string },
): { ctx: BlueprintRouteCtx; responses: Array<{ status: number; body: unknown }>; redirects: string[] } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const redirects: string[] = []
  const company = companyOverride
    ? { id: companyOverride.id, slug: companyOverride.slug, name: companyOverride.name ?? companyOverride.slug }
    : { id: 'co-1', slug: 'co', name: 'Co' }
  return {
    responses,
    redirects,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: company.id, slug: company.slug, name: company.name, created_at: '', role },
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
      checkVersion: async (_table, _where, params, expectedVersion) => {
        const id = params[1] as string
        const row = pool.blueprints.find((b) => b.id === id && !b.deleted_at)
        if (!row) return true
        if (expectedVersion != null && row.version !== expectedVersion) {
          responses.push({ status: 409, body: { error: 'version conflict', current_version: row.version } })
          return false
        }
        return true
      },
      storage,
      maxBlueprintUploadBytes: 200 * 1024 * 1024,
      blueprintDownloadPresigned: false,
      sendFileContent: () => {
        responses.push({ status: 200, body: { kind: 'file' } })
      },
      sendFileRedirect: (location) => {
        redirects.push(location)
      },
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function mockReq(method: string) {
  // The route handler probes req.headers['content-type'] via the
  // multipart-detect helper. Always non-multipart in these tests.
  return { method, headers: {} } as never
}

describe('handleBlueprintRoutes — GET /api/projects/:id/blueprints', () => {
  it('returns the active blueprints for the project', async () => {
    const pool = new FakePool()
    pool.blueprints.push({
      id: 'b-1',
      company_id: 'co-1',
      project_id: PROJECT_ID,
      file_name: 'plan.pdf',
      storage_path: 'co-1/b-1/plan.pdf',
      preview_type: 'storage_path',
      calibration_length: null,
      calibration_unit: null,
      sheet_scale: null,
      version: 1,
      deleted_at: null,
      replaces_blueprint_document_id: null,
      created_at: '2026-05-01T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, new FakeStorage())
    await handleBlueprintRoutes(mockReq('GET'), buildUrl(`/api/projects/${PROJECT_ID}/blueprints`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { blueprints: Array<{ id: string; file_url: string }> }
    expect(body.blueprints).toHaveLength(1)
    expect(body.blueprints[0]?.file_url).toBe('/api/blueprints/b-1/file')
  })
})

describe('handleBlueprintRoutes — POST /api/projects/:id/blueprints', () => {
  it('rejects member callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, new FakeStorage(), { file_name: 'a.pdf' }, 'member')
    await handleBlueprintRoutes(mockReq('POST'), buildUrl(`/api/projects/${PROJECT_ID}/blueprints`), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('400s when neither file_name nor file_contents_base64 is supplied', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, new FakeStorage(), {})
    await handleBlueprintRoutes(mockReq('POST'), buildUrl(`/api/projects/${PROJECT_ID}/blueprints`), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('persists the blueprint metadata, base64 contents, and starts at version 1', async () => {
    const pool = new FakePool()
    const storage = new FakeStorage()
    const { ctx, responses } = makeCtx(pool, storage, {
      file_name: 'plan.pdf',
      file_contents_base64: Buffer.from('hello').toString('base64'),
      preview_type: 'pdf',
    })
    await handleBlueprintRoutes(mockReq('POST'), buildUrl(`/api/projects/${PROJECT_ID}/blueprints`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.blueprints).toHaveLength(1)
    expect(pool.blueprints[0]?.version).toBe(1)
    // Storage actually received the file.
    const persisted = Array.from(storage.files.values())[0]
    expect(persisted?.toString()).toBe('hello')
  })
})

describe('handleBlueprintRoutes — PATCH /api/blueprints/:id', () => {
  it('updates metadata, bumps version, and returns 200', async () => {
    const pool = new FakePool()
    pool.blueprints.push({
      id: BLUEPRINT_ID,
      company_id: 'co-1',
      project_id: PROJECT_ID,
      file_name: 'plan.pdf',
      storage_path: 'co-1/' + BLUEPRINT_ID + '/plan.pdf',
      preview_type: 'storage_path',
      calibration_length: null,
      calibration_unit: null,
      sheet_scale: null,
      version: 1,
      deleted_at: null,
      replaces_blueprint_document_id: null,
      created_at: '',
    })
    const { ctx, responses } = makeCtx(pool, new FakeStorage(), {
      calibration_length: '12.5',
      calibration_unit: 'ft',
    })
    await handleBlueprintRoutes(mockReq('PATCH'), buildUrl(`/api/blueprints/${BLUEPRINT_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.blueprints[0]?.calibration_length).toBe('12.5')
    expect(pool.blueprints[0]?.version).toBe(2)
  })

  it('returns 404 for an unknown blueprint', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, new FakeStorage(), { calibration_length: '1' })
    await handleBlueprintRoutes(mockReq('PATCH'), buildUrl(`/api/blueprints/${BLUEPRINT_ID}`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('returns 409 on expected_version mismatch', async () => {
    const pool = new FakePool()
    pool.blueprints.push({
      id: BLUEPRINT_ID,
      company_id: 'co-1',
      project_id: PROJECT_ID,
      file_name: 'plan.pdf',
      storage_path: 'co-1/x/plan.pdf',
      preview_type: 'storage_path',
      calibration_length: null,
      calibration_unit: null,
      sheet_scale: null,
      version: 4,
      deleted_at: null,
      replaces_blueprint_document_id: null,
      created_at: '',
    })
    const { ctx, responses } = makeCtx(pool, new FakeStorage(), {
      calibration_length: '12.5',
      expected_version: 1,
    })
    await handleBlueprintRoutes(mockReq('PATCH'), buildUrl(`/api/blueprints/${BLUEPRINT_ID}`), ctx)
    expect(responses[0]?.status).toBe(409)
  })
})

describe('handleBlueprintRoutes — POST /api/blueprints/:id/versions', () => {
  it('copies the source blueprint into a new version and batches the measurement copy in one insert', async () => {
    const pool = new FakePool()
    const storage = new FakeStorage()
    storage.files.set('co-1/' + BLUEPRINT_ID + '/plan.pdf', Buffer.from('contents'))
    pool.blueprints.push({
      id: BLUEPRINT_ID,
      company_id: 'co-1',
      project_id: PROJECT_ID,
      file_name: 'plan.pdf',
      storage_path: 'co-1/' + BLUEPRINT_ID + '/plan.pdf',
      preview_type: 'storage_path',
      calibration_length: null,
      calibration_unit: null,
      sheet_scale: null,
      version: 1,
      deleted_at: null,
      replaces_blueprint_document_id: null,
      created_at: '',
    })
    for (let i = 0; i < 5; i += 1) {
      pool.measurements.push({
        id: `m-src-${i}`,
        company_id: 'co-1',
        project_id: PROJECT_ID,
        blueprint_document_id: BLUEPRINT_ID,
        service_item_code: 'D4-PAINT',
        quantity: '100',
        unit: 'sqft',
        notes: null,
        geometry: { points: [] },
        division_code: 'D4',
        deleted_at: null,
        created_at: '',
      })
    }

    const { ctx, responses } = makeCtx(pool, storage, {})
    await handleBlueprintRoutes(mockReq('POST'), buildUrl(`/api/blueprints/${BLUEPRINT_ID}/versions`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    // One new blueprint at version 2.
    expect(pool.blueprints.filter((b) => b.replaces_blueprint_document_id === BLUEPRINT_ID)).toHaveLength(1)
    expect(pool.blueprints.find((b) => b.replaces_blueprint_document_id === BLUEPRINT_ID)?.version).toBe(2)
    // All 5 source measurements copied into the new blueprint via the
    // batched unnest insert — no per-row inserts.
    const newBlueprintId = pool.blueprints.find((b) => b.replaces_blueprint_document_id === BLUEPRINT_ID)?.id ?? ''
    expect(pool.measurements.filter((m) => m.blueprint_document_id === newBlueprintId)).toHaveLength(5)
    // N+1 guard: count the takeoff_measurements INSERT calls in the SQL
    // dispatch log — must be 1, not 5. This assertion would have caught
    // the pre-fix per-row INSERT loop.
    const insertCount = pool.queryLog.filter((sql) => /^insert into takeoff_measurements/i.test(sql)).length
    expect(insertCount).toBe(1)
  })

  it('returns 404 when the source blueprint does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, new FakeStorage(), {})
    await handleBlueprintRoutes(mockReq('POST'), buildUrl(`/api/blueprints/${BLUEPRINT_ID}/versions`), ctx)
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleBlueprintRoutes — GET /api/blueprints/:id/file cross-company isolation', () => {
  it('returns 404 (not the file body) when company B requests company A blueprint', async () => {
    // Seed two companies. Company A owns a blueprint; company B should not
    // be able to read it via the file endpoint. The route filters every
    // SELECT by company_id, so the row is structurally invisible — but
    // the access-control guarantee is load-bearing for blueprint PDFs
    // (customer addresses, contract terms; see CLAUDE.md "Blueprint storage
    // hygiene" rule #3) so we lock the behavior with this test.
    const pool = new FakePool()
    const storage = new FakeStorage()
    const companyAId = 'co-a'
    const blueprintId = 'b-from-co-a'
    const storageKey = `${companyAId}/${blueprintId}/plan.pdf`
    pool.blueprints.push({
      id: blueprintId,
      company_id: companyAId,
      project_id: PROJECT_ID,
      file_name: 'plan.pdf',
      storage_path: storageKey,
      preview_type: 'storage_path',
      calibration_length: null,
      calibration_unit: null,
      sheet_scale: null,
      version: 1,
      deleted_at: null,
      replaces_blueprint_document_id: null,
      created_at: '2026-05-01T00:00:00.000Z',
    })
    storage.files.set(storageKey, Buffer.from('confidential blueprint contents'))

    // Request the file as company B (different id + slug).
    const { ctx, responses } = makeCtx(pool, storage, {}, 'admin', { id: 'co-b', slug: 'company-b' })
    await handleBlueprintRoutes(mockReq('GET'), buildUrl(`/api/blueprints/${blueprintId}/file`), ctx)

    expect(responses).toHaveLength(1)
    expect(responses[0]?.status).toBe(404)
    const body = responses[0]?.body as { error?: string }
    expect(body.error).toBe('blueprint not found')
    // Defense-in-depth: even if the SELECT somehow returned the row, the
    // sendFileContent path would have been invoked. Assert it was NOT — no
    // response body carries the blueprint contents.
    expect(responses.find((r) => (r.body as { kind?: string })?.kind === 'file')).toBeUndefined()
  })

  it('returns the file body when the owning company requests it', async () => {
    // Sanity check: the same setup with the owning company resolves the file.
    const pool = new FakePool()
    const storage = new FakeStorage()
    const companyAId = 'co-a'
    const blueprintId = 'b-from-co-a'
    const storageKey = `${companyAId}/${blueprintId}/plan.pdf`
    pool.blueprints.push({
      id: blueprintId,
      company_id: companyAId,
      project_id: PROJECT_ID,
      file_name: 'plan.pdf',
      storage_path: storageKey,
      preview_type: 'storage_path',
      calibration_length: null,
      calibration_unit: null,
      sheet_scale: null,
      version: 1,
      deleted_at: null,
      replaces_blueprint_document_id: null,
      created_at: '2026-05-01T00:00:00.000Z',
    })
    storage.files.set(storageKey, Buffer.from('confidential blueprint contents'))

    const { ctx, responses } = makeCtx(pool, storage, {}, 'admin', { id: companyAId, slug: 'company-a' })
    await handleBlueprintRoutes(mockReq('GET'), buildUrl(`/api/blueprints/${blueprintId}/file`), ctx)

    expect(responses).toHaveLength(1)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { kind?: string })?.kind).toBe('file')
  })
})

describe('handleBlueprintRoutes — DELETE /api/blueprints/:id', () => {
  it('soft-deletes the blueprint and bumps version', async () => {
    const pool = new FakePool()
    pool.blueprints.push({
      id: BLUEPRINT_ID,
      company_id: 'co-1',
      project_id: PROJECT_ID,
      file_name: 'plan.pdf',
      storage_path: '',
      preview_type: 'storage_path',
      calibration_length: null,
      calibration_unit: null,
      sheet_scale: null,
      version: 2,
      deleted_at: null,
      replaces_blueprint_document_id: null,
      created_at: '',
    })
    const { ctx, responses } = makeCtx(pool, new FakeStorage())
    await handleBlueprintRoutes(mockReq('DELETE'), buildUrl(`/api/blueprints/${BLUEPRINT_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.blueprints[0]?.deleted_at).not.toBeNull()
    expect(pool.blueprints[0]?.version).toBe(3)
  })
})
