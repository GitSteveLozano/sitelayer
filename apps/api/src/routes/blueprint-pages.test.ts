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
