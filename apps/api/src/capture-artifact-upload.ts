import type http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import Busboy from 'busboy'
import { buildCaptureArtifactStorageKey, type BlueprintStorage } from './storage.js'

export class CaptureArtifactUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'CaptureArtifactUploadError'
  }
}

export interface CaptureArtifactUploadResult {
  fields: Record<string, string>
  kind: string
  storagePath: string
  fileName: string
  mimeType: string
  bytes: number
  contentHash: string
}

export interface ParseCaptureArtifactMultipartOptions {
  maxFileBytes: number
  objectKeyPrefix?: string
  allowKind?: (kind: string) => boolean
  disallowedKindMessage?: (kind: string) => string
}

const SAFE_FALLBACK_MIME = 'application/octet-stream'
const CLIENT_UPLOAD_ID_MAX_LENGTH = 160
const ALLOWED_PREFIXES = ['audio/', 'video/', 'text/']
const ALLOWED_EXACT = new Set(['application/json', 'application/octet-stream'])

export function normalizeCaptureArtifactClientUploadId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > CLIENT_UPLOAD_ID_MAX_LENGTH ? trimmed.slice(0, CLIENT_UPLOAD_ID_MAX_LENGTH) : trimmed
}

export function captureArtifactClientUploadIdFromRequest(req: http.IncomingMessage): string | null {
  const header = req.headers['idempotency-key'] ?? req.headers['x-client-upload-id']
  const raw = Array.isArray(header) ? header[0] : header
  return normalizeCaptureArtifactClientUploadId(raw)
}

export function captureArtifactObjectKeyPrefix(clientUploadId: string | null): string | undefined {
  return clientUploadId ? `client-${clientUploadId}` : undefined
}

function inferMimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'json':
      return 'application/json'
    case 'txt':
    case 'log':
      return 'text/plain'
    case 'webm':
      return 'audio/webm'
    case 'mp4':
    case 'm4a':
      return 'audio/mp4'
    case 'mp3':
      return 'audio/mpeg'
    case 'ogg':
    case 'oga':
      return 'audio/ogg'
    case 'wav':
      return 'audio/wav'
    default:
      return SAFE_FALLBACK_MIME
  }
}

function isAllowedMime(mime: string): boolean {
  const lower = mime.toLowerCase()
  return ALLOWED_EXACT.has(lower) || ALLOWED_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function defaultFileNameFor(kind: string): string {
  switch (kind) {
    case 'audio':
      return 'audio.webm'
    case 'transcript':
      return 'transcript.txt'
    case 'rrweb':
      return 'replay.json'
    case 'repro_bracket':
      return 'repro-bracket.json'
    case 'canvas_geometry':
      return 'canvas-geometry.json'
    case 'video':
      return 'screen-video.webm'
    default:
      return 'capture-artifact.bin'
  }
}

export function parseCaptureArtifactMultipart(
  req: http.IncomingMessage,
  storage: BlueprintStorage,
  companyId: string,
  captureSessionId: string,
  options: ParseCaptureArtifactMultipartOptions,
): Promise<CaptureArtifactUploadResult> {
  return new Promise((resolve, reject) => {
    let busboy: ReturnType<typeof Busboy>
    try {
      busboy = Busboy({
        headers: req.headers as Record<string, string | string[] | undefined>,
        limits: { files: 1, fields: 20 },
      })
    } catch (err) {
      reject(new CaptureArtifactUploadError(400, `invalid multipart body: ${(err as Error).message}`))
      return
    }

    const fields: Record<string, string> = {}
    let resolvedFileName = ''
    let resolvedMimeType = SAFE_FALLBACK_MIME
    let bytes = 0
    let storagePath: string | null = null
    let contentHash = ''
    let uploadPromise: Promise<void> | null = null
    let firstFileSeen = false
    let earlyError: CaptureArtifactUploadError | null = null

    const fail = (err: unknown) => {
      if (earlyError) return
      earlyError =
        err instanceof CaptureArtifactUploadError
          ? err
          : new CaptureArtifactUploadError(
              500,
              `capture artifact upload failed: ${(err as Error).message ?? 'unknown'}`,
            )
    }

    busboy.on('field', (name, value) => {
      if (typeof value === 'string') fields[name] = value
    })

    busboy.on('file', (fieldName, fileStream, info) => {
      if (firstFileSeen) {
        fileStream.resume()
        return
      }
      firstFileSeen = true
      if (fieldName !== 'file') {
        fileStream.resume()
        fail(new CaptureArtifactUploadError(400, `unexpected file field "${fieldName}"; expected "file"`))
        return
      }

      const kind = fields.kind?.trim()
      if (!kind) {
        fileStream.resume()
        fail(new CaptureArtifactUploadError(400, 'kind field is required before file'))
        return
      }
      if (options.allowKind && !options.allowKind(kind)) {
        fileStream.resume()
        fail(
          new CaptureArtifactUploadError(
            403,
            options.disallowedKindMessage?.(kind) ?? `capture consent does not allow artifact kind "${kind}"`,
          ),
        )
        return
      }
      const incomingName = (info?.filename || '').trim() || defaultFileNameFor(kind)
      resolvedFileName = incomingName
      const declaredMime = info?.mimeType?.trim() || inferMimeFromName(incomingName)
      if (!isAllowedMime(declaredMime)) {
        fileStream.resume()
        fail(new CaptureArtifactUploadError(415, `unsupported capture artifact mime "${declaredMime}"`))
        return
      }
      resolvedMimeType = declaredMime
      const objectName = `${options.objectKeyPrefix ?? randomUUID()}-${incomingName}`
      const key = buildCaptureArtifactStorageKey(companyId, captureSessionId, objectName)
      const hash = createHash('sha256')
      const upstream = new PassThrough()
      let aborted = false

      fileStream.on('data', (chunk: Buffer) => {
        if (aborted) return
        bytes += chunk.length
        if (bytes > options.maxFileBytes) {
          aborted = true
          upstream.destroy(
            new CaptureArtifactUploadError(413, `capture artifact exceeds ${options.maxFileBytes} bytes`),
          )
          return
        }
        hash.update(chunk)
        if (!upstream.write(chunk)) {
          fileStream.pause()
          upstream.once('drain', () => fileStream.resume())
        }
      })
      fileStream.on('end', () => {
        if (!aborted) {
          contentHash = `sha256:${hash.digest('hex')}`
          upstream.end()
        }
      })
      fileStream.on('error', (err) => {
        if (!aborted) upstream.destroy(err as Error)
      })

      uploadPromise = storage
        .putStream(key, upstream, { contentType: resolvedMimeType })
        .then(() => {
          storagePath = key
        })
        .catch((err) => fail(err))
    })

    busboy.on('error', (err) => fail(err))
    busboy.on('close', () => {
      const finish = async () => {
        if (uploadPromise) await uploadPromise
        if (earlyError) throw earlyError
        if (!firstFileSeen || !storagePath)
          throw new CaptureArtifactUploadError(400, 'multipart upload missing file part')
        const kind = fields.kind?.trim()
        if (!kind) throw new CaptureArtifactUploadError(400, 'kind field is required')
        return {
          fields,
          kind,
          storagePath,
          fileName: resolvedFileName,
          mimeType: resolvedMimeType,
          bytes,
          contentHash,
        }
      }
      finish().then(resolve, reject)
    })

    req.on('error', fail)
    req.pipe(busboy)
  })
}
