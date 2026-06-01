import type http from 'node:http'
import { PassThrough } from 'node:stream'
import Busboy from 'busboy'
import { buildInventoryMovementPhotoStorageKey, type BlueprintStorage } from './storage.js'

/**
 * Multipart upload for rental dispatch / return condition photos.
 * Mirrors apps/api/src/worker-issue-attachment-upload.ts but is
 * photos-only (no `kind` field) — the movement row already encodes
 * whether this is a dispatch (`deliver`) or a return (`return` /
 * `damaged`).
 *
 * Single file per request — the dispatch/return screens call this once
 * per captured photo. Keeps failure recovery trivial: one HTTP, one row,
 * one blob (the screen can retry a single failed photo without
 * re-creating the movement).
 */

export class InventoryMovementPhotoUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'InventoryMovementPhotoUploadError'
  }
}

export interface InventoryMovementPhotoUploadResult {
  fields: Record<string, string>
  storagePath: string
  fileName: string
  mimeType: string
  bytes: number
}

export interface ParseInventoryMovementPhotoMultipartOptions {
  maxFileBytes: number
}

const SAFE_FALLBACK_MIME = 'application/octet-stream'

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

function isAllowedPhotoMime(mime: string): boolean {
  return mime.toLowerCase().startsWith('image/')
}

export function parseInventoryMovementPhotoMultipart(
  req: http.IncomingMessage,
  storage: BlueprintStorage,
  companyId: string,
  movementId: string,
  options: ParseInventoryMovementPhotoMultipartOptions,
): Promise<InventoryMovementPhotoUploadResult> {
  return new Promise((resolve, reject) => {
    let busboy: ReturnType<typeof Busboy>
    try {
      busboy = Busboy({
        headers: req.headers as Record<string, string | string[] | undefined>,
        limits: { files: 1, fields: 20 },
      })
    } catch (err) {
      reject(new InventoryMovementPhotoUploadError(400, `invalid multipart body: ${(err as Error).message}`))
      return
    }

    const fields: Record<string, string> = {}
    let resolvedFileName = 'photo.jpg'
    let resolvedMimeType = SAFE_FALLBACK_MIME
    let bytes = 0
    let storagePath: string | null = null
    let uploadPromise: Promise<void> | null = null
    let firstFileSeen = false
    let earlyError: InventoryMovementPhotoUploadError | null = null

    const fail = (err: unknown) => {
      if (earlyError) return
      earlyError =
        err instanceof InventoryMovementPhotoUploadError
          ? err
          : new InventoryMovementPhotoUploadError(
              500,
              `inventory-movement photo upload failed: ${(err as Error).message ?? 'unknown'}`,
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
        fail(new InventoryMovementPhotoUploadError(400, `unexpected file field "${fieldName}"; expected "file"`))
        return
      }

      const incomingName = (info?.filename || '').trim() || 'photo.jpg'
      resolvedFileName = incomingName
      const declaredMime = info?.mimeType?.trim() || inferMimeFromName(incomingName)
      if (!isAllowedPhotoMime(declaredMime)) {
        fileStream.resume()
        fail(new InventoryMovementPhotoUploadError(415, `unsupported photo mime "${declaredMime}"; expected image/*`))
        return
      }
      resolvedMimeType = declaredMime
      const key = buildInventoryMovementPhotoStorageKey(companyId, movementId, incomingName)

      const upstream = new PassThrough()
      let aborted = false
      fileStream.on('data', (chunk: Buffer) => {
        if (aborted) return
        bytes += chunk.length
        if (bytes > options.maxFileBytes) {
          aborted = true
          upstream.destroy(new InventoryMovementPhotoUploadError(413, `photo exceeds ${options.maxFileBytes} bytes`))
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
          throw new InventoryMovementPhotoUploadError(400, 'multipart upload missing file part')
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
