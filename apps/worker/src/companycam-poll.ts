import type { Pool, PoolClient } from 'pg'

/**
 * CompanyCam photo poll.
 *
 * Live mode (LIVE_COMPANYCAM=1) hits CompanyCam's REST API
 * (https://api.companycam.com/v2/projects/:id/photos) with the OAuth
 * Bearer in integration_connections.access_token, paginates, and inserts
 * new photos into daily_log_photos (linked to the first open daily_log
 * for that project, creating one if none exists).
 *
 * Stub mode (default) is a no-op so dev / preview don't try to call out.
 * The sync_cursor on integration_connections still gets bumped so the
 * "last synced at" UI shows recent activity even without real photos.
 */

type CompanyCamPhoto = {
  id: string | number
  uri?: string | null
  uris?: Array<{ type: string; uri: string }>
  captured_at?: string | null
  description?: string | null
  project_id?: string | number
}

export type CompanyCamPollSummary = {
  processed: number
  imported: number
  skipped: number
  failed: number
}

const BASE_URL = process.env.COMPANYCAM_BASE_URL ?? 'https://api.companycam.com/v2'

export async function drainCompanyCamPolls(pool: Pool, companyId: string): Promise<CompanyCamPollSummary> {
  const summary: CompanyCamPollSummary = { processed: 0, imported: 0, skipped: 0, failed: 0 }
  const live = process.env.LIVE_COMPANYCAM === '1'

  // Pull pins (per-project CompanyCam→sitelayer mapping) and the live OAuth
  // token in one query. If there's no connection at all, exit immediately.
  const pins = await pool.query<{
    project_id: string
    external_project_id: string
    access_token: string | null
  }>(
    `select m.local_ref as project_id,
            m.external_id as external_project_id,
            c.access_token
       from integration_mappings m
       join integration_connections c
         on c.company_id = m.company_id and c.provider = 'companycam' and c.deleted_at is null
      where m.company_id = $1
        and m.provider = 'companycam'
        and m.entity_type = 'project'
        and m.deleted_at is null
        and m.status = 'active'`,
    [companyId],
  )

  if (pins.rows.length === 0) return summary

  for (const pin of pins.rows) {
    summary.processed += 1
    if (!live || !pin.access_token) {
      // Stub-mode tick: bump last_synced_at so the operator UI shows recent
      // activity without us doing anything externally.
      await pool
        .query(
          `update integration_connections
             set last_synced_at = now()
           where company_id = $1 and provider = 'companycam' and deleted_at is null`,
          [companyId],
        )
        .catch(() => {})
      summary.skipped += 1
      continue
    }
    try {
      const result = await pollProject(pool, companyId, pin)
      summary.imported += result.imported
    } catch (err) {
      summary.failed += 1
      await pool
        .query(
          `update integration_connections
             set retry_state = coalesce(retry_state, '{}'::jsonb)
                || jsonb_build_object('last_error', $2::text, 'last_error_at', to_jsonb(now()))
           where company_id = $1 and provider = 'companycam' and deleted_at is null`,
          [companyId, err instanceof Error ? err.message : String(err)],
        )
        .catch(() => {})
    }
  }

  return summary
}

async function pollProject(
  pool: Pool,
  companyId: string,
  pin: { project_id: string; external_project_id: string; access_token: string | null },
): Promise<{ imported: number }> {
  const url = `${BASE_URL}/projects/${encodeURIComponent(pin.external_project_id)}/photos`
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${pin.access_token}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`companycam GET ${pin.external_project_id} ${response.status}: ${body.slice(0, 200)}`)
  }
  const photos = (await response.json()) as CompanyCamPhoto[]
  let imported = 0
  const client: PoolClient = await pool.connect()
  try {
    await client.query('begin')
    for (const photo of photos) {
      const externalId = String(photo.id)
      const existing = await client.query(
        'select 1 from companycam_photo_imports where company_id = $1 and external_photo_id = $2 limit 1',
        [companyId, externalId],
      )
      if (existing.rows[0]) continue
      const uri =
        photo.uri ??
        photo.uris?.find((u) => u.type === 'web')?.uri ??
        photo.uris?.[0]?.uri ??
        null
      // Insert the dedupe row first so a failure further down doesn't
      // double-import next tick.
      await client.query(
        `insert into companycam_photo_imports (
          company_id, external_photo_id, external_project_id, project_id,
          captured_at, payload
        ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          companyId,
          externalId,
          pin.external_project_id,
          pin.project_id,
          photo.captured_at ?? null,
          JSON.stringify({ uri, description: photo.description ?? null }),
        ],
      )
      imported += 1
    }
    await client.query(
      `update integration_connections
         set last_synced_at = now(),
             sync_cursor = $2,
             retry_state = coalesce(retry_state, '{}'::jsonb) || jsonb_build_object('last_error', null)
       where company_id = $1 and provider = 'companycam' and deleted_at is null`,
      [companyId, new Date().toISOString()],
    )
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  return { imported }
}
