import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppTier } from './tier.js'

export type StorageBackend = 'local-fs' | 's3'

export interface BlueprintStorage {
  backend: StorageBackend
  bucket: string | null
  put(key: string, contents: Buffer, contentType?: string): Promise<void>
  get(key: string): Promise<Buffer>
  copy(sourceKey: string, destKey: string): Promise<void>
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '')
  return cleaned || 'blueprint.pdf'
}

export function buildBlueprintStorageKey(companyId: string, blueprintId: string, fileName: string): string {
  return `${companyId}/${blueprintId}/${sanitizeFileName(fileName)}`
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

  async get(key: string): Promise<Buffer> {
    const abs = this.abs(key)
    return fsReadFile(abs)
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    const buf = await this.get(sourceKey)
    await this.put(destKey, buf)
  }
}

type S3ClientLike = {
  send: (cmd: unknown) => Promise<unknown>
}

type S3Ctor = new (config: unknown) => S3ClientLike
type S3CommandCtor = new (input: unknown) => unknown

interface S3Module {
  S3Client: S3Ctor
  PutObjectCommand: S3CommandCtor
  GetObjectCommand: S3CommandCtor
  CopyObjectCommand: S3CommandCtor
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

  async get(key: string): Promise<Buffer> {
    const res = (await this.client.send(
      new this.mod.GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } }
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
}

export type StorageEnv = {
  tier: AppTier
  blueprintStorageRoot: string
  spacesBucket: string | null
  spacesKey: string | null
  spacesSecret: string | null
  spacesRegion: string
  spacesEndpoint: string | null
}

export function readStorageEnv(env: NodeJS.ProcessEnv = process.env, tier: AppTier): StorageEnv {
  const spacesRegion = env.DO_SPACES_REGION?.trim() || 'tor1'
  return {
    tier,
    blueprintStorageRoot: path.resolve(
      env.BLUEPRINT_STORAGE_ROOT ?? path.join(process.cwd(), 'storage', 'blueprints'),
    ),
    spacesBucket: env.DO_SPACES_BUCKET?.trim() || null,
    spacesKey: env.DO_SPACES_KEY?.trim() || null,
    spacesSecret: env.DO_SPACES_SECRET?.trim() || null,
    spacesRegion,
    spacesEndpoint: env.DO_SPACES_ENDPOINT?.trim() || `https://${spacesRegion}.digitaloceanspaces.com`,
  }
}

export async function createBlueprintStorage(storageEnv: StorageEnv): Promise<BlueprintStorage> {
  const useS3 = Boolean(storageEnv.spacesKey && storageEnv.spacesSecret && storageEnv.spacesBucket)
  if (!useS3) {
    return new LocalFsStorage(storageEnv.blueprintStorageRoot)
  }

  const mod = (await import('@aws-sdk/client-s3')) as unknown as S3Module
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
  return 'application/octet-stream'
}
