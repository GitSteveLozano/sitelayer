import type { Pool, PoolClient } from 'pg'

/**
 * Per-company QBO live/dry-run gate (multi-tenant money-movement safety).
 *
 * Before multi-tenant operation, each push runner decided live-vs-stub ONCE
 * at boot from a single process-wide env (QBO_LIVE_RENTAL_INVOICE,
 * QBO_LIVE_ESTIMATE_PUSH, QBO_LIVE_LABOR_PAYROLL, QBO_LIVE_DAMAGE_INVOICE,
 * QBO_LIVE_QBO_PULL). With the worker now draining ALL companies, a global
 * env can't keep company #2 in dry-run while company #1 is live.
 *
 * The decision moves PER COMPANY (migration 144 added
 * integration_connections.qbo_live_enabled). The contract:
 *
 *     live = globalKillSwitchOn AND companyFlagOn
 *
 * - globalKillSwitchOn comes from the existing QBO_LIVE_* env. It is now a
 *   CLUSTER-WIDE KILL SWITCH: if the env is '0'/unset, NO company goes live
 *   regardless of its per-company flag. Fail-safe.
 * - companyFlagOn comes from integration_connections.qbo_live_enabled for
 *   the company's provider='qbo' connection.
 *
 * BOTH must be true for a real Intuit POST. Either off → dry-run (stub
 * synthetic ids, full deterministic plumbing, zero QBO HTTP). DEFAULT is
 * dry-run for every company (the column defaults false), so no company goes
 * live by accident.
 */

/**
 * Read the global kill switch from an env var name. A single helper so every
 * call site agrees on the '1'-means-on convention used everywhere else.
 */
export function globalKillSwitchOn(envVarName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[envVarName] === '1'
}

/**
 * Read the per-company QBO live flag from the company's QBO
 * integration_connections row. Returns false when no QBO connection row
 * exists yet (a company that never connected QBO can never be live) — also
 * fail-safe. Soft-deleted connections (deleted_at set) do not count.
 *
 * Tolerates the OLD schema (pre-migration-144, no qbo_live_enabled column):
 * a column-missing error resolves to false (dry-run), so a worker that
 * deployed ahead of the migration stays safe rather than crashing the drain.
 */
export async function readCompanyQboLiveFlag(client: Pool | PoolClient, companyId: string): Promise<boolean> {
  try {
    const result = await client.query<{ qbo_live_enabled: boolean }>(
      `select qbo_live_enabled
         from integration_connections
        where company_id = $1 and provider = 'qbo' and deleted_at is null
        order by created_at asc
        limit 1`,
      [companyId],
    )
    return result.rows[0]?.qbo_live_enabled === true
  } catch (err) {
    // Pre-rollout tolerance: undefined_column (42703) means the migration
    // hasn't landed yet on this DB. Treat as dry-run rather than failing the
    // whole drain. Any other error propagates.
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42703') {
      return false
    }
    throw err
  }
}

/**
 * Resolve the effective live decision for one company in one drain:
 * global kill switch AND the per-company flag. The single source of truth
 * the push runners call before choosing the live vs stub push fn.
 */
export async function resolveCompanyQboLive(
  client: Pool | PoolClient,
  companyId: string,
  globalEnvVarName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!globalKillSwitchOn(globalEnvVarName, env)) {
    // Cluster-wide kill switch is off — short-circuit, never hit the DB.
    return false
  }
  return readCompanyQboLiveFlag(client, companyId)
}

/**
 * Pure combiner — exposed for unit tests so the AND-gate truth table can be
 * asserted without a DB. live iff both inputs are true.
 */
export function combineQboLive(globalOn: boolean, companyFlagOn: boolean): boolean {
  return globalOn && companyFlagOn
}
