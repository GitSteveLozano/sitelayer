import type { Pool } from 'pg'
import { observeQueuePruneOrGc } from '../metrics.js'
import { setCompanyGuc } from '../runner-utils.js'
import type { ObjectGcStorage } from './blueprint-storage-gc.js'

export type CaptureArtifactRetentionGcSummary = {
  ran: boolean
  deleted: number
  failed: number
}

type ExpiredCaptureArtifact = {
  id: string
  storage_key: string
}

export function createCaptureArtifactRetentionGcRunner(deps: { pool: Pool; storage: ObjectGcStorage | null }) {
  const { pool, storage } = deps
  let lastRunAt = 0

  return {
    async maybeSweep(companyId: string): Promise<CaptureArtifactRetentionGcSummary> {
      if (!storage) return { ran: false, deleted: 0, failed: 0 }
      const intervalMs = readPositiveInt('CAPTURE_ARTIFACT_RETENTION_GC_INTERVAL_MS', 300_000)
      const now = Date.now()
      if (now - lastRunAt < intervalMs) return { ran: false, deleted: 0, failed: 0 }
      lastRunAt = now
      return sweepCaptureArtifactRetentionGc(pool, storage, companyId)
    },
    async forceSweep(companyId: string): Promise<CaptureArtifactRetentionGcSummary> {
      if (!storage) return { ran: false, deleted: 0, failed: 0 }
      return sweepCaptureArtifactRetentionGc(pool, storage, companyId)
    },
  }
}

async function sweepCaptureArtifactRetentionGc(
  pool: Pool,
  storage: ObjectGcStorage,
  companyId: string,
): Promise<CaptureArtifactRetentionGcSummary> {
  const limit = Math.min(readPositiveInt('CAPTURE_ARTIFACT_RETENTION_GC_LIMIT', 25), 100)
  const client = await pool.connect()
  let deleted = 0
  let failed = 0
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const expired = await client.query<ExpiredCaptureArtifact>(
      `select id, storage_key
         from capture_artifacts
        where company_id = $1
          and deleted_at is null
          and storage_key is not null
          and retention_expires_at is not null
          and retention_expires_at <= now()
        order by retention_expires_at asc
        limit $2
        for update skip locked`,
      [companyId, limit],
    )
    for (const row of expired.rows) {
      if (!storageKeyInCompany(companyId, row.storage_key)) {
        failed += 1
        observeQueuePruneOrGc('capture_artifact_retention_gc', 'failed')
        continue
      }
      try {
        await storage.deleteObject(row.storage_key)
        const result = await client.query(
          `update capture_artifacts
              set deleted_at = coalesce(deleted_at, now()),
                  metadata = metadata || $3::jsonb
            where company_id = $1 and id = $2 and deleted_at is null`,
          [
            companyId,
            row.id,
            JSON.stringify({
              deleted_by: 'capture_artifact_retention_gc',
              deleted_reason: 'retention_expired',
            }),
          ],
        )
        const count = result.rowCount ?? 0
        deleted += count
        observeQueuePruneOrGc('capture_artifact_retention_gc', count > 0 ? 'deleted' : 'skipped')
      } catch (_error) {
        failed += 1
        observeQueuePruneOrGc('capture_artifact_retention_gc', 'failed')
      }
    }
    await client.query('commit')
    return { ran: true, deleted, failed }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function storageKeyInCompany(companyId: string, storageKey: string): boolean {
  return storageKey === companyId || storageKey.startsWith(`${companyId}/`)
}
