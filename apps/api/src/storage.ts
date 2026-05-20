import { createWriteStream } from 'node:fs'
import { mkdir, readFile as fsReadFile, unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import type { AppTier } from './tier.js'

export type StorageBackend = 'local-fs' | 's3'

export interface PutStreamOptions {
  contentType?: string
  contentLength?: number
}

export interface DownloadUrlOptions {
  /** Filename to send to the browser via Content-Disposition */
  fileName?: string
  /** TTL for the signed URL in seconds; ignored for backends that stream through the API */
  expiresIn?: number
}

export interface BlueprintStorage {
  backend: StorageBackend
  bucket: string | null
  put(key: string, contents: Buffer, contentType?: string): Promise<void>
  putStream(key: string, body: Readable, options?: PutStreamOptions): Promise<void>
  get(key: string): Promise<Buffer>
  copy(sourceKey: string, destKey: string): Promise<void>
  /**
   * Delete a single stored object. Used by the blueprint-storage GC
   * runner that drains `mutation_outbox` rows enqueued when a
   * blueprint_document is soft-deleted. Missing keys must NOT throw —
   * GC is idempotent and a re-run after a partial success should still
   * mark the row applied.
   */
  deleteObject(storagePath: string): Promise<void>
  /**
   * Returns a presigned download URL when the backend supports it (S3); returns
   * `null` when the caller should stream the bytes back through the API itself
   * (local FS in dev / preview).
   */
  getDownloadUrl(key: string, options?: DownloadUrlOptions): Promise<string | null>
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
  return cleaned || 'blueprint.pdf'
}

export function buildBlueprintStorageKey(companyId: string, blueprintId: string, fileName: string): string {
  return `${companyId}/${blueprintId}/${sanitizeFileName(fileName)}`
}

/**
 * Storage key for daily-log photos. Lives under a `/daily-logs/` prefix
 * inside the same bucket so a single bucket policy covers everything;
 * the `companyId` first segment is what assertKeyInCompany still
 * checks, so cross-tenant access is impossible via path manipulation.
 */
export function buildDailyLogPhotoStorageKey(companyId: string, dailyLogId: string, fileName: string): string {
  return `${companyId}/daily-logs/${dailyLogId}/${sanitizeFileName(fileName)}`
}

/**
 * Storage key for clock-event verification photos. Lives under a
 * `/clock-events/` prefix in the same bucket so the single bucket
 * policy still covers it. companyId first segment is the
 * assertKeyInCompany guard.
 */
export function buildClockEventPhotoStorageKey(companyId: string, clockEventId: string, fileName: string): string {
  return `${companyId}/clock-events/${clockEventId}/${sanitizeFileName(fileName)}`
}

/**
 * Storage key for worker-issue voice / photo attachments. Lives under a
 * `/worker-issues/` prefix in the same bucket — same first-segment
 * companyId guard as the other helpers, so assertKeyInCompany still
 * blocks cross-tenant access via path manipulation.
 */
export function buildWorkerIssueAttachmentStorageKey(
  companyId: string,
  workerIssueId: string,
  fileName: string,
): string {
  return `${companyId}/worker-issues/${workerIssueId}/${sanitizeFileName(fileName)}`
}

export function formatS3CopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
}

const LEGACY_FS_PREFIX = /^(\/|[a-zA-Z]:\\)/

function normalizeKey(storagePath: string): string {
  const trimmed = storagePath.trim()
  if (LEGACY_FS_PREFIX.test(trimmed)) {
    // Legacy absolute filesystem path — extract the tail after blueprints/
    const match = trimmed.match(/blueprints\/(.+)$/)
    return match ? match[1]! : trimmed
  }
  return trimmed
}

export function assertKeyInCompany(companyId: string, storagePath: string): string {
  const key = normalizeKey(storagePath)
  const segments = key.split('/').filter(Boolean)
  if (segments.length < 3) {
    throw new StorageError(400, `blueprint storage key "${storagePath}" is malformed`)
  }
  if (segments[0] !== companyId) {
    throw new StorageError(400, 'blueprint storage_path must stay inside the company scope')
  }
  for (const segment of segments) {
    if (segment === '..' || segment === '.' || segment.includes('/') || segment.includes('\\')) {
      throw new StorageError(400, 'blueprint storage_path contains illegal path segment')
    }
  }
  return key
}

export class StorageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'StorageError'
  }
}

class LocalFsStorage implements BlueprintStorage {
  backend: StorageBackend = 'local-fs'
  bucket = null
  constructor(private readonly root: string) {}

  private abs(key: string): string {
    const resolvedRoot = path.resolve(this.root)
    const resolvedAbs = path.resolve(this.root, key)
    if (!resolvedAbs.startsWith(resolvedRoot + path.sep) && resolvedAbs !== resolvedRoot) {
      throw new StorageError(400, 'blueprint path resolved outside storage root')
    }
    return resolvedAbs
  }

  async put(key: string, contents: Buffer): Promise<void> {
    const abs = this.abs(key)
    await mkdir(path.dirname(abs), { recursive: true })
    await fsWriteFile(abs, contents)
  }

  async putStream(key: string, body: Readable): Promise<void> {
    const abs = this.abs(key)
    await mkdir(path.dirname(abs), { recursive: true })
    await pipeline(body, createWriteStream(abs))
  }

  async get(key: string): Promise<Buffer> {
    const abs = this.abs(key)
    return fsReadFile(abs)
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    const buf = await this.get(sourceKey)
    await this.put(destKey, buf)
  }

  async deleteObject(storagePath: string): Promise<void> {
    // `abs()` re-validates the key stays inside the storage root, so a
    // malformed path can never unlink anything outside it. We only ever
    // unlink the file itself — never the parent directory tree — so a
    // stale empty company/blueprint folder is acceptable and will be
    // re-used on the next upload.
    const abs = this.abs(storagePath)
    try {
      await fsUnlink(abs)
    } catch (err) {
      // ENOENT is idempotent success: file already gone (perhaps GC
      // ran once and the outbox row was re-claimed). Any other error
      // surfaces so the runner can retry / mark failed.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async getDownloadUrl(): Promise<null> {
    return null
  }
}

type S3ClientLike = {
  send: (cmd: unknown) => Promise<unknown>
}

type S3Ctor = new (config: unknown) => S3ClientLike
type S3CommandCtor = new (input: unknown) => unknown

type S3UploadCtor = new (input: {
  client: S3ClientLike
  params: Record<string, unknown>
  queueSize?: number
  partSize?: number
}) => { done(): Promise<unknown> }

type GetSignedUrlFn = (client: S3ClientLike, command: unknown, options: { expiresIn?: number }) => Promise<string>

interface S3Module {
  S3Client: S3Ctor
  PutObjectCommand: S3CommandCtor
  GetObjectCommand: S3CommandCtor
  CopyObjectCommand: S3CommandCtor
  DeleteObjectCommand: S3CommandCtor
  Upload: S3UploadCtor
  getSignedUrl: GetSignedUrlFn
}

class S3Storage implements BlueprintStorage {
  backend: StorageBackend = 's3'
  constructor(
    private readonly client: S3ClientLike,
    private readonly mod: S3Module,
    readonly bucket: string,
  ) {}

  async put(key: string, contents: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new this.mod.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: contents,
        ContentType: contentType ?? 'application/octet-stream',
      }),
    )
  }

  async putStream(key: string, body: Readable, options: PutStreamOptions = {}): Promise<void> {
    const params: Record<string, unknown> = {
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: options.contentType ?? 'application/octet-stream',
    }
    if (options.contentLength !== undefined) {
      params.ContentLength = options.contentLength
    }
    const upload = new this.mod.Upload({
      client: this.client,
      params,
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    })
    await upload.done()
  }

  async get(key: string): Promise<Buffer> {
    const res = (await this.client.send(new this.mod.GetObjectCommand({ Bucket: this.bucket, Key: key }))) as {
      Body?: { transformToByteArray(): Promise<Uint8Array> }
    }
    if (!res.Body) throw new StorageError(404, `blueprint ${key} not found in ${this.bucket}`)
    const bytes = await res.Body.transformToByteArray()
    return Buffer.from(bytes)
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    await this.client.send(
      new this.mod.CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: formatS3CopySource(this.bucket, sourceKey),
        Key: destKey,
      }),
    )
  }

  async deleteObject(storagePath: string): Promise<void> {
    // S3 DeleteObject is already idempotent (returns 204 whether the key
    // existed or not), so unlike the local-FS path we don't need an
    // explicit not-found swallow. The path-traversal guard sits at the
    // caller (assertKeyInCompany inside the route + GC runner).
    await this.client.send(
      new this.mod.DeleteObjectCommand({
        Bucket: this.bucket,
        Key: storagePath,
      }),
    )
  }

  async getDownloadUrl(key: string, options: DownloadUrlOptions = {}): Promise<string> {
    const params: Record<string, unknown> = { Bucket: this.bucket, Key: key }
    if (options.fileName) {
      params.ResponseContentDisposition = `inline; filename="${sanitizeFileName(options.fileName)}"`
    }
    const expiresIn = options.expiresIn && options.expiresIn > 0 ? options.expiresIn : 900
    return this.mod.getSignedUrl(this.client, new this.mod.GetObjectCommand(params), { expiresIn })
  }
}

export type StorageEnv = {
  tier: AppTier
  blueprintStorageRoot: string
  spacesBucket: string | null
  spacesKey: string | null
  spacesSecret: string | null
  spacesRegion: string
  spacesEndpoint: string | null
  allowLocalInProd: boolean
}

export function readStorageEnv(env: NodeJS.ProcessEnv = process.env, tier: AppTier): StorageEnv {
  const spacesRegion = env.DO_SPACES_REGION?.trim() || 'tor1'
  return {
    tier,
    blueprintStorageRoot: path.resolve(env.BLUEPRINT_STORAGE_ROOT ?? path.join(process.cwd(), 'storage', 'blueprints')),
    spacesBucket: env.DO_SPACES_BUCKET?.trim() || null,
    spacesKey: env.DO_SPACES_KEY?.trim() || null,
    spacesSecret: env.DO_SPACES_SECRET?.trim() || null,
    spacesRegion,
    spacesEndpoint: env.DO_SPACES_ENDPOINT?.trim() || `https://${spacesRegion}.digitaloceanspaces.com`,
    allowLocalInProd:
      env.ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD === '1' || env.ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD === 'true',
  }
}

export async function createBlueprintStorage(storageEnv: StorageEnv): Promise<BlueprintStorage> {
  const useS3 = Boolean(storageEnv.spacesKey && storageEnv.spacesSecret && storageEnv.spacesBucket)
  if (!useS3) {
    if (storageEnv.tier === 'prod' && !storageEnv.allowLocalInProd) {
      throw new StorageError(
        500,
        'APP_TIER=prod requires Spaces credentials or ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD=1',
      )
    }
    return new LocalFsStorage(storageEnv.blueprintStorageRoot)
  }

  // S3Module is intentionally a thin local shim around the AWS SDK
  // constructors so the rest of this file never sees AWS-SDK types and
  // the dynamic imports stay lazy. The single unknown cast at the
  // boundary bridges SDK constructor signatures (typed input) to the
  // local `unknown`-input shape.
  const sdkModule = {
    ...(await import('@aws-sdk/client-s3')),
    ...(await import('@aws-sdk/lib-storage')),
    ...(await import('@aws-sdk/s3-request-presigner')),
  } as unknown as S3Module
  const mod: S3Module = {
    S3Client: sdkModule.S3Client,
    PutObjectCommand: sdkModule.PutObjectCommand,
    GetObjectCommand: sdkModule.GetObjectCommand,
    CopyObjectCommand: sdkModule.CopyObjectCommand,
    DeleteObjectCommand: sdkModule.DeleteObjectCommand,
    Upload: sdkModule.Upload,
    getSignedUrl: sdkModule.getSignedUrl,
  }
  const client = new mod.S3Client({
    region: storageEnv.spacesRegion,
    endpoint: storageEnv.spacesEndpoint ?? undefined,
    forcePathStyle: Boolean(storageEnv.spacesEndpoint && !storageEnv.spacesEndpoint.includes('digitaloceanspaces')),
    credentials: {
      accessKeyId: storageEnv.spacesKey!,
      secretAccessKey: storageEnv.spacesSecret!,
    },
  })
  return new S3Storage(client, mod, storageEnv.spacesBucket!)
}

export function getBlueprintMimeType(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}
