import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Readable } from 'node:stream'
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleWorkerIssueRoutes, type WorkerIssueRouteCtx } from './worker-issues.js'
import type { BlueprintStorage, DownloadUrlOptions, PutStreamOptions } from '../storage.js'

/**
 * Worker-issue attachment route tests.
 *
 * Drives the route handler through a real HTTP server so the multipart
 * Busboy parser actually runs. The DB is a fake pg-shaped pool that
 * answers just the queries the attachment routes issue. Storage is an
 * in-memory map that captures the streamed bytes so the upload+download
 * round trip can be asserted against the same Buffer payload.
 */

// ---------------------------------------------------------------------------
// MemoryStorage — reuses the shape from blueprint-upload.test.ts.
// ---------------------------------------------------------------------------

class MemoryStorage implements BlueprintStorage {
  backend = 'local-fs' as const
  bucket = null
  files = new Map<string, Buffer>()
  mimes = new Map<string, string>()

  async put(key: string, contents: Buffer, contentType?: string) {
    this.files.set(key, contents)
    if (contentType) this.mimes.set(key, contentType)
  }

  async putStream(key: string, body: Readable, options?: PutStreamOptions) {
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    }
    this.files.set(key, Buffer.concat(chunks))
    if (options?.contentType) this.mimes.set(key, options.contentType)
  }

  async get(key: string) {
    const buf = this.files.get(key)
    if (!buf) throw new Error(`missing ${key}`)
    return buf
  }

  async copy(sourceKey: string, destKey: string) {
    const buf = this.files.get(sourceKey)
    if (!buf) throw new Error(`missing ${sourceKey}`)
    this.files.set(destKey, buf)
  }

  async getDownloadUrl(_key: string, _options?: DownloadUrlOptions) {
    return null
  }
}

// ---------------------------------------------------------------------------
// FakePool — answers the SQL the attachment routes issue.
// ---------------------------------------------------------------------------

type IssueRow = { id: string; company_id: string }
type AttachmentRow = {
  id: string
  company_id: string
  worker_issue_id: string
  kind: 'voice' | 'photo'
  storage_key: string
  mime_type: string
  size_bytes: number
  created_at: string
}

class FakePool {
  issues: IssueRow[] = []
  attachments: AttachmentRow[] = []
  outbox: unknown[] = []
  syncEvents: unknown[] = []
  // Auto-incrementing UUIDs simulated as `att-1`, `att-2`, ...
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

    // Issue lookup before accepting upload bytes.
    if (/^select\s+id\s+from\s+worker_issues/i.test(sql)) {
      const [companyId, issueId] = params as [string, string]
      const row = this.issues.find((r) => r.company_id === companyId && r.id === issueId)
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
    }

    // Issue full-row select used after attachment insert.
    if (/^select[\s\S]+from\s+worker_issues/i.test(sql)) {
      const [companyId, issueId] = params as [string, string]
      const row = this.issues.find((r) => r.company_id === companyId && r.id === issueId)
      return {
        rows: row ? [{ ...row, kind: 'safety', message: 'test', created_at: 'now' }] : [],
        rowCount: row ? 1 : 0,
      }
    }

    // Voice replacement: delete any existing voice attachment.
    if (/^delete\s+from\s+worker_issue_attachments/i.test(sql)) {
      const [companyId, issueId] = params as [string, string]
      const before = this.attachments.length
      this.attachments = this.attachments.filter(
        (a) => !(a.company_id === companyId && a.worker_issue_id === issueId && a.kind === 'voice'),
      )
      return { rows: [], rowCount: before - this.attachments.length }
    }

    // Insert attachment.
    if (/^insert\s+into\s+worker_issue_attachments/i.test(sql)) {
      const [companyId, workerIssueId, kind, storageKey, mimeType, sizeBytes] = params as [
        string,
        string,
        'voice' | 'photo',
        string,
        string,
        number,
      ]
      this.idCounter += 1
      const row: AttachmentRow = {
        id: `att-${this.idCounter}`,
        company_id: companyId,
        worker_issue_id: workerIssueId,
        kind,
        storage_key: storageKey,
        mime_type: mimeType,
        size_bytes: Number(sizeBytes),
        created_at: new Date().toISOString(),
      }
      this.attachments.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // Attachment list / lookup-by-key.
    if (/^select[\s\S]+from\s+worker_issue_attachments/i.test(sql)) {
      const companyId = params[0] as string
      const issueId = params[1] as string
      if (params.length >= 3) {
        const storageKey = params[2] as string
        const row = this.attachments.find(
          (a) => a.company_id === companyId && a.worker_issue_id === issueId && a.storage_key === storageKey,
        )
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      const rows = this.attachments
        .filter((a) => a.company_id === companyId && a.worker_issue_id === issueId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      return { rows, rowCount: rows.length }
    }

    // recordMutationLedger inserts — just record them, don't validate.
    if (/^insert\s+into\s+sync_events/i.test(sql)) {
      this.syncEvents.push(params)
      return { rows: [], rowCount: 1 }
    }
    if (/^insert\s+into\s+mutation_outbox/i.test(sql)) {
      this.outbox.push(params)
      return { rows: [], rowCount: 1 }
    }
    if (/^insert\s+into\s+audit_events/i.test(sql)) {
      // worker_issue_attachment isn't in the auditable set, so this
      // shouldn't actually fire — keep a no-op handler defensively.
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

// ---------------------------------------------------------------------------
// HTTP harness — wraps handleWorkerIssueRoutes in a tiny http.Server so the
// multipart parser runs against a real socket.
// ---------------------------------------------------------------------------

let pool: FakePool
let storage: MemoryStorage
let server: http.Server
let port: number

function makeCtx(): WorkerIssueRouteCtx {
  return {
    pool: pool as unknown as Pool,
    company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'foreman' as const },
    currentUserId: 'u-1',
    requireRole: () => true,
    readBody: async () => ({}),
    sendJson: () => undefined, // overridden per-request below
    storage,
    maxAttachmentBytes: 1024,
    attachmentDownloadPresigned: false,
    sendFileContent: () => undefined,
    sendFileRedirect: () => undefined,
  }
}

beforeAll(async () => {
  pool = new FakePool()
  storage = new MemoryStorage()
  pool.attach()
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const ctx: WorkerIssueRouteCtx = {
      ...makeCtx(),
      sendJson: (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      },
      sendFileContent: (mime: string, fileName: string, content: Buffer | string) => {
        res.writeHead(200, {
          'content-type': mime,
          'content-disposition': `inline; filename="${fileName}"`,
        })
        res.end(content)
      },
      sendFileRedirect: (location: string) => {
        res.writeHead(302, { location })
        res.end()
      },
    }
    handleWorkerIssueRoutes(req, url, ctx)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not handled' }))
        }
      })
      .catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message ?? 'error' }))
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  pool.issues = []
  pool.attachments = []
  pool.outbox = []
  pool.syncEvents = []
  storage.files.clear()
  storage.mimes.clear()
})

// ---------------------------------------------------------------------------
// Multipart helpers.
// ---------------------------------------------------------------------------

function buildMultipartBody(
  parts: Array<
    | { kind: 'field'; name: string; value: string }
    | { kind: 'file'; name: string; filename: string; mime: string; body: Buffer }
  >,
  boundary: string,
): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    if (part.kind === 'field') {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`))
      chunks.push(Buffer.from(part.value))
      chunks.push(Buffer.from('\r\n'))
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.mime}\r\n\r\n`,
        ),
      )
      chunks.push(part.body)
      chunks.push(Buffer.from('\r\n'))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

function postMultipart(
  path: string,
  parts: Parameters<typeof buildMultipartBody>[0],
): Promise<{ status: number; body: unknown }> {
  const boundary = `----test-${Math.random().toString(36).slice(2)}`
  const body = buildMultipartBody(parts, boundary)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        },
      },
      (res) => {
        const buf: Buffer[] = []
        res.on('data', (c) => buf.push(c as Buffer))
        res.on('end', () => {
          const text = Buffer.concat(buf).toString('utf8')
          let parsed: unknown = text
          try {
            parsed = JSON.parse(text)
          } catch {
            // leave as text
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function getRequest(path: string): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path }, (res) => {
      const buf: Buffer[] = []
      res.on('data', (c) => buf.push(c as Buffer))
      res.on('end', () => {
        const data = Buffer.concat(buf)
        const ct = res.headers['content-type'] ?? ''
        let parsed: unknown = data
        if (ct.toString().includes('application/json')) {
          try {
            parsed = JSON.parse(data.toString('utf8'))
          } catch {
            parsed = data.toString('utf8')
          }
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

const ISSUE_ID = '11111111-1111-4111-8111-111111111111'

function seedIssue() {
  pool.issues.push({ id: ISSUE_ID, company_id: 'co-1' })
}

describe('POST /api/worker-issues/:id/attachments', () => {
  it('uploads a photo, persists the attachment row, and stores the bytes', async () => {
    seedIssue()
    const photoBytes = Buffer.from('FAKE-JPEG-BYTES')
    const result = await postMultipart(`/api/worker-issues/${ISSUE_ID}/attachments`, [
      { kind: 'field', name: 'kind', value: 'photo' },
      { kind: 'file', name: 'file', filename: 'site.jpg', mime: 'image/jpeg', body: photoBytes },
    ])
    expect(result.status, JSON.stringify(result.body)).toBe(201)
    const body = result.body as {
      attachment: { id: string; kind: string; storage_key: string; mime_type: string; size_bytes: number }
      attachments: Array<{ kind: string }>
    }
    expect(body.attachment.kind).toBe('photo')
    expect(body.attachment.storage_key).toBe(`co-1/worker-issues/${ISSUE_ID}/site.jpg`)
    expect(body.attachment.mime_type).toBe('image/jpeg')
    expect(body.attachment.size_bytes).toBe(photoBytes.length)
    expect(pool.attachments).toHaveLength(1)
    await expect(storage.get(body.attachment.storage_key)).resolves.toEqual(photoBytes)
  })

  it('uploads a voice note and replaces any prior voice attachment on re-record', async () => {
    seedIssue()
    const first = await postMultipart(`/api/worker-issues/${ISSUE_ID}/attachments`, [
      { kind: 'field', name: 'kind', value: 'voice' },
      { kind: 'file', name: 'file', filename: 'voice.webm', mime: 'audio/webm', body: Buffer.from('first') },
    ])
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const second = await postMultipart(`/api/worker-issues/${ISSUE_ID}/attachments`, [
      { kind: 'field', name: 'kind', value: 'voice' },
      { kind: 'file', name: 'file', filename: 'voice.webm', mime: 'audio/webm', body: Buffer.from('second') },
    ])
    expect(second.status, JSON.stringify(second.body)).toBe(201)
    // Only one voice attachment should remain.
    const voiceRows = pool.attachments.filter((a) => a.kind === 'voice')
    expect(voiceRows).toHaveLength(1)
  })

  it('returns 404 when the issue does not exist (no upload happens)', async () => {
    const result = await postMultipart(`/api/worker-issues/22222222-2222-4222-8222-222222222222/attachments`, [
      { kind: 'field', name: 'kind', value: 'photo' },
      { kind: 'file', name: 'file', filename: 'site.jpg', mime: 'image/jpeg', body: Buffer.from('x') },
    ])
    expect(result.status).toBe(404)
    expect(pool.attachments).toHaveLength(0)
    expect(storage.files.size).toBe(0)
  })

  it('returns 400 when the kind field is missing', async () => {
    seedIssue()
    const result = await postMultipart(`/api/worker-issues/${ISSUE_ID}/attachments`, [
      { kind: 'file', name: 'file', filename: 'site.jpg', mime: 'image/jpeg', body: Buffer.from('x') },
    ])
    expect(result.status).toBe(400)
    expect(pool.attachments).toHaveLength(0)
  })

  it('returns 415 when the photo mime is not image/*', async () => {
    seedIssue()
    const result = await postMultipart(`/api/worker-issues/${ISSUE_ID}/attachments`, [
      { kind: 'field', name: 'kind', value: 'photo' },
      { kind: 'file', name: 'file', filename: 'doc.pdf', mime: 'application/pdf', body: Buffer.from('x') },
    ])
    expect(result.status).toBe(415)
    expect(pool.attachments).toHaveLength(0)
  })

  it('returns 413 when the file exceeds maxAttachmentBytes', async () => {
    seedIssue()
    const result = await postMultipart(`/api/worker-issues/${ISSUE_ID}/attachments`, [
      { kind: 'field', name: 'kind', value: 'photo' },
      { kind: 'file', name: 'file', filename: 'big.jpg', mime: 'image/jpeg', body: Buffer.alloc(2048, 'A') },
    ])
    expect(result.status).toBe(413)
  })
})

describe('GET /api/worker-issues/:id/attachments', () => {
  it('returns the attachments for the issue, ordered by created_at', async () => {
    seedIssue()
    await postMultipart(`/api/worker-issues/${ISSUE_ID}/attachments`, [
      { kind: 'field', name: 'kind', value: 'photo' },
      { kind: 'file', name: 'file', filename: 'a.jpg', mime: 'image/jpeg', body: Buffer.from('a') },
    ])
    await postMultipart(`/api/worker-issues/${ISSUE_ID}/attachments`, [
      { kind: 'field', name: 'kind', value: 'voice' },
      { kind: 'file', name: 'file', filename: 'voice.webm', mime: 'audio/webm', body: Buffer.from('v') },
    ])
    const list = await getRequest(`/api/worker-issues/${ISSUE_ID}/attachments`)
    expect(list.status).toBe(200)
    const body = list.body as { attachments: Array<{ kind: string; storage_key: string }> }
    expect(body.attachments).toHaveLength(2)
    expect(body.attachments.map((a) => a.kind).sort()).toEqual(['photo', 'voice'])
  })
})

describe('GET /api/worker-issues/:id/attachments/:key/file', () => {
  it('streams the bytes back with the persisted mime type', async () => {
    seedIssue()
    const photoBytes = Buffer.from('PHOTO-BYTES')
    const upload = await postMultipart(`/api/worker-issues/${ISSUE_ID}/attachments`, [
      { kind: 'field', name: 'kind', value: 'photo' },
      { kind: 'file', name: 'file', filename: 'site.jpg', mime: 'image/jpeg', body: photoBytes },
    ])
    const att = (upload.body as { attachment: { storage_key: string } }).attachment
    const fetched = await getRequest(
      `/api/worker-issues/${ISSUE_ID}/attachments/${encodeURIComponent(att.storage_key)}/file`,
    )
    expect(fetched.status).toBe(200)
    expect(fetched.headers['content-type']).toContain('image/jpeg')
    expect((fetched.body as Buffer).equals(photoBytes)).toBe(true)
  })

  it('returns 404 when the key is not on this issue', async () => {
    seedIssue()
    const fetched = await getRequest(
      `/api/worker-issues/${ISSUE_ID}/attachments/${encodeURIComponent(`co-1/worker-issues/${ISSUE_ID}/missing.jpg`)}/file`,
    )
    expect(fetched.status).toBe(404)
  })

  it('returns 400 when the storage key escapes the company scope', async () => {
    seedIssue()
    const fetched = await getRequest(
      `/api/worker-issues/${ISSUE_ID}/attachments/${encodeURIComponent('other-co/worker-issues/foo.jpg')}/file`,
    )
    expect(fetched.status).toBe(400)
  })
})
