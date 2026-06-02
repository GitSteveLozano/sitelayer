/**
 * RLS forced-coverage audit (the "next asset_deployments gap" catcher).
 *
 * Every customer-tenant table carries a `company_id` column and is supposed to
 * have `company_isolation` RLS ENABLED + FORCED (see docs/SECURITY_RLS.md). The
 * tenant-isolation net is only as strong as its weakest table: migration 118
 * shipped `asset_deployments` with `company_id NOT NULL` but NO policy and RLS
 * off, because it landed AFTER the 066 policy sweep + 085 ENABLE/FORCE flip and
 * nobody added its per-table RLS in the same migration. Migration 145 closed
 * that specific gap; this audit makes the WHOLE class a blocking gate so the
 * next such table fails verification instead of silently shipping unforced.
 *
 * The audit runs a single catalog query against the live (post-migration)
 * Postgres: for every `public` table that has a `company_id` column, read
 * `pg_class.relforcerowsecurity`. Any table that is NOT forced AND is NOT on the
 * documented allowlist below is a finding. Under `RLS_PHASE3_FAIL_ON_LEAK=1`
 * (set by the integration stage of scripts/verify-local.sh) a finding fails the
 * build; otherwise it is reported as a punch-list.
 *
 * Why a DB query rather than a hard-coded table list: the company-scoped surface
 * grows every release, and a hand-maintained list is exactly the thing that
 * missed `asset_deployments`. Reading the real catalog after migrations apply is
 * the source of truth — a new table without forced RLS shows up automatically.
 */

/** One row of the forced-RLS catalog query. */
export type CompanyTableRlsState = {
  table: string
  /** `pg_class.relrowsecurity` — RLS ENABLEd. */
  enabled: boolean
  /** `pg_class.relforcerowsecurity` — RLS FORCEd (the load-bearing flag). */
  forced: boolean
  /** Number of `company_isolation`/other policies on the table. */
  policyCount: number
  /** True when the `company_id` column is nullable (global/internal tables). */
  companyIdNullable: boolean
}

/** A single audit finding: a company_id table that is not forced + not allowlisted. */
export type RlsForceFinding = {
  table: string
  enabled: boolean
  policyCount: number
  companyIdNullable: boolean
  reason: string
}

/**
 * Tables that are INTENTIONALLY not FORCE'd, with the reason. Keep this list
 * tight and documented — it is the ratchet: anything not here that lacks forced
 * RLS fails the gate. When you genuinely close one of the "known gap" entries in
 * a future migration, DELETE it from this list so the gate keeps protecting it.
 */
export const RLS_FORCE_AUDIT_ALLOWLIST: Readonly<Record<string, string>> = {
  // --- Append-only / queue tables: ENABLEd but deliberately NO FORCE so
  //     `pg_dump` running as the table owner can still read them for backups
  //     (migration 078_rls_no_force_for_owner_dumps.sql). The app role is a
  //     non-owner and stays filtered by the policy.
  audit_events: 'no-force pg_dump owner exemption (migration 078)',
  mutation_outbox: 'no-force pg_dump owner exemption (migration 078)',
  sync_events: 'no-force pg_dump owner exemption (migration 078)',
  workflow_event_log: 'no-force pg_dump owner exemption (migration 078)',

  // --- Not strict per-tenant rows: company_id is nullable (global catalog /
  //     cross-company provisioning ledger) or an internal cache keyed by
  //     company. These are not part of the tenant-isolation surface the FORCE
  //     gate protects.
  audit_escrow_entries: 'company_id nullable — append-only escrow ledger (migration 095)',
  scaffold_manufacturers: 'company_id nullable — global + per-company catalog (migration 058)',
  scaffold_systems: 'company_id nullable — global + per-company catalog (migration 058)',
  tenant_provisions: 'company_id nullable — provisioning ledger (migration 119)',
  company_bootstrap_state: 'internal bootstrap-token cache keyed by company_id (migration 014)',

  // --- KNOWN pre-existing gaps (company_id NOT NULL, no forced RLS). These
  //     predate this gate and are tracked for their own follow-up migration —
  //     each is the SAME class as asset_deployments was. The gate snapshots
  //     them here so it is green today and BLOCKS any NEW unlisted offender;
  //     remove an entry the moment a migration forces it.
  company_pricing_overrides: 'KNOWN GAP — pricing override, force in a follow-up migration (071)',
  customer_pricing_overrides: 'KNOWN GAP — pricing override, force in a follow-up migration (071)',
  project_pricing_overrides: 'KNOWN GAP — pricing override, force in a follow-up migration (071)',
  qbo_sync_runs: 'KNOWN GAP — policy exists, ENABLE/FORCE pending follow-up (077/080)',
  rental_rate_tiers: 'KNOWN GAP — rate tiers, force in a follow-up migration (067)',
  takeoff_capture_artifacts: 'KNOWN GAP — capture artifacts, force in a follow-up migration (069)',
  takeoff_drafts: 'KNOWN GAP — takeoff drafts, force in a follow-up migration (066)',
}

/**
 * SQL that returns the forced-RLS state of every `public` table with a
 * `company_id` column. Exported so the audit test and any ops tooling share one
 * definition.
 */
export const COMPANY_TABLE_RLS_STATE_SQL = `
  SELECT c.relname AS table,
         c.relrowsecurity AS enabled,
         c.relforcerowsecurity AS forced,
         (SELECT count(*) FROM pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count,
         EXISTS (
           SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public'
              AND col.table_name = c.relname
              AND col.column_name = 'company_id'
              AND col.is_nullable = 'YES'
         ) AS company_id_nullable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND EXISTS (
       SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'company_id'
     )
   ORDER BY c.relforcerowsecurity, c.relname
`

/**
 * Pure decision function: given the catalog rows, return the tables that are a
 * gate failure (company_id table, RLS not forced, not on the allowlist).
 * Separated from the DB query so it is unit-testable without a database.
 */
export function findUnforcedCompanyTables(
  rows: readonly CompanyTableRlsState[],
  allowlist: Readonly<Record<string, string>> = RLS_FORCE_AUDIT_ALLOWLIST,
): RlsForceFinding[] {
  const findings: RlsForceFinding[] = []
  for (const row of rows) {
    if (row.forced) continue
    if (Object.prototype.hasOwnProperty.call(allowlist, row.table)) continue
    findings.push({
      table: row.table,
      enabled: row.enabled,
      policyCount: row.policyCount,
      companyIdNullable: row.companyIdNullable,
      reason: row.companyIdNullable
        ? 'company_id table without FORCE ROW LEVEL SECURITY (company_id is nullable — allowlist it if global/internal)'
        : 'company_id NOT NULL table without FORCE ROW LEVEL SECURITY (the asset_deployments gap class)',
    })
  }
  return findings
}

/**
 * Run the catalog query against a connected pool and compute findings. The
 * `query` parameter is the minimal pg surface so this works with a Pool or a
 * checked-out client.
 */
export async function auditUnforcedCompanyTables(
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  allowlist: Readonly<Record<string, string>> = RLS_FORCE_AUDIT_ALLOWLIST,
): Promise<{ state: CompanyTableRlsState[]; findings: RlsForceFinding[] }> {
  const result = await query(COMPANY_TABLE_RLS_STATE_SQL)
  const state: CompanyTableRlsState[] = result.rows.map((r) => ({
    table: String(r.table),
    enabled: r.enabled === true,
    forced: r.forced === true,
    policyCount: Number(r.policy_count ?? 0),
    companyIdNullable: r.company_id_nullable === true,
  }))
  return { state, findings: findUnforcedCompanyTables(state, allowlist) }
}
