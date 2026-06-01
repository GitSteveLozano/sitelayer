import type { Identity } from './auth.js'

/**
 * Platform-admin (cross-tenant superadmin) trust boundary — design §5.
 *
 * A request is a superadmin iff it carries a REAL verified Clerk JWT
 * (`Identity.source === 'clerk'`) AND its `sub` is in the superadmin set:
 * the `PLATFORM_SUPERADMIN_CLERK_IDS` env allowlist (bootstrap) ∪ the
 * `platform_admins` table (editable without a redeploy). The gate is never
 * reachable via the `internal` / `header` / `default` identity paths or the
 * dev `x-sitelayer-act-as` override — those resolve to a non-`clerk` source,
 * and the dispatch context hands handlers the raw (pre-act-as) identity.
 */

/** Minimal `pg`-client shape this module needs (a single PK lookup). */
export interface AdminQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows?: unknown[] } | unknown>
}

/** Parse `PLATFORM_SUPERADMIN_CLERK_IDS` — comma- and/or whitespace-separated. */
export function parseSuperadminEnvIds(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set<string>()
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/**
 * Is `sub` a superadmin? Checks the env allowlist first (sync, bootstrap),
 * then a single indexed `platform_admins` PK lookup. Returns false for an empty
 * sub without touching the DB.
 */
export async function isSuperadmin(
  client: AdminQueryExecutor,
  sub: string,
  envIds: ReadonlySet<string>,
): Promise<boolean> {
  if (!sub) return false
  if (envIds.has(sub)) return true
  const result = (await client.query('select 1 from platform_admins where clerk_user_id = $1 limit 1', [sub])) as {
    rows?: unknown[]
  }
  return (result.rows?.length ?? 0) > 0
}

export type PlatformAdminGate = { ok: true; sub: string } | { ok: false; status: number; message: string }

/**
 * Pure gate decision given the resolved identity + a precomputed `admin` flag.
 * Requires a verified Clerk session first (fail-closed 401), then membership
 * (403). Split from the DB lookup so it's trivially unit-testable and so the
 * source check short-circuits before any query (see `authorizePlatformAdmin`).
 */
export function requirePlatformAdmin(identity: Identity, admin: boolean): PlatformAdminGate {
  if (identity.source !== 'clerk') {
    return { ok: false, status: 401, message: 'platform admin requires a verified Clerk session' }
  }
  if (!admin) {
    return { ok: false, status: 403, message: 'not a platform admin' }
  }
  return { ok: true, sub: identity.userId }
}

/**
 * Full async gate: verify Clerk source (no DB query for non-Clerk callers),
 * then resolve superadmin membership and apply `requirePlatformAdmin`.
 */
export async function authorizePlatformAdmin(
  client: AdminQueryExecutor,
  identity: Identity,
  envIds: ReadonlySet<string>,
): Promise<PlatformAdminGate> {
  if (identity.source !== 'clerk') {
    return { ok: false, status: 401, message: 'platform admin requires a verified Clerk session' }
  }
  const admin = await isSuperadmin(client, identity.userId, envIds)
  return requirePlatformAdmin(identity, admin)
}
