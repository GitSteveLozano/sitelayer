import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CaptureArtifactUploadError, parseCaptureArtifactMultipart } from './capture-artifact-upload.js'
import type { BlueprintStorage, DownloadUrlOptions, PutStreamOptions } from './storage.js'

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
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    this.files.set(key, Buffer.concat(chunks))
    if (options?.contentType) this.mimes.set(key, options.contentType)
  }

  async get(key: string) {
    const buf = this.files.get(key)
    if (!buf) throw new Error(`missing ${key}`)
    return buf
  }

  async copy(sourceKey: string, destKey: string) {
    this.files.set(destKey, await this.get(sourceKey))
  }

  async deleteObject(key: string) {
    this.files.delete(key)
    this.mimes.delete(key)
  }

  async getDownloadUrl(_key: string, _options?: DownloadUrlOptions) {
    return null
  }
}

let storage: MemoryStorage
let server: http.Server
let port: number

beforeAll(async () => {
  storage = new MemoryStorage()
  server = http.createServer((req, res) => {
    parseCaptureArtifactMultipart(req, storage, 'company-1', '00000000-0000-4000-8000-000000000123', {
      maxFileBytes: 1024,
      objectKeyPrefix: 'test-upload',
    })
      .then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      .catch((err: unknown) => {
        const status = err instanceof CaptureArtifactUploadError ? err.status : 500
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

function multipart(parts: Array<{ name: string; value?: string; filename?: string; contentType?: string; body?: Buffer }>) {
  const boundary = '----capture-artifact-test'
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    if (part.body) {
      chunks.push(
        Buffer.from(
          `content-disposition: form-data; name="${part.name}"; filename="${part.filename ?? 'file.bin'}"\r\ncontent-type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      )
      chunks.push(part.body)
      chunks.push(Buffer.from('\r\n'))
    } else {
      chunks.push(Buffer.from(`content-disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ''}\r\n`))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { boundary, body: Buffer.concat(chunks) }
}

async function postMultipart(parts: Parameters<typeof multipart>[0]) {
  const { boundary, body } = multipart(parts)
  const response = await fetch(`http://127.0.0.1:${port}/upload`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('capture artifact upload parser', () => {
  it('streams artifact bytes to storage and returns hash metadata', async () => {
    const payload = Buffer.from('known transcript text')
    const result = await postMultipart([
      { name: 'kind', value: 'transcript' },
      { name: 'file', filename: 'notes.txt', contentType: 'text/plain', body: payload },
    ])

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      kind: 'transcript',
      storagePath: 'company-1/capture-sessions/00000000-0000-4000-8000-000000000123/test-upload-notes.txt',
      mimeType: 'text/plain',
      bytes: payload.length,
    })
    expect(String(result.body.contentHash)).toMatch(/^sha256:[0-9a-f]{64}$/)
    await expect(storage.get(String(result.body.storagePath))).resolves.toEqual(payload)
    expect(storage.mimes.get(String(result.body.storagePath))).toBe('text/plain')
  })

  it('requires kind before file and rejects oversized uploads', async () => {
    const missingKind = await postMultipart([{ name: 'file', filename: 'notes.txt', contentType: 'text/plain', body: Buffer.from('x') }])
    expect(missingKind.status).toBe(400)

    const tooLarge = await postMultipart([
      { name: 'kind', value: 'audio' },
      { name: 'file', filename: 'audio.webm', contentType: 'audio/webm', body: Buffer.alloc(2048) },
    ])
    expect(tooLarge.status).toBe(413)
  })
})
