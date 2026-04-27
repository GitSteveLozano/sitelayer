import type http from 'node:http'
import { PassThrough } from 'node:stream'
import Busboy from 'busboy'
import { buildBlueprintStorageKey, getBlueprintMimeType, type BlueprintStorage } from './storage.js'

export class BlueprintUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'BlueprintUploadError'
  }
}

export interface BlueprintMultipartResult {
  fields: Record<string, string>
  storagePath: string
  fileName: string
  mimeType: string
  bytes: number
}

export interface ParseBlueprintMultipartOptions {
  maxFileBytes: number
}

export function isMultipartRequest(req: http.IncomingMessage): boolean {
  const ct = req.headers['content-type']
  const value = Array.isArray(ct) ? (ct[0] ?? '') : (ct ?? '')
  return value.toLowerCase().startsWith('multipart/form-data')
}

/**
 * Parses a multipart/form-data blueprint upload, streaming the `blueprint_file`
 * part directly to the supplied storage backend. Returns the resolved storage
 * key plus all other form fields as strings (caller applies coercions).
 *
 * Limits:
 * - one `blueprint_file` part (additional file parts are drained and ignored
 *   after the first)
 * - file body capped at `options.maxFileBytes`; exceeding emits a 413
 */
export function parseBlueprintMultipart(
  req: http.IncomingMessage,
  storage: BlueprintStorage,
  companyId: string,
  blueprintId: string,
  defaultFileName: string,
  options: ParseBlueprintMultipartOptions,
): Promise<BlueprintMultipartResult> {
  return new Promise((resolve, reject) => {
    let busboy: ReturnType<typeof Busboy>
    try {
      busboy = Busboy({
        headers: req.headers as Record<string, string | string[] | undefined>,
        limits: {
          // The 413 cap is enforced via the `data` handler below so the upload
          // stream sees a real error (and lib-storage aborts) rather than
          // busboy silently truncating to a smaller payload.
          files: 1,
          fields: 50,
        },
      })
    } catch (err) {
      reject(new BlueprintUploadError(400, `invalid multipart body: ${(err as Error).message}`))
      return
    }

    const fields: Record<string, string> = {}
    let resolvedFileName = defaultFileName
    let resolvedMimeType = getBlueprintMimeType(defaultFileName)
    let bytes = 0
    let storagePath: string | null = null
    let uploadPromise: Promise<void> | null = null
    let firstFileSeen = false
    let earlyError: BlueprintUploadError | null = null

    const fail = (err: unknown) => {
      if (earlyError) return
      earlyError =
        err instanceof BlueprintUploadError
          ? err
          : new BlueprintUploadError(500, `blueprint upload failed: ${(err as Error).message ?? 'unknown'}`)
    }

    busboy.on('field', (name, value) => {
      if (typeof value === 'string') {
        fields[name] = value
      }
    })

    busboy.on('file', (fieldName, fileStream, info) => {
      if (firstFileSeen) {
        fileStream.resume()
        return
      }
      firstFileSeen = true
      if (fieldName !== 'blueprint_file') {
        fileStream.resume()
        fail(new BlueprintUploadError(400, `unexpected file field "${fieldName}"; expected "blueprint_file"`))
        return
      }
      const incomingName = (info?.filename || '').trim() || defaultFileName
      resolvedFileName = incomingName
      resolvedMimeType = info?.mimeType?.trim() || getBlueprintMimeType(incomingName)
      const key = buildBlueprintStorageKey(companyId, blueprintId, incomingName)

      // Pipe through a PassThrough so we can fail the upload on size overflow
      // without destroying busboy's file stream — busboy keeps draining the
      // request body, and the storage client sees a clean stream error.
      const upstream = new PassThrough()
      let aborted = false
      fileStream.on('data', (chunk: Buffer) => {
        if (aborted) return
        bytes += chunk.length
        if (bytes > options.maxFileBytes) {
          aborted = true
          upstream.destroy(new BlueprintUploadError(413, `blueprint exceeds ${options.maxFileBytes} bytes`))
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
          throw new BlueprintUploadError(400, 'multipart upload missing blueprint_file part')
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
