import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { APP_ISSUE_CAPABILITIES, isAppIssueCapability, type AppIssueCapability } from '@sitelayer/domain'
import type { Identity } from '../auth.js'
import { parseJsonBody } from '../http-utils.js'
import { authorizePlatformAdmin, parseSuperadminEnvIds, type AdminQueryExecutor } from '../admin-auth.js'

/**
 * Platform-grant management API — the OPT-IN half of the app_issue.* capability
 * model (migration 009 `platform_admin_grants`, packages/domain/src/capabilities.ts).
 *
 * app_issue.* capabilities (capture / view / triage the sitelayer SOFTWARE's own
 * issues) live ONLY on the platform boundary. A superadmin implicitly holds all
 * of them (admin-auth.ts isSuperadmin); this table is the escape hatch that
 * grants ONE app_issue.* capability to a non-superadmin platform person without a
 * redeploy. capability.ts:resolveCapability reads exactly these rows.
 *
 * Every route is gated by `authorizePlatformAdmin` on the RAW (pre-act-as)
 * identity — a verified Clerk session whose `sub` is a superadmin (env allowlist
 * ∪ platform_admins). The gate is unreachable via a company role, the dev
 * `x-sitelayer-act-as` override, or the header identity fallback (non-Clerk
 * sources short-circuit to 401). So the two domains can never bleed: this is the
 * ONLY write path into platform_admin_grants, and it only ever accepts
 * app_issue.* names (a field_request.* body is a clean 400, never a third
 * domain).
 *
 * Routes:
 *   GET    /api/admin/platform-grants                       → list grants (+ catalog)
 *   POST   /api/admin/platform-grants                       → grant { clerk_user_id, capability }
 *   DELETE /api/admin/platform-grants/:clerkUserId/:cap     → revoke one grant
 */

const PlatformGrantBodySchema = z
  .object({
    clerk_user_id: z.string().trim().min(1).max(255),
    // Validated against the catalog by isAppIssueCapability below so the 400
    // names the offending value rather than a bare enum mismatch.
    capability: z.string().trim().min(1),
  })
  .strict()

export interface PlatformGrantRouteDeps {
  /** The request pool — the real `pg.Pool` satisfies this structurally. */
  pool: AdminQueryExecutor
  identity: Identity
  sendJson: (status: number, body: unknown) => void
  /** Reads + parses the JSON request body (needed for POST). */
  readBody?: () => Promise<Record<string, unknown>>
  /** Defaults to parsing PLATFORM_SUPERADMIN_CLERK_IDS from the environment. */
  envIds?: ReadonlySet<string>
}

interface PlatformGrantRow {
  clerk_user_id: string
  capability: string
  created_at: string
}

/**
 * Returns true once it has handled (or rejected) an
 * `/api/admin/platform-grants` request; false to let the route cascade run.
 *
 * MUST be wired BEFORE handleAdminRoutes in dispatch.ts: that handler claims the
 * whole `/api/admin/*` namespace and 404s unknown subpaths, so this must reach
 * the cascade first (it shares the identical superadmin gate, so the boundary is
 * unchanged either way).
 */
export async function handlePlatformGrantRoutes(
  req: IncomingMessage,
  url: URL,
  deps: PlatformGrantRouteDeps,
): Promise<boolean> {
  const path = url.pathname
  if (path !== '/api/admin/platform-grants' && !path.startsWith('/api/admin/platform-grants/')) {
    return false
  }

  const { pool, identity, sendJson } = deps
  const envIds = deps.envIds ?? parseSuperadminEnvIds(process.env.PLATFORM_SUPERADMIN_CLERK_IDS)

  const gate = await authorizePlatformAdmin(pool, identity, envIds)
  if (!gate.ok) {
    sendJson(gate.status, { error: gate.message })
    return true
  }

  const method = (req.method ?? 'GET').toUpperCase()

  // GET /api/admin/platform-grants — list every opt-in grant, newest-first,
  // plus the app_issue.* catalog so the UI never re-derives it.
  if (method === 'GET' && path === '/api/admin/platform-grants') {
    const result = (await pool.query(
      `select clerk_user_id, capability, created_at
         from platform_admin_grants
        order by created_at desc, clerk_user_id asc`,
    )) as { rows: PlatformGrantRow[] }
    sendJson(200, {
      grants: result.rows,
      catalog: APP_ISSUE_CAPABILITIES,
    })
    return true
  }

  // POST /api/admin/platform-grants — grant one app_issue.* capability to a
  // person (idempotent; the composite PK absorbs a re-grant).
  if (method === 'POST' && path === '/api/admin/platform-grants') {
    const parsed = parseJsonBody(PlatformGrantBodySchema, deps.readBody ? await deps.readBody() : {})
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }
    const { clerk_user_id, capability } = parsed.value
    if (!isAppIssueCapability(capability)) {
      sendJson(400, { error: `capability must be one of ${APP_ISSUE_CAPABILITIES.join(', ')}` })
      return true
    }
    const inserted = (await pool.query(
      `insert into platform_admin_grants (clerk_user_id, capability)
       values ($1, $2)
       on conflict (clerk_user_id, capability) do nothing
       returning clerk_user_id, capability, created_at`,
      [clerk_user_id, capability satisfies AppIssueCapability],
    )) as { rows: PlatformGrantRow[] }
    // on-conflict-do-nothing returns no row for an existing grant — re-read it
    // so the response is the same shape either way (idempotent).
    let row = inserted.rows[0] ?? null
    if (!row) {
      const existing = (await pool.query(
        `select clerk_user_id, capability, created_at from platform_admin_grants
           where clerk_user_id = $1 and capability = $2`,
        [clerk_user_id, capability],
      )) as { rows: PlatformGrantRow[] }
      row = existing.rows[0] ?? null
    }
    sendJson(201, { grant: row })
    return true
  }

  // DELETE /api/admin/platform-grants/:clerkUserId/:capability — revoke.
  const revokeMatch = path.match(/^\/api\/admin\/platform-grants\/([^/]+)\/([^/]+)$/)
  if (method === 'DELETE' && revokeMatch) {
    const clerkUserId = decodeURIComponent(revokeMatch[1]!)
    const capability = decodeURIComponent(revokeMatch[2]!)
    if (!isAppIssueCapability(capability)) {
      sendJson(400, { error: `capability must be one of ${APP_ISSUE_CAPABILITIES.join(', ')}` })
      return true
    }
    const deleted = (await pool.query(
      `delete from platform_admin_grants where clerk_user_id = $1 and capability = $2`,
      [clerkUserId, capability],
    )) as { rowCount?: number }
    sendJson(200, { deleted: (deleted.rowCount ?? 0) > 0 })
    return true
  }

  sendJson(404, { error: 'platform-grant route not found' })
  return true
}
