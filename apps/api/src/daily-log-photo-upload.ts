import type http from 'node:http'
import { PassThrough } from 'node:stream'
import Busboy from 'busboy'
import { buildDailyLogPhotoStorageKey, type BlueprintStorage } from './storage.js'

/**
 * Multipart photo upload for daily logs. Mirrors blueprint-upload.ts but
 * accepts image/* parts (jpeg, png, webp, heic) and uses a different key
 * prefix so daily-log photos sit under `<companyId>/daily-logs/<id>/`.
 *
 * Stays single-file-per-request — the screen calls it once per photo.
 * That keeps the failure model simple (one photo = one HTTP, one row
 * append) and avoids the "11 of 12 photos uploaded but the 12th
 * crashed" recovery dance.
 */

export class DailyLogPhotoUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DailyLogPhotoUploadError'
  }
}

export interface DailyLogPhotoUploadResult {
  fields: Record<string, string>
  storagePath: string
  fileName: string
  mimeType: string
  bytes: number
}

export interface ParseDailyLogPhotoMultipartOptions {
  maxFileBytes: number
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

export function parseDailyLogPhotoMultipart(
  req: http.IncomingMessage,
  storage: BlueprintStorage,
  companyId: string,
  dailyLogId: string,
  defaultFileName: string,
  options: ParseDailyLogPhotoMultipartOptions,
): Promise<DailyLogPhotoUploadResult> {
  return new Promise((resolve, reject) => {
    let busboy: ReturnType<typeof Busboy>
    try {
      busboy = Busboy({
        headers: req.headers as Record<string, string | string[] | undefined>,
        limits: { files: 1, fields: 20 },
      })
    } catch (err) {
      reject(new DailyLogPhotoUploadError(400, `invalid multipart body: ${(err as Error).message}`))
      return
    }

    const fields: Record<string, string> = {}
    let resolvedFileName = defaultFileName
    let resolvedMimeType = inferMimeFromName(defaultFileName)
    let bytes = 0
    let storagePath: string | null = null
    let uploadPromise: Promise<void> | null = null
    let firstFileSeen = false
    let earlyError: DailyLogPhotoUploadError | null = null

    const fail = (err: unknown) => {
      if (earlyError) return
      earlyError =
        err instanceof DailyLogPhotoUploadError
          ? err
          : new DailyLogPhotoUploadError(
              500,
              `daily-log photo upload failed: ${(err as Error).message ?? 'unknown'}`,
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
      if (fieldName !== 'photo_file') {
        fileStream.resume()
        fail(new DailyLogPhotoUploadError(400, `unexpected file field "${fieldName}"; expected "photo_file"`))
        return
      }
      const incomingName = (info?.filename || '').trim() || defaultFileName
      resolvedFileName = incomingName
      const declaredMime = info?.mimeType?.trim() || inferMimeFromName(incomingName)
      if (!isAllowedMime(declaredMime)) {
        fileStream.resume()
        fail(new DailyLogPhotoUploadError(415, `unsupported photo mime "${declaredMime}"; expected image/*`))
        return
      }
      resolvedMimeType = declaredMime
      const key = buildDailyLogPhotoStorageKey(companyId, dailyLogId, incomingName)

      const upstream = new PassThrough()
      let aborted = false
      fileStream.on('data', (chunk: Buffer) => {
        if (aborted) return
        bytes += chunk.length
        if (bytes > options.maxFileBytes) {
          aborted = true
          upstream.destroy(new DailyLogPhotoUploadError(413, `photo exceeds ${options.maxFileBytes} bytes`))
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
          throw new DailyLogPhotoUploadError(400, 'multipart upload missing photo_file part')
        }
        return {
          fields,
          storagePath,
          fileName: resolvedFileName,
          mimeType: resolvedMimeType,
          bytes,
        }
      }
      finish().then(resolve, reject)
    })

    req.on('error', fail)
    req.pipe(busboy)
  })
}
