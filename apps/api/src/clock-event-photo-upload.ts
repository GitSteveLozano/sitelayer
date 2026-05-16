import type http from 'node:http'
import { PassThrough } from 'node:stream'
import Busboy from 'busboy'
import { buildClockEventPhotoStorageKey, type BlueprintStorage } from './storage.js'

/**
 * Multipart photo upload for clock_events verification. Mirrors
 * daily-log-photo-upload.ts but uses field name `file` (the offline
 * replay handler sends it that way) and a different storage prefix.
 *
 * One photo per request — same simple failure model.
 */

export class ClockEventPhotoUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ClockEventPhotoUploadError'
  }
}

export interface ClockEventPhotoUploadResult {
  storagePath: string
  fileName: string
  mimeType: string
  bytes: number
}

const ALLOWED_MIME_PREFIXES = ['image/'] as const
const SAFE_FALLBACK_MIME = 'application/octet-stream'

function isAllowedMime(mime: string): boolean {
  const lower = mime.toLowerCase()
  return ALLOWED_MIME_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function inferMimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'heic':
      return 'image/heic'
    case 'heif':
      return 'image/heif'
    default:
      return SAFE_FALLBACK_MIME
  }
}

export function parseClockEventPhotoMultipart(
  req: http.IncomingMessage,
  storage: BlueprintStorage,
  companyId: string,
  clockEventId: string,
  options: { maxFileBytes: number },
): Promise<ClockEventPhotoUploadResult> {
  return new Promise((resolve, reject) => {
    let busboy: ReturnType<typeof Busboy>
    try {
      busboy = Busboy({
        headers: req.headers as Record<string, string | string[] | undefined>,
        limits: { files: 1, fields: 10 },
      })
    } catch (err) {
      reject(new ClockEventPhotoUploadError(400, `invalid multipart body: ${(err as Error).message}`))
      return
    }

    let resolvedFileName = 'clock-photo.jpg'
    let resolvedMimeType = inferMimeFromName(resolvedFileName)
    let bytes = 0
    let storagePath: string | null = null
    let uploadPromise: Promise<void> | null = null
    let firstFileSeen = false
    let earlyError: ClockEventPhotoUploadError | null = null

    const fail = (err: unknown) => {
      if (earlyError) return
      earlyError =
        err instanceof ClockEventPhotoUploadError
          ? err
          : new ClockEventPhotoUploadError(500, `clock-event photo upload failed: ${(err as Error).message ?? 'unknown'}`)
    }

    busboy.on('file', (fieldName, fileStream, info) => {
      if (firstFileSeen) {
        fileStream.resume()
        return
      }
      firstFileSeen = true
      if (fieldName !== 'file') {
        fileStream.resume()
        fail(new ClockEventPhotoUploadError(400, `unexpected file field "${fieldName}"; expected "file"`))
        return
      }
      const incomingName = (info?.filename || '').trim() || resolvedFileName
      resolvedFileName = incomingName
      const declaredMime = info?.mimeType?.trim() || inferMimeFromName(incomingName)
      if (!isAllowedMime(declaredMime)) {
        fileStream.resume()
        fail(new ClockEventPhotoUploadError(415, `unsupported photo mime "${declaredMime}"; expected image/*`))
        return
      }
      resolvedMimeType = declaredMime
      const key = buildClockEventPhotoStorageKey(companyId, clockEventId, incomingName)

      const upstream = new PassThrough()
      let aborted = false
      fileStream.on('data', (chunk: Buffer) => {
        if (aborted) return
        bytes += chunk.length
        if (bytes > options.maxFileBytes) {
          aborted = true
          upstream.destroy(new ClockEventPhotoUploadError(413, `photo exceeds ${options.maxFileBytes} bytes`))
          return
        }
        if (!upstream.write(chunk)) {
          fileStream.pause()
          upstream.once('drain', () => fileStream.resume())
        }
      })
      fileStream.on('end', () => {
        if (!aborted) upstream.end()
      })
      fileStream.on('error', (err) => {
        if (!aborted) upstream.destroy(err as Error)
      })

      uploadPromise = storage
        .putStream(key, upstream, { contentType: resolvedMimeType })
        .then(() => {
          storagePath = key
        })
        .catch((err) => {
          fail(err)
        })
    })

    busboy.on('error', (err) => fail(err))

    busboy.on('close', () => {
      const finish = async () => {
        if (uploadPromise) await uploadPromise
        if (earlyError) throw earlyError
        if (!firstFileSeen || !storagePath) {
          throw new ClockEventPhotoUploadError(400, 'multipart upload missing file part')
        }
        return { storagePath, fileName: resolvedFileName, mimeType: resolvedMimeType, bytes }
      }
      finish().then(resolve, reject)
    })

    req.on('error', fail)
    req.pipe(busboy)
  })
}
