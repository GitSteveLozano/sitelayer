import type { IncomingMessage } from 'node:http'
import type { Identity } from '../auth.js'
import type { AppTier } from '../tier.js'
import { authorizePlatformAdmin, parseSuperadminEnvIds, type AdminQueryExecutor } from '../admin-auth.js'
import { actorTokenMinterFromEnv, type ActorTokenMinter } from '../clerk-actor-token.js'
import { listRegistryWorkflows, listScenarioFiles, previewScenarioPlan } from '../admin-scenarios.js'

/**
 * Cross-tenant platform-admin API (design §5/§6/§7).
 *
 * Every `/api/admin/*` route is gated by `authorizePlatformAdmin` — a verified
 * Clerk session whose `sub` is a superadmin (env allowlist ∪ platform_admins).
 * Reads are cross-tenant (the whole point of the grant). The one mutation here
 * is `POST /api/admin/impersonate`: it mints a Clerk actor token (audited
 * impersonation) and records an impersonation_sessions ledger row — reason
 * required, short TTL, read-only-view by default (OQ6). The resulting session's
 * every mutation is tagged impersonated_by via the request context (P4b).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_IMPERSONATION_TTL_SECONDS = 600
const MAX_IMPERSONATION_TTL_SECONDS = 3600
const MIN_IMPERSONATION_TTL_SECONDS = 60

export interface AdminRouteDeps {
  /** The request pool — the real `pg.Pool` satisfies this structurally. */
  pool: AdminQueryExecutor
  identity: Identity
  sendJson: (status: number, body: unknown) => void
  /** Tier — admin mutations get a prod-specific second gate (design §6). */
  tier?: AppTier
  /** Reads + parses the JSON request body (needed for POST /impersonate). */
  readBody?: () => Promise<Record<string, unknown>>
  /** Defaults to parsing PLATFORM_SUPERADMIN_CLERK_IDS from the environment. */
  envIds?: ReadonlySet<string>
  /** Defaults to a minter built from CLERK_SECRET_KEY; injected in tests. */
  mintActorToken?: ActorTokenMinter | null
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

interface ImpersonationSessionRow {
  id: string
  created_at: string
  expires_at: string
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

function clampTtl(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IMPERSONATION_TTL_SECONDS
  return Math.min(Math.max(Math.trunc(n), MIN_IMPERSONATION_TTL_SECONDS), MAX_IMPERSONATION_TTL_SECONDS)
}

/**
 * Returns true once it has handled (or rejected) an `/api/admin/*` request;
 * false to let the rest of the route cascade run.
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

  // Mutation: start an audited impersonation session (Clerk actor token).
  if (method === 'POST' && path === '/api/admin/impersonate') {
    // Prod-specific second gate (design §6): admin mutations are disabled in
    // prod unless explicitly enabled, so even a leaked superadmin session can't
    // mint impersonation tokens on prod without an operator flipping the flag.
    if (deps.tier === 'prod' && process.env.PLATFORM_ADMIN_PROD_ENABLED !== '1') {
      sendJson(403, {
        error: 'platform admin mutations are disabled in prod (set PLATFORM_ADMIN_PROD_ENABLED=1)',
      })
      return true
    }
    return handleImpersonateStart(deps, gate.sub)
  }

  if (method !== 'GET') {
    sendJson(405, { error: 'method not allowed' })
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

  // GET /api/admin/workflows — the deterministic-workflow registry.
  if (path === '/api/admin/workflows') {
    sendJson(200, { workflows: listRegistryWorkflows() })
    return true
  }

  // GET /api/admin/scenarios — the checked-in scenario fixtures.
  if (path === '/api/admin/scenarios') {
    sendJson(200, { scenarios: listScenarioFiles() })
    return true
  }

  // GET /api/admin/scenarios/:slug/plan — preview the resolved apply plan
  // (@sitelayer/scenario ApplyOp[]) for a fixture before applying it.
  const planMatch = path.match(/^\/api\/admin\/scenarios\/([^/]+)\/plan$/)
  if (planMatch) {
    const slug = decodeURIComponent(planMatch[1]!)
    const plan = previewScenarioPlan(slug)
    if (!plan) {
      sendJson(404, { error: 'scenario not found' })
      return true
    }
    sendJson(200, { plan })
    return true
  }

  // GET /api/admin/impersonation-sessions — the audited impersonation ledger.
  if (path === '/api/admin/impersonation-sessions') {
    const limit = clampLimit(url.searchParams.get('limit'))
    const offset = clampOffset(url.searchParams.get('offset'))
    const result = (await pool.query(
      `select id, actor_user_id, subject_user_id, reason, mode, expires_at, created_at
         from impersonation_sessions
        order by created_at desc
        limit $1 offset $2`,
      [limit, offset],
    )) as { rows: unknown[] }
    sendJson(200, { sessions: result.rows, limit, offset })
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

async function handleImpersonateStart(deps: AdminRouteDeps, actorSub: string): Promise<boolean> {
  const { pool, sendJson } = deps
  const body = deps.readBody ? await deps.readBody() : {}

  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!userId) {
    sendJson(400, { error: 'user_id is required' })
    return true
  }
  // Reason is mandatory and audited — impersonation is never anonymous.
  if (!reason) {
    sendJson(400, { error: 'reason is required' })
    return true
  }
  const expiresInSeconds = clampTtl(body.expires_in_seconds)
  // OQ6 default: read-only-view. Full read-write requires an explicit opt-in.
  const mode = body.mode === 'read_write' ? 'read_write' : 'read_only'

  const minter = deps.mintActorToken !== undefined ? deps.mintActorToken : actorTokenMinterFromEnv()
  if (!minter) {
    sendJson(501, { error: 'impersonation unavailable: CLERK_SECRET_KEY is not configured' })
    return true
  }

  let token: string
  try {
    token = (await minter({ userId, actorSub, expiresInSeconds })).token
  } catch {
    sendJson(502, { error: 'could not mint impersonation token' })
    return true
  }

  const inserted = (await pool.query(
    `insert into impersonation_sessions (actor_user_id, subject_user_id, reason, mode, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
     returning id, created_at, expires_at`,
    [actorSub, userId, reason, mode, String(expiresInSeconds)],
  )) as { rows: ImpersonationSessionRow[] }
  const session = inserted.rows[0]

  sendJson(201, {
    session_id: session?.id ?? null,
    actor_user_id: actorSub,
    subject_user_id: userId,
    mode,
    reason,
    expires_at: session?.expires_at ?? null,
    // The Clerk ticket the SPA redirects through (?__clerk_ticket=<token>).
    ticket: token,
  })
  return true
}
