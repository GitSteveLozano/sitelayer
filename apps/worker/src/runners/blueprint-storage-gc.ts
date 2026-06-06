import { mkdir, readFile as fsReadFile, unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'
import { observeQueuePruneOrGc } from '../metrics.js'

export type BlueprintStorageGcPayload = {
  storage_path?: string
}

/**
 * Minimal worker-side object-storage interface. We deliberately keep
 * this tiny instead of importing the full `BlueprintStorage` from
 * apps/api: the worker only ever needs to delete objects, and pulling
 * the entire S3 multipart upload SDK + path-builders into the worker
 * for the sake of one method would blow up the cold-start time. The
 * API-side `BlueprintStorage` interface (apps/api/src/storage.ts) is
 * the source of truth for the contract — keep them in sync.
 */
export interface ObjectGcStorage {
  /**
   * Delete a single stored object. Must be idempotent: a missing key
   * is success, not an error, because the runner re-claims rows on
   * crash and we don't want a half-applied delete to loop.
   */
  deleteObject(storagePath: string): Promise<void>
}

export interface ObjectStorageClient extends ObjectGcStorage {
  put(storagePath: string, contents: Buffer, contentType?: string): Promise<void>
  get(storagePath: string): Promise<Buffer>
}

type S3CommandCtor = new (input: Record<string, unknown>) => unknown
type S3ClientLike = { send: (cmd: unknown) => Promise<unknown> }

class WorkerS3GcStorage implements ObjectStorageClient {
  constructor(
    private readonly client: S3ClientLike,
    private readonly PutObjectCommand: S3CommandCtor,
    private readonly DeleteObjectCommand: S3CommandCtor,
    private readonly GetObjectCommand: S3CommandCtor,
    private readonly bucket: string,
  ) {}

  async put(storagePath: string, contents: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new this.PutObjectCommand({
        Bucket: this.bucket,
        Key: storagePath,
        Body: contents,
        ContentType: contentType ?? 'application/octet-stream',
      }),
    )
  }

  async get(storagePath: string): Promise<Buffer> {
    const res = (await this.client.send(new this.GetObjectCommand({ Bucket: this.bucket, Key: storagePath }))) as {
      Body?: { transformToByteArray(): Promise<Uint8Array> }
    }
    if (!res.Body) throw new Error(`storage object not found: ${storagePath}`)
    return Buffer.from(await res.Body.transformToByteArray())
  }

  async deleteObject(storagePath: string): Promise<void> {
    // S3 DeleteObject returns 204 whether or not the key existed, so
    // it's already idempotent.
    await this.client.send(new this.DeleteObjectCommand({ Bucket: this.bucket, Key: storagePath }))
  }
}

class WorkerLocalFsGcStorage implements ObjectStorageClient {
  constructor(private readonly root: string) {}

  private abs(storagePath: string): string {
    const resolvedRoot = path.resolve(this.root)
    const resolvedAbs = path.resolve(this.root, storagePath)
    if (!resolvedAbs.startsWith(resolvedRoot + path.sep) && resolvedAbs !== resolvedRoot) {
      throw new Error(`blueprint storage_path resolved outside storage root: ${storagePath}`)
    }
    return resolvedAbs
  }

  async get(storagePath: string): Promise<Buffer> {
    return fsReadFile(this.abs(storagePath))
  }

  async put(storagePath: string, contents: Buffer): Promise<void> {
    const resolvedAbs = this.abs(storagePath)
    await mkdir(path.dirname(resolvedAbs), { recursive: true })
    await fsWriteFile(resolvedAbs, contents)
  }

  async deleteObject(storagePath: string): Promise<void> {
    // Re-validate the resolved absolute path is rooted under the
    // storage root before unlinking. Mirrors apps/api/src/storage.ts's
    // LocalFsStorage.abs() — a malformed historical storage_path
    // (even one that slipped past the API's assertKeyInCompany guard)
    // can never unlink anything outside the storage tree.
    const resolvedAbs = this.abs(storagePath)
    try {
      // Only unlink the file itself — never rmdir the parent. A stale
      // empty company/blueprint directory is harmless and will be
      // re-used on the next upload.
      await fsUnlink(resolvedAbs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

/**
 * Build a GC-only storage client from the same env shape the API uses
 * (`DO_SPACES_BUCKET/KEY/SECRET/REGION/ENDPOINT` for S3; otherwise the
 * local FS fallback at `BLUEPRINT_STORAGE_ROOT`). Returns null only
 * when neither path is configured (tests, or a worker booting before
 * storage is provisioned).
 */
export async function createBlueprintStorageGcClient(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ObjectStorageClient | null> {
  const bucket = env.DO_SPACES_BUCKET?.trim()
  const key = env.DO_SPACES_KEY?.trim()
  const secret = env.DO_SPACES_SECRET?.trim()
  if (bucket && key && secret) {
    const region = env.DO_SPACES_REGION?.trim() || 'tor1'
    const endpoint = env.DO_SPACES_ENDPOINT?.trim() || `https://${region}.digitaloceanspaces.com`
    const sdk = (await import('@aws-sdk/client-s3')) as unknown as {
      S3Client: new (config: unknown) => S3ClientLike
      PutObjectCommand: S3CommandCtor
      DeleteObjectCommand: S3CommandCtor
      GetObjectCommand: S3CommandCtor
    }
    const client = new sdk.S3Client({
      region,
      endpoint,
      forcePathStyle: Boolean(endpoint && !endpoint.includes('digitaloceanspaces')),
      credentials: { accessKeyId: key, secretAccessKey: secret },
    })
    return new WorkerS3GcStorage(client, sdk.PutObjectCommand, sdk.DeleteObjectCommand, sdk.GetObjectCommand, bucket)
  }
  const root = env.BLUEPRINT_STORAGE_ROOT
  if (root) return new WorkerLocalFsGcStorage(path.resolve(root))
  return null
}

/**
 * Drain `mutation_outbox` rows with mutation_type =
 * 'delete_blueprint_storage_object' and physically remove the
 * underlying DO Spaces / local-FS blob. Without this runner, soft-
 * deleting a blueprint zeroed the DB row but left the PDF in Spaces
 * forever — the cost audit on 2026-05-17 flagged orphaned objects as a
 * top spend driver.
 *
 * The outbox row carries `{ storage_path }` (set by the DELETE route
 * in apps/api/src/routes/blueprints.ts). GC is idempotent: a missing
 * object on retry is treated as success. Genuine failures bubble up so
 * `drainAgentMutations` reschedules / dead-letters via the standard
 * outbox path.
 */
export function createBlueprintStorageGcRunner(deps: { pool: Pool; storage: ObjectGcStorage | null }) {
  const { pool, storage } = deps

  return async function drainBlueprintStorageGc(companyId: string): Promise<AgentDrainSummary> {
    if (!storage) {
      // No storage wired (neither DO Spaces nor local FS root) — leave
      // rows for a later tick. Returning an empty summary keeps the
      // heartbeat shape consistent with the other agent drains.
      return { processed: 0, insightsCreated: 0, failed: 0 }
    }
    return drainAgentMutations<BlueprintStorageGcPayload>(
      pool,
      'delete_blueprint_storage_object',
      companyId,
      'blueprint_storage_gc',
      async (_client, _cid, payload) => {
        const storagePath = payload?.storage_path
        if (typeof storagePath !== 'string' || storagePath.length === 0) {
          // Payload missing the path — mark applied (drainAgentMutations
          // does this on a non-throwing return) so the row doesn't loop.
          observeQueuePruneOrGc('blueprint_storage_gc', 'skipped')
          return { insightsCreated: 0 }
        }
        try {
          await storage.deleteObject(storagePath)
          observeQueuePruneOrGc('blueprint_storage_gc', 'deleted')
        } catch (err) {
          observeQueuePruneOrGc('blueprint_storage_gc', 'failed')
          throw err
        }
        return { insightsCreated: 0 }
      },
    )
  }
}
