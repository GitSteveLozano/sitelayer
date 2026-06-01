import type { IncomingMessage } from 'node:http'
import type { Identity } from '../auth.js'
import { authorizePlatformAdmin, parseSuperadminEnvIds, type AdminQueryExecutor } from '../admin-auth.js'

/**
 * Cross-tenant platform-admin API (design §5/§6), read-only skeleton.
 *
 * Every `/api/admin/*` route is gated by `authorizePlatformAdmin` — a verified
 * Clerk session whose `sub` is a superadmin (env allowlist ∪ platform_admins).
 * These queries are intentionally NOT company-scoped: that cross-tenant reach
 * is the whole point of the superadmin grant, which is why the gate must be
 * airtight. Mutations are out of scope here (P5 adds confirm+reason+audit).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AdminRouteDeps {
  /** The request pool — the real `pg.Pool` satisfies this structurally. */
  pool: AdminQueryExecutor
  identity: Identity
  sendJson: (status: number, body: unknown) => void
  /** Defaults to parsing PLATFORM_SUPERADMIN_CLERK_IDS from the environment. */
  envIds?: ReadonlySet<string>
}

interface CompanyRow {
  id: string
  slug: string
  name: string
  created_at: string
  member_count?: number
}

interface MembershipRow {
  clerk_user_id: string
  role: string
  created_at: string
}

function clampLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(n, 100)
}

function clampOffset(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Returns true once it has handled (or rejected) an `/api/admin/*` request;
 * false to let the rest of the route cascade run. The gate runs only for
 * admin-namespaced paths, so non-admin traffic is untouched.
 */
export async function handleAdminRoutes(req: IncomingMessage, url: URL, deps: AdminRouteDeps): Promise<boolean> {
  const path = url.pathname
  if (path !== '/api/admin' && !path.startsWith('/api/admin/')) return false

  const { pool, identity, sendJson } = deps
  const envIds = deps.envIds ?? parseSuperadminEnvIds(process.env.PLATFORM_SUPERADMIN_CLERK_IDS)

  const gate = await authorizePlatformAdmin(pool, identity, envIds)
  if (!gate.ok) {
    sendJson(gate.status, { error: gate.message })
    return true
  }

  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    sendJson(405, { error: 'admin API is read-only' })
    return true
  }

  // GET /api/admin/companies — cross-tenant company list with member counts.
  if (path === '/api/admin/companies') {
    const limit = clampLimit(url.searchParams.get('limit'))
    const offset = clampOffset(url.searchParams.get('offset'))
    const result = (await pool.query(
      `select c.id, c.slug, c.name, c.created_at,
              (select count(*)::int from company_memberships m where m.company_id = c.id) as member_count
         from companies c
        order by c.created_at desc
        limit $1 offset $2`,
      [limit, offset],
    )) as { rows: CompanyRow[] }
    sendJson(200, { companies: result.rows, limit, offset })
    return true
  }

  // GET /api/admin/companies/:id — one company + its memberships.
  const detail = path.match(/^\/api\/admin\/companies\/([^/]+)$/)
  if (detail) {
    const id = detail[1]!
    if (!UUID_RE.test(id)) {
      sendJson(404, { error: 'company not found' })
      return true
    }
    const companyResult = (await pool.query(`select id, slug, name, created_at from companies where id = $1`, [
      id,
    ])) as {
      rows: CompanyRow[]
    }
    const company = companyResult.rows[0]
    if (!company) {
      sendJson(404, { error: 'company not found' })
      return true
    }
    const memberships = (await pool.query(
      `select clerk_user_id, role, created_at from company_memberships where company_id = $1 order by role, clerk_user_id`,
      [id],
    )) as { rows: MembershipRow[] }
    sendJson(200, { company, memberships: memberships.rows })
    return true
  }

  sendJson(404, { error: 'admin route not found' })
  return true
}
