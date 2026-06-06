import type http from 'node:http'
import { PassThrough } from 'node:stream'
import Busboy from 'busboy'
import { buildWorkerIssueAttachmentStorageKey, type BlueprintStorage } from './storage.js'

/**
 * Multipart upload for worker-issue attachments (voice notes + photos).
 * Mirrors apps/api/src/daily-log-photo-upload.ts but accepts both
 * `image/*` and `audio/*` parts under the field name `file`, and
 * requires a separate `kind` field so the caller declares whether the
 * payload is a voice note or a photo.
 *
 * Single file per request — the screen calls this once per attachment
 * (one for the voice note, one per photo). Keeps failure recovery
 * trivial: one HTTP, one row, one blob.
 */

export class WorkerIssueAttachmentUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'WorkerIssueAttachmentUploadError'
  }
}

export type WorkerIssueAttachmentKind = 'voice' | 'photo'

export interface WorkerIssueAttachmentUploadResult {
  fields: Record<string, string>
  kind: WorkerIssueAttachmentKind
  storagePath: string
  fileName: string
  mimeType: string
  bytes: number
}

export interface ParseWorkerIssueAttachmentMultipartOptions {
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

function defaultFileNameFor(kind: WorkerIssueAttachmentKind): string {
  return kind === 'voice' ? 'voice.webm' : 'photo.jpg'
}

function isAllowedMimeForKind(kind: WorkerIssueAttachmentKind, mime: string): boolean {
  const lower = mime.toLowerCase()
  if (kind === 'photo') return lower.startsWith('image/')
  // Voice: most browsers default to audio/webm via MediaRecorder, but
  // accept the broader audio/* family so an iOS Safari client emitting
  // audio/mp4 still goes through.
  return lower.startsWith('audio/') || lower === 'video/webm'
}

export function parseWorkerIssueAttachmentMultipart(
  req: http.IncomingMessage,
  storage: BlueprintStorage,
  companyId: string,
  workerIssueId: string,
  options: ParseWorkerIssueAttachmentMultipartOptions,
): Promise<WorkerIssueAttachmentUploadResult> {
  return new Promise((resolve, reject) => {
    let busboy: ReturnType<typeof Busboy>
    try {
      busboy = Busboy({
        headers: req.headers as Record<string, string | string[] | undefined>,
        limits: { files: 1, fields: 20 },
      })
    } catch (err) {
      reject(new WorkerIssueAttachmentUploadError(400, `invalid multipart body: ${(err as Error).message}`))
      return
    }

    const fields: Record<string, string> = {}
    let resolvedFileName = ''
    let resolvedMimeType = SAFE_FALLBACK_MIME
    let bytes = 0
    let storagePath: string | null = null
    let uploadPromise: Promise<void> | null = null
    let firstFileSeen = false
    let earlyError: WorkerIssueAttachmentUploadError | null = null

    const fail = (err: unknown) => {
      if (earlyError) return
      earlyError =
        err instanceof WorkerIssueAttachmentUploadError
          ? err
          : new WorkerIssueAttachmentUploadError(
              500,
              `worker-issue attachment upload failed: ${(err as Error).message ?? 'unknown'}`,
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
        fail(new WorkerIssueAttachmentUploadError(400, `unexpected file field "${fieldName}"; expected "file"`))
        return
      }

      const declaredKind = fields.kind
      if (declaredKind !== 'voice' && declaredKind !== 'photo') {
        fileStream.resume()
        fail(new WorkerIssueAttachmentUploadError(400, `kind must be "voice" or "photo"`))
        return
      }
      const kind = declaredKind as WorkerIssueAttachmentKind

      const incomingName = (info?.filename || '').trim() || defaultFileNameFor(kind)
      resolvedFileName = incomingName
      const declaredMime = info?.mimeType?.trim() || inferMimeFromName(incomingName)
      if (!isAllowedMimeForKind(kind, declaredMime)) {
        fileStream.resume()
        fail(
          new WorkerIssueAttachmentUploadError(
            415,
            `unsupported ${kind} mime "${declaredMime}"; expected ${kind === 'photo' ? 'image/*' : 'audio/*'}`,
          ),
        )
        return
      }
      resolvedMimeType = declaredMime
      const key = buildWorkerIssueAttachmentStorageKey(companyId, workerIssueId, incomingName)

      const upstream = new PassThrough()
      let aborted = false
      fileStream.on('data', (chunk: Buffer) => {
        if (aborted) return
        bytes += chunk.length
        if (bytes > options.maxFileBytes) {
          aborted = true
          upstream.destroy(
            new WorkerIssueAttachmentUploadError(413, `attachment exceeds ${options.maxFileBytes} bytes`),
          )
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
          throw new WorkerIssueAttachmentUploadError(400, 'multipart upload missing file part')
        }
        const declaredKind = fields.kind
        if (declaredKind !== 'voice' && declaredKind !== 'photo') {
          // Should be unreachable — checked when the file part arrived —
          // but defensively re-validate so the caller never sees an
          // unexpected `kind`.
          throw new WorkerIssueAttachmentUploadError(400, `kind must be "voice" or "photo"`)
        }
        return {
          fields,
          kind: declaredKind as WorkerIssueAttachmentKind,
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
