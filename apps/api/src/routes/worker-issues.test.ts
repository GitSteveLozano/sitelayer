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

  async deleteObject(key: string) {
    this.files.delete(key)
    this.mimes.delete(key)
  }

  async getDownloadUrl(_key: string, _options?: DownloadUrlOptions) {
    return null
  }
}

// ---------------------------------------------------------------------------
// FakePool — answers the SQL the attachment routes issue.
// ---------------------------------------------------------------------------

type IssueRow = {
  id: string
  company_id: string
  project_id?: string | null
  worker_id?: string | null
  reporter_clerk_user_id?: string | null
  kind?: string
  message?: string
  severity?: string
  resolved_at?: string | null
  resolved_by_clerk_user_id?: string | null
  resolved_action?: string | null
  resolution_message?: string | null
  state_version?: number
  escalated_to_estimator_at?: string | null
  escalation_reason?: string | null
  created_at?: string
}
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
  workflowEvents: unknown[][] = []
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

    // Issue full-row select. Used after attachment insert, by the GET
    // detail / PATCH workflow handler (incl. the `for update` lock load),
    // and the post-transition refetch. We hand back the full stored row
    // with workflow-column defaults so the field-event reducer + the
    // route's `rowToSnapshot` see a coherent shape.
    if (/^select[\s\S]+from\s+worker_issues/i.test(sql)) {
      // Param order differs across call sites: the `for update` load + GET
      // detail bind (company_id, id); the post-transition refetch binds
      // (id, company_id). Match order-agnostically on the (id, company)
      // pair so both shapes resolve the same stored row.
      const [a, b] = params as [string, string]
      const row = this.issues.find((r) => (r.id === a && r.company_id === b) || (r.id === b && r.company_id === a))
      if (!row) return { rows: [], rowCount: 0 }
      const full = {
        id: row.id,
        company_id: row.company_id,
        project_id: row.project_id ?? null,
        worker_id: row.worker_id ?? null,
        reporter_clerk_user_id: row.reporter_clerk_user_id ?? 'reporter-1',
        kind: row.kind ?? 'materials_out',
        message: row.message ?? 'test',
        severity: row.severity ?? 'stopped',
        resolved_at: row.resolved_at ?? null,
        resolved_by_clerk_user_id: row.resolved_by_clerk_user_id ?? null,
        resolved_action: row.resolved_action ?? null,
        resolution_message: row.resolution_message ?? null,
        state_version: row.state_version ?? 1,
        escalated_to_estimator_at: row.escalated_to_estimator_at ?? null,
        escalation_reason: row.escalation_reason ?? null,
        created_at: row.created_at ?? 'now',
      }
      return { rows: [full], rowCount: 1 }
    }

    // PATCH workflow transition: UPDATE worker_issues SET ... — mutate the
    // stored row in place. The route uses distinct column sets per event
    // type, but every variant ends with `where id = $N and company_id =
    // $N+1`, so locate the row from the trailing two params.
    if (/^update\s+worker_issues\s+set/i.test(sql)) {
      const companyId = params[params.length - 1] as string
      const issueId = params[params.length - 2] as string
      const row = this.issues.find((r) => r.company_id === companyId && r.id === issueId)
      if (!row) return { rows: [], rowCount: 0 }
      // Re-derive the new column values from the SQL + params. Rather than
      // parse the SQL, mirror the route's per-event UPDATE shapes.
      if (/resolved_action\s*=\s*\$3,\s*resolution_message/i.test(sql)) {
        // RESOLVE: resolved_at,$1 by,$2 action,$3 message,$4 version,$5
        row.resolved_at = params[0] as string
        row.resolved_by_clerk_user_id = params[1] as string
        row.resolved_action = params[2] as string
        row.resolution_message = params[3] as string
        row.state_version = params[4] as number
        row.escalated_to_estimator_at = null
        row.escalation_reason = null
      } else if (/escalated_to_estimator_at\s*=\s*\$1/i.test(sql)) {
        // ESCALATE: escalated_at,$1 reason,$2 version,$3
        row.escalated_to_estimator_at = params[0] as string
        row.escalation_reason = params[1] as string
        row.state_version = params[2] as number
      } else if (/resolved_action\s*=\s*\$3,\s*state_version/i.test(sql)) {
        // DISMISS: dismissed_at,$1 by,$2 sentinel,$3 version,$4
        row.resolved_at = params[0] as string
        row.resolved_by_clerk_user_id = params[1] as string
        row.resolved_action = params[2] as string
        row.state_version = params[3] as number
      } else {
        // REOPEN: clears decision columns; version,$1
        row.resolved_at = null
        row.resolved_by_clerk_user_id = null
        row.resolved_action = null
        row.resolution_message = null
        row.escalated_to_estimator_at = null
        row.escalation_reason = null
        row.state_version = params[0] as number
      }
      return { rows: [], rowCount: 1 }
    }

    // recordWorkflowEvent insert — capture for assertions.
    if (/^insert\s+into\s+workflow_event_log/i.test(sql)) {
      this.workflowEvents.push(params)
      return { rows: [], rowCount: 1 }
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
      // Real body buffer so PATCH /api/worker-issues/:id workflow events
      // round-trip through the route's parser. Multipart paths read the
      // socket directly via Busboy and never call this.
      readBody: () =>
        new Promise<Record<string, unknown>>((resolve) => {
          const chunks: Buffer[] = []
          req.on('data', (c) => chunks.push(c as Buffer))
          req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (!text) return resolve({})
            try {
              resolve(JSON.parse(text) as Record<string, unknown>)
            } catch {
              resolve({})
            }
          })
        }),
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
  pool.workflowEvents = []
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

function jsonRequest(
  method: 'PATCH' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : undefined,
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
    if (payload) req.end(payload)
    else req.end()
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

// ---------------------------------------------------------------------------
// Field-event workflow transition route — PATCH /api/worker-issues/:id.
//
// Exercises the RESOLVE / ESCALATE / DISMISS reducer path end-to-end:
// optimistic state_version bump, the per-event UPDATE, the workflow event
// log append, and the mutation_outbox side effect (notify_worker_resolution
// on RESOLVE, notify_estimator_escalation on ESCALATE). GET /:id returns the
// snapshot the fm-blocker-detail screen / field-event machine consume.
// ---------------------------------------------------------------------------

function seedOpenIssue(overrides: Partial<IssueRow> = {}) {
  pool.issues.push({
    id: ISSUE_ID,
    company_id: 'co-1',
    project_id: 'proj-1',
    worker_id: 'worker-1',
    reporter_clerk_user_id: 'reporter-1',
    kind: 'materials_out',
    message: 'Out of EPS sheets',
    severity: 'stopped',
    state_version: 1,
    resolved_at: null,
    escalated_to_estimator_at: null,
    created_at: 'now',
    ...overrides,
  })
}

describe('GET /api/worker-issues/:id (workflow snapshot)', () => {
  it('returns the open snapshot with state, version, and RESOLVE/ESCALATE/DISMISS next_events', async () => {
    seedOpenIssue()
    const res = await jsonRequest('GET', `/api/worker-issues/${ISSUE_ID}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const body = res.body as {
      state: string
      state_version: number
      context: { id: string; severity: string }
      next_events: Array<{ type: string }>
    }
    expect(body.state).toBe('open')
    expect(body.state_version).toBe(1)
    expect(body.context.id).toBe(ISSUE_ID)
    expect(body.next_events.map((e) => e.type).sort()).toEqual(['DISMISS', 'ESCALATE', 'RESOLVE'])
  })

  it('returns 404 for an unknown issue', async () => {
    const res = await jsonRequest('GET', `/api/worker-issues/${ISSUE_ID}`)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/worker-issues/:id (field-event workflow)', () => {
  it('RESOLVE moves open → resolved, bumps state_version, and enqueues notify_worker_resolution', async () => {
    seedOpenIssue()
    const res = await jsonRequest('PATCH', `/api/worker-issues/${ISSUE_ID}`, {
      event: 'RESOLVE',
      state_version: 1,
      action: 'order_more',
      message_to_worker: 'On its way · 30m',
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const body = res.body as { state: string; state_version: number; context: { resolved_action: string } }
    expect(body.state).toBe('resolved')
    expect(body.state_version).toBe(2)
    expect(body.context.resolved_action).toBe('order_more')

    // Workflow event log appended with the version the event was dispatched against.
    expect(pool.workflowEvents).toHaveLength(1)
    const wf = pool.workflowEvents[0]!
    expect(wf[1]).toBe('field_event') // workflow_name
    expect(wf[5]).toBe(1) // state_version BEFORE the transition
    expect(wf[6]).toBe('RESOLVE') // event_type

    // Side effect enqueued to mutation_outbox (worker drains notify_worker_resolution).
    expect(pool.outbox).toHaveLength(1)
    // Persisted row advanced.
    expect(pool.issues[0]!.state_version).toBe(2)
    expect(pool.issues[0]!.resolved_action).toBe('order_more')
  })

  it('ESCALATE moves open → escalated and enqueues notify_estimator_escalation', async () => {
    seedOpenIssue()
    const res = await jsonRequest('PATCH', `/api/worker-issues/${ISSUE_ID}`, {
      event: 'ESCALATE',
      state_version: 1,
      reason: 'Need a change order to swap the spec',
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const body = res.body as { state: string; state_version: number }
    expect(body.state).toBe('escalated')
    expect(body.state_version).toBe(2)
    expect(pool.outbox).toHaveLength(1)
    expect(pool.issues[0]!.escalation_reason).toBe('Need a change order to swap the spec')
  })

  it('DISMISS moves open → dismissed with no notification side effect', async () => {
    seedOpenIssue()
    const res = await jsonRequest('PATCH', `/api/worker-issues/${ISSUE_ID}`, {
      event: 'DISMISS',
      state_version: 1,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const body = res.body as { state: string; state_version: number }
    expect(body.state).toBe('dismissed')
    expect(body.state_version).toBe(2)
    // DISMISS emits no worker/estimator notification.
    expect(pool.outbox).toHaveLength(0)
  })

  it('returns 409 on a stale state_version and echoes the current snapshot', async () => {
    seedOpenIssue({ state_version: 3 })
    const res = await jsonRequest('PATCH', `/api/worker-issues/${ISSUE_ID}`, {
      event: 'RESOLVE',
      state_version: 1,
      action: 'order_more',
      message_to_worker: 'stale write',
    })
    expect(res.status).toBe(409)
    const body = res.body as { error: string; snapshot: { state_version: number } }
    expect(body.snapshot.state_version).toBe(3)
    // Nothing persisted.
    expect(pool.issues[0]!.state_version).toBe(3)
    expect(pool.workflowEvents).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
  })

  it('returns 400 when RESOLVE is missing message_to_worker', async () => {
    seedOpenIssue()
    const res = await jsonRequest('PATCH', `/api/worker-issues/${ISSUE_ID}`, {
      event: 'RESOLVE',
      state_version: 1,
      action: 'order_more',
    })
    expect(res.status).toBe(400)
    expect(pool.workflowEvents).toHaveLength(0)
  })

  it('returns 404 when patching an unknown issue', async () => {
    const res = await jsonRequest('PATCH', `/api/worker-issues/${ISSUE_ID}`, {
      event: 'DISMISS',
      state_version: 1,
    })
    expect(res.status).toBe(404)
  })
})
