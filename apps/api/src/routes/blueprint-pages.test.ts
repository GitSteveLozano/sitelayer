import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import type { BlueprintStorage } from '../storage.js'
import { handleBlueprintPageRoutes, type BlueprintPageRouteCtx } from './blueprint-pages.js'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const BLUEPRINT_ID = '22222222-2222-4222-8222-222222222222'
const PAGE_ID = '33333333-3333-4333-8333-333333333333'

class FakeStorage implements BlueprintStorage {
  backend = 'local-fs' as const
  bucket: string | null = null
  files = new Map<string, Buffer>()
  async put(key: string, contents: Buffer) {
    this.files.set(key, contents)
  }
  async putStream() {
    /* not exercised */
  }
  async get(key: string) {
    const file = this.files.get(key)
    if (!file) throw new Error(`missing file: ${key}`)
    return file
  }
  async copy() {
    /* not exercised */
  }
  async deleteObject() {
    /* not exercised */
  }
  async getDownloadUrl() {
    return null
  }
}

class FakePool {
  pageStoragePath: string | null = `${COMPANY_ID}/${BLUEPRINT_ID}/pages/page-1.png`
  documentStoragePath = `${COMPANY_ID}/${BLUEPRINT_ID}/plan.pdf`
  fileName = 'plan.pdf'

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

    if (/from blueprint_pages p/i.test(sql) && /join blueprint_documents d/i.test(sql)) {
      const [companyId, pageId] = params as [string, string]
      if (companyId !== COMPANY_ID || pageId !== PAGE_ID) return { rows: [], rowCount: 0 }
      return {
        rows: [
          {
            page_number: 1,
            page_storage_path: this.pageStoragePath,
            file_name: this.fileName,
            document_storage_path: this.documentStoragePath,
          },
        ],
        rowCount: 1,
      }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeCtx(
  pool: FakePool,
  storage: FakeStorage,
): {
  ctx: BlueprintPageRouteCtx
  responses: Array<{ status: number; body: unknown }>
  files: Array<{ mimeType: string; fileName: string; content: Buffer | string }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const files: Array<{ mimeType: string; fileName: string; content: Buffer | string }> = []
  return {
    responses,
    files,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', role: 'admin', created_at: '' },
      currentUserId: 'user-1',
      requireRole: () => true,
      readBody: async () => ({}),
      sendJson: (status, body) => responses.push({ status, body }),
      storage,
      blueprintDownloadPresigned: false,
      sendFileContent: (mimeType, fileName, content) => files.push({ mimeType, fileName, content }),
      sendFileRedirect: () => undefined,
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function mockReq(method: string) {
  return { method, headers: {} } as never
}

describe('handleBlueprintPageRoutes — GET /api/blueprint-pages/:id/file', () => {
  it('serves the page image storage object through the authenticated route', async () => {
    const pool = new FakePool()
    const storage = new FakeStorage()
    storage.files.set(`${COMPANY_ID}/${BLUEPRINT_ID}/pages/page-1.png`, Buffer.from('png'))
    const { ctx, files, responses } = makeCtx(pool, storage)

    const handled = await handleBlueprintPageRoutes(
      mockReq('GET'),
      buildUrl(`/api/blueprint-pages/${PAGE_ID}/file`),
      ctx,
    )

    expect(handled).toBe(true)
    expect(responses).toEqual([])
    expect(files).toEqual([{ mimeType: 'image/png', fileName: 'page-1.png', content: Buffer.from('png') }])
  })

  it('falls back to the document file when the page has no rasterized storage object', async () => {
    const pool = new FakePool()
    pool.pageStoragePath = null
    const storage = new FakeStorage()
    storage.files.set(`${COMPANY_ID}/${BLUEPRINT_ID}/plan.pdf`, Buffer.from('pdf'))
    const { ctx, files } = makeCtx(pool, storage)

    await handleBlueprintPageRoutes(mockReq('GET'), buildUrl(`/api/blueprint-pages/${PAGE_ID}/file`), ctx)

    expect(files).toEqual([{ mimeType: 'application/pdf', fileName: 'plan.pdf', content: Buffer.from('pdf') }])
  })

  it('rejects page storage paths outside the active company scope', async () => {
    const pool = new FakePool()
    pool.pageStoragePath = `other-company/${BLUEPRINT_ID}/pages/page-1.png`
    const { ctx, responses, files } = makeCtx(pool, new FakeStorage())

    await handleBlueprintPageRoutes(mockReq('GET'), buildUrl(`/api/blueprint-pages/${PAGE_ID}/file`), ctx)

    expect(files).toEqual([])
    expect(responses).toEqual([
      { status: 400, body: { error: 'blueprint storage_path must stay inside the company scope' } },
    ])
  })
})

/** Fake pool that records the verify UPDATE params + treats the ledger
 * sync_events / mutation_outbox inserts as no-ops, so the verify route can be
 * exercised end-to-end without a real DB. */
class VerifyFakePool {
  updates: Array<{ verified: boolean; verifiedBy: string }> = []
  pageMissing = false

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
    const sql = sqlRaw.trim().toLowerCase()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config') ||
      // Ledger fan-out (recordMutationLedger → sync_events + mutation_outbox).
      sql.includes('into sync_events') ||
      sql.includes('into mutation_outbox')
    ) {
      return { rows: [], rowCount: 0 }
    }

    if (sql.startsWith('update blueprint_pages')) {
      // params: [companyId, pageId, verified, verifiedBy]
      const verified = params[2] === true
      const verifiedBy = String(params[3])
      this.updates.push({ verified, verifiedBy })
      if (this.pageMissing) return { rows: [], rowCount: 0 }
      return {
        rows: [
          {
            id: PAGE_ID,
            company_id: COMPANY_ID,
            blueprint_document_id: BLUEPRINT_ID,
            page_number: 1,
            storage_path: null,
            calibration_world_distance: null,
            calibration_world_unit: null,
            calibration_x1: null,
            calibration_y1: null,
            calibration_x2: null,
            calibration_y2: null,
            calibration_set_at: null,
            calibration_set_by: null,
            scale_verified_at: verified ? '2026-05-31T00:00:00.000Z' : null,
            scale_verified_by: verified ? verifiedBy : null,
            measurement_count: 0,
            origin: 'test',
            created_at: '',
            updated_at: '',
          },
        ],
        rowCount: 1,
      }
    }

    throw new Error(`unexpected SQL in verify fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeVerifyCtx(pool: VerifyFakePool): {
  ctx: BlueprintPageRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', role: 'admin', created_at: '' },
      currentUserId: 'user-1',
      requireRole: () => true,
      readBody: async () => ({}),
      sendJson: (status, body) => responses.push({ status, body }),
      storage: new FakeStorage(),
      blueprintDownloadPresigned: false,
      sendFileContent: () => undefined,
      sendFileRedirect: () => undefined,
    },
  }
}

describe('handleBlueprintPageRoutes — POST /api/blueprint-pages/:id/verify', () => {
  it('persists VERIFIED state (defaults to verified=true) and returns the page', async () => {
    const pool = new VerifyFakePool()
    const { ctx, responses } = makeVerifyCtx(pool)

    const handled = await handleBlueprintPageRoutes(
      mockReq('POST'),
      buildUrl(`/api/blueprint-pages/${PAGE_ID}/verify`),
      ctx,
    )

    expect(handled).toBe(true)
    expect(pool.updates).toEqual([{ verified: true, verifiedBy: 'user-1' }])
    expect(responses).toHaveLength(1)
    expect(responses[0]!.status).toBe(200)
    const body = responses[0]!.body as { page: { scale_verified_at: string | null; scale_verified_by: string | null } }
    expect(body.page.scale_verified_at).toBe('2026-05-31T00:00:00.000Z')
    expect(body.page.scale_verified_by).toBe('user-1')
  })

  it('un-verifies (clears the columns) when body { verified: false }', async () => {
    const pool = new VerifyFakePool()
    const { ctx, responses } = makeVerifyCtx(pool)
    ctx.readBody = async () => ({ verified: false })

    await handleBlueprintPageRoutes(mockReq('POST'), buildUrl(`/api/blueprint-pages/${PAGE_ID}/verify`), ctx)

    expect(pool.updates).toEqual([{ verified: false, verifiedBy: 'user-1' }])
    const body = responses[0]!.body as { page: { scale_verified_at: string | null } }
    expect(responses[0]!.status).toBe(200)
    expect(body.page.scale_verified_at).toBeNull()
  })

  it('400s on a non-uuid page id', async () => {
    const pool = new VerifyFakePool()
    const { ctx, responses } = makeVerifyCtx(pool)

    await handleBlueprintPageRoutes(mockReq('POST'), buildUrl('/api/blueprint-pages/not-a-uuid/verify'), ctx)

    expect(pool.updates).toEqual([])
    expect(responses).toEqual([{ status: 400, body: { error: 'page id must be a valid uuid' } }])
  })

  it('404s when the page does not exist for the company', async () => {
    const pool = new VerifyFakePool()
    pool.pageMissing = true
    const { ctx, responses } = makeVerifyCtx(pool)

    await handleBlueprintPageRoutes(mockReq('POST'), buildUrl(`/api/blueprint-pages/${PAGE_ID}/verify`), ctx)

    expect(responses).toEqual([{ status: 404, body: { error: 'page not found' } }])
  })
})
