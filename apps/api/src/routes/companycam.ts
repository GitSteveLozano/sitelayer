import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'

/**
 * CompanyCam connector — one-way photo mirror.
 *
 * OAuth tokens live in integration_connections (provider='companycam').
 * Project pinning lives in integration_mappings (entity_type='project').
 * Per-photo dedupe lives in companycam_photo_imports.
 *
 * This module exposes the operator-facing surface; the actual polling +
 * download happens in a worker handler that drains pending imports.
 */
export type CompanyCamRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

function s(v: unknown): string | null {
  if (v == null) return null
  const t = String(v).trim()
  return t ? t : null
}

export async function handleCompanyCamRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: CompanyCamRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/integrations/companycam') {
    const conn = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select id, status, last_synced_at, sync_cursor, retry_state
       from integration_connections
       where company_id = $1 and provider = 'companycam' and deleted_at is null
       order by created_at desc limit 1`,
        [ctx.company.id],
      ),
    )
    const lastImports = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select external_photo_id, project_id, daily_log_photo_id, imported_at, error
       from companycam_photo_imports
       where company_id = $1
       order by imported_at desc limit 25`,
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, {
      connection: conn.rows[0] ?? null,
      recentImports: lastImports.rows,
    })
    return true
  }

  // Pin a CompanyCam project id to a sitelayer project (via integration_mappings).
  const pinMatch = url.pathname.match(/^\/api\/integrations\/companycam\/pins$/)
  if (req.method === 'POST' && pinMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const externalProjectId = s(body.external_project_id)
    const projectId = s(body.project_id)
    if (!externalProjectId || !projectId) {
      ctx.sendJson(400, { error: 'external_project_id and project_id are required' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `insert into integration_mappings (
        company_id, provider, entity_type, local_ref, external_id, label, status
      ) values ($1, 'companycam', 'project', $2, $3, $4, 'active')
      on conflict (company_id, provider, entity_type, local_ref) do update
        set external_id = excluded.external_id, label = excluded.label, status = 'active',
            version = integration_mappings.version + 1
      returning id, company_id, provider, entity_type, local_ref, external_id, label, status`,
        [ctx.company.id, projectId, externalProjectId, s(body.label)],
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  // Manual import nudge — typically called by a 'sync now' button.
  if (req.method === 'POST' && url.pathname === '/api/integrations/companycam/sync') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    await withMutationTx(async (client: PoolClient) => {
      await client.query(
        `update integration_connections
           set sync_cursor = sync_cursor, last_synced_at = last_synced_at,
               retry_state = coalesce(retry_state, '{}'::jsonb) || jsonb_build_object('manual_nudge_at', to_jsonb(now()))
         where company_id = $1 and provider = 'companycam' and deleted_at is null`,
        [ctx.company.id],
      )
    })
    ctx.sendJson(202, { queued: true })
    return true
  }

  return false
}
