import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import {
  BlueprintUploadError,
  isMultipartRequest,
  parseBlueprintMultipart,
  type BlueprintMultipartResult,
} from './blueprint-upload.js'
import type { BlueprintStorage, DownloadUrlOptions, PutStreamOptions } from './storage.js'
import type { Readable } from 'node:stream'

class MemoryStorage implements BlueprintStorage {
  backend = 'local-fs' as const
  bucket = null
  files = new Map<string, Buffer>()
  failNextPut = false

  async put(key: string, contents: Buffer) {
    this.files.set(key, contents)
  }

  async putStream(key: string, body: Readable, _options?: PutStreamOptions) {
    if (this.failNextPut) {
      this.failNextPut = false
      throw new Error('storage offline')
    }
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    }
    this.files.set(key, Buffer.concat(chunks))
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

let storage: MemoryStorage
let server: http.Server
let port: number

interface UploadOutcome {
  status: number
  body: BlueprintMultipartResult | { error: string; status: number }
}

beforeAll(async () => {
  storage = new MemoryStorage()
  server = http.createServer((req, res) => {
    parseBlueprintMultipart(req, storage, 'company-1', 'blueprint-1', 'blueprint.pdf', {
      maxFileBytes: 1024,
    })
      .then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      .catch((err: unknown) => {
        const status = err instanceof BlueprintUploadError ? err.status : 500
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message ?? 'error', status }))
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

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

async function postMultipart(
  parts: Parameters<typeof buildMultipartBody>[0],
  contentTypeOverride?: string,
): Promise<UploadOutcome> {
  const boundary = `----test-${Math.random().toString(36).slice(2)}`
  const body = buildMultipartBody(parts, boundary)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/upload',
        headers: {
          'content-type': contentTypeOverride ?? `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        },
      },
      (res) => {
        const buf: Buffer[] = []
        res.on('data', (c) => buf.push(c as Buffer))
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(buf).toString('utf8')),
            })
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('parseBlueprintMultipart', () => {
  it('streams the blueprint_file part to storage and returns metadata', async () => {
    const result = await postMultipart([
      { kind: 'field', name: 'preview_type', value: 'storage_path' },
      { kind: 'field', name: 'calibration_unit', value: 'm' },
      {
        kind: 'file',
        name: 'blueprint_file',
        filename: 'plan.pdf',
        mime: 'application/pdf',
        body: Buffer.from('PDF-fake-content'),
      },
    ])
    expect(result.status).toBe(200)
    const ok = result.body as BlueprintMultipartResult
    expect(ok.fileName).toBe('plan.pdf')
    expect(ok.mimeType).toBe('application/pdf')
    expect(ok.bytes).toBe('PDF-fake-content'.length)
    expect(ok.storagePath).toBe('company-1/blueprint-1/plan.pdf')
    expect(ok.fields).toMatchObject({ preview_type: 'storage_path', calibration_unit: 'm' })
    await expect(storage.get('company-1/blueprint-1/plan.pdf')).resolves.toEqual(Buffer.from('PDF-fake-content'))
  })

  it('returns 413 when the file exceeds maxFileBytes', async () => {
    const result = await postMultipart([
      {
        kind: 'file',
        name: 'blueprint_file',
        filename: 'big.pdf',
        mime: 'application/pdf',
        body: Buffer.alloc(2048, 'A'),
      },
    ])
    expect(result.status).toBe(413)
  })

  it('returns 400 when no blueprint_file part is present', async () => {
    const result = await postMultipart([{ kind: 'field', name: 'file_name', value: 'plan.pdf' }])
    expect(result.status).toBe(400)
  })

  it('returns 400 when the file part is on an unexpected field name', async () => {
    const result = await postMultipart([
      {
        kind: 'file',
        name: 'wrong_field',
        filename: 'plan.pdf',
        mime: 'application/pdf',
        body: Buffer.from('hello'),
      },
    ])
    expect(result.status).toBe(400)
  })

  it('propagates a 500 when storage rejects', async () => {
    storage.failNextPut = true
    const result = await postMultipart([
      {
        kind: 'file',
        name: 'blueprint_file',
        filename: 'plan.pdf',
        mime: 'application/pdf',
        body: Buffer.from('hello'),
      },
    ])
    expect(result.status).toBe(500)
  })
})

describe('isMultipartRequest', () => {
  it('matches multipart/form-data on the content-type header', () => {
    const req = { headers: { 'content-type': 'multipart/form-data; boundary=abc' } } as unknown as http.IncomingMessage
    expect(isMultipartRequest(req)).toBe(true)
  })

  it('returns false for application/json and missing headers', () => {
    expect(
      isMultipartRequest({ headers: { 'content-type': 'application/json' } } as unknown as http.IncomingMessage),
    ).toBe(false)
    expect(isMultipartRequest({ headers: {} } as unknown as http.IncomingMessage)).toBe(false)
  })
})
