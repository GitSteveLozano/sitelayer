/**
 * Per-company settings helper — THE convention for per-company config.
 *
 * Per-company config kept accreting as new COLUMNS, one migration per setting
 * (migration 144 added integration_connections.qbo_live_enabled; 150 added
 * companies.notification_from_email / notification_from_name). On the only
 * durable tier (DigitalOcean Managed Postgres) every migration is forward-only,
 * immutable, and checksum-ledgered, so "add the 20th per-company flag" is a real
 * schema change that ships through the deploy gate.
 *
 * This module makes the NEXT per-company setting a CODE change, not a migration.
 * It is backed by the generic `company_settings` table (migration 152): one row
 * per `(company_id, key)` with a `jsonb` value. A new toggle is a new key + a
 * call-site default — no ALTER TABLE.
 *
 *   const digest = await getCompanySetting(client, companyId, 'notifications.digest_enabled', false)
 *   await setCompanySetting(client, companyId, 'notifications.digest_enabled', true)
 *
 * ## Why not companies.modules (migration 062)
 * `companies.modules` is a FIXED-SHAPE typed boolean feature-pack consumed by a
 * typed API (CompanyModulesPatchSchema). It is the wrong home for arbitrary,
 * heterogeneously-typed settings, and it lives on `companies` — the tenant ROOT,
 * deliberately NOT in the RLS-FORCE set. `company_settings` is a company-scoped
 * CHILD table with the same `app.company_id` RLS-FORCE every other per-tenant
 * table has, so the store is isolated at the DB layer too.
 *
 * ## Lives in @sitelayer/domain (no `pg` dependency)
 * Both apps/api and apps/worker need this. Rather than duplicate it (the
 * company-notification-sender precedent) or pull `pg` into the pure domain
 * package, the helper takes a STRUCTURAL `SettingsExecutor` ({ query }) — a
 * `Pool`, a `PoolClient`, or a withCompanyClient-scoped client all satisfy it.
 *
 * ## Safety
 * - **Company-scoped:** every query carries an explicit `where company_id = $1`,
 *   so isolation holds even under the CI/dev `sitelayer` role that BYPASSes RLS.
 *   In prod the table is RLS ENABLE+FORCE'd (migration 152), so a missing /
 *   wrong GUC is a DB-level backstop on top of the app-layer predicate.
 * - **Default-fallback:** a missing row returns the call-site default. A stored
 *   value whose JSON type does not match the default's type also falls back to
 *   the default (a corrupt/legacy value can never crash a reader or silently
 *   coerce a bool into a string).
 * - **Rollout-tolerant:** if the table does not exist yet (worker deployed ahead
 *   of migration 152 → `42P01 undefined_table`), the read returns the default
 *   instead of throwing, mirroring resolveCompanyNotificationSender's `42703`
 *   handling. Writes still surface the missing-table error (a write that can't
 *   persist must not look like success).
 */

/** Postgres SQLSTATE for `undefined_table` (relation does not exist). */
const PG_UNDEFINED_TABLE = '42P01'

/**
 * Minimal structural surface the helper needs. A `pg` `Pool` / `PoolClient`, or
 * any `withCompanyClient`-scoped client, satisfies this without `@sitelayer/domain`
 * taking a `pg` dependency. The generic preserves the row shape per call.
 */
export interface SettingsExecutor {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: R[] }>
}

/** Values a setting may hold. `jsonb` admits objects/arrays too; the helper is
 * type-checked against the call-site default, which is one of these. */
export type CompanySettingValue = boolean | number | string | Record<string, unknown> | unknown[]

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === PG_UNDEFINED_TABLE
  )
}

/**
 * True when `value` is the SAME broad JSON type as `expected`. Guards the
 * default-fallback: a stored value of a different shape than the call-site
 * default is treated as absent. Arrays and plain objects are distinguished so a
 * `[]` default never accepts a `{}` row and vice-versa.
 */
function sameJsonType(value: unknown, expected: CompanySettingValue): boolean {
  if (Array.isArray(expected)) return Array.isArray(value)
  if (expected !== null && typeof expected === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }
  return typeof value === typeof expected
}

/**
 * Read a per-company setting. Returns the stored value when present AND its JSON
 * type matches `defaultValue`; otherwise returns `defaultValue`. Never throws on
 * a missing table (returns the default) — but DOES propagate real DB errors
 * (connection, permission) so they are not masked.
 *
 * The return type is widened to the default's type `T`, so the call site stays
 * fully typed:
 *   const cap: number = await getCompanySetting(client, id, 'billing.cap', 0)
 */
export async function getCompanySetting<T extends CompanySettingValue>(
  executor: SettingsExecutor,
  companyId: string,
  key: string,
  defaultValue: T,
): Promise<T> {
  let rows: Array<{ value: unknown }>
  try {
    const result = await executor.query<{ value: unknown }>(
      `select value from company_settings where company_id = $1 and key = $2 limit 1`,
      [companyId, key],
    )
    rows = result.rows
  } catch (err) {
    if (isUndefinedTable(err)) return defaultValue
    throw err
  }
  const row = rows[0]
  if (!row) return defaultValue
  // `jsonb` columns come back already JSON-parsed from node-postgres.
  if (!sameJsonType(row.value, defaultValue)) return defaultValue
  return row.value as T
}

/**
 * Upsert a per-company setting. Inserts the row or overwrites the existing
 * `(company_id, key)` value, stamping `updated_at = now()` (repo convention —
 * there are no updated_at triggers). Returns the value that was written.
 *
 * Unlike the read path this does NOT swallow a missing-table error: a write that
 * cannot persist must surface, not look like success.
 */
export async function setCompanySetting<T extends CompanySettingValue>(
  executor: SettingsExecutor,
  companyId: string,
  key: string,
  value: T,
): Promise<T> {
  await executor.query(
    `insert into company_settings (company_id, key, value)
       values ($1, $2, $3::jsonb)
     on conflict (company_id, key)
       do update set value = excluded.value, updated_at = now()`,
    [companyId, key, JSON.stringify(value)],
  )
  return value
}

/**
 * Delete a per-company setting (revert to the call-site default). Returns true
 * when a row was removed. Tolerates the missing table (returns false) so it is
 * safe ahead of migration 152.
 */
export async function deleteCompanySetting(
  executor: SettingsExecutor,
  companyId: string,
  key: string,
): Promise<boolean> {
  try {
    const result = await executor.query<{ id: unknown }>(
      `delete from company_settings where company_id = $1 and key = $2 returning id`,
      [companyId, key],
    )
    return result.rows.length > 0
  } catch (err) {
    if (isUndefinedTable(err)) return false
    throw err
  }
}

/**
 * Read EVERY setting for a company as a `{ key: value }` map. Used by an admin
 * settings screen / debug route. Company-scoped + missing-table-tolerant like
 * the single-key read.
 */
export async function listCompanySettings(
  executor: SettingsExecutor,
  companyId: string,
): Promise<Record<string, unknown>> {
  let rows: Array<{ key: string; value: unknown }>
  try {
    const result = await executor.query<{ key: string; value: unknown }>(
      `select key, value from company_settings where company_id = $1 order by key`,
      [companyId],
    )
    rows = result.rows
  } catch (err) {
    if (isUndefinedTable(err)) return {}
    throw err
  }
  const out: Record<string, unknown> = {}
  for (const r of rows) out[r.key] = r.value
  return out
}

// ── Read-through for the two legacy per-company columns ──────────────────────
//
// The existing qbo_live_enabled (migration 144) and notification_from_*
// (migration 150) columns WORK and are tested — this slice does not rip them
// out. But so that future code can read them through ONE convention, these
// canonical keys + readers expose them via the helper surface. They read the
// real columns (NOT company_settings), so there is no dual-write/drift: the
// column stays the source of truth, the helper is just a uniform read path.
//
// New settings should NOT add a reader here — they should use a plain
// getCompanySetting() key backed by company_settings. This block exists only to
// fold the two pre-existing columns into the same vocabulary.

/** Canonical setting keys for the two pre-existing per-company columns. */
export const LEGACY_COLUMN_SETTING_KEYS = {
  /** integration_connections.notification_from_email is on `companies`; this is
   * the per-(company) QBO live flag on integration_connections (provider='qbo'). */
  qboLiveEnabled: 'integrations.qbo.live_enabled',
  notificationFromEmail: 'notifications.from_email',
  notificationFromName: 'notifications.from_name',
} as const

/**
 * Read the per-company QBO live flag THROUGH the helper vocabulary. Source of
 * truth remains `integration_connections.qbo_live_enabled` (migration 144) for
 * the company's `provider='qbo'` row; this is a uniform read, not a migration of
 * the data. Returns `false` (the column default / fail-safe) when there is no
 * qbo connection row or the table predates the column.
 */
export async function getQboLiveEnabled(executor: SettingsExecutor, companyId: string): Promise<boolean> {
  try {
    const result = await executor.query<{ qbo_live_enabled: boolean | null }>(
      `select qbo_live_enabled
         from integration_connections
        where company_id = $1 and provider = 'qbo'
        order by qbo_live_enabled desc nulls last
        limit 1`,
      [companyId],
    )
    return result.rows[0]?.qbo_live_enabled === true
  } catch (err) {
    // Pre-migration-144 (column absent, 42703) or no integration_connections
    // table → fail-safe false, never throw on the read path.
    if (
      isUndefinedTable(err) ||
      (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '42703')
    ) {
      return false
    }
    throw err
  }
}

/**
 * Read the per-company notification sender columns (migration 150) THROUGH the
 * helper vocabulary as `{ email, name }`. Source of truth remains the
 * `companies` columns; both are NULL by default (env fallback handled by
 * resolveCompanyNotificationSender, unchanged). Returns nulls when absent.
 */
export async function getNotificationFrom(
  executor: SettingsExecutor,
  companyId: string,
): Promise<{ email: string | null; name: string | null }> {
  try {
    const result = await executor.query<{
      notification_from_email: string | null
      notification_from_name: string | null
    }>(`select notification_from_email, notification_from_name from companies where id = $1 limit 1`, [companyId])
    const row = result.rows[0]
    return {
      email: row?.notification_from_email ?? null,
      name: row?.notification_from_name ?? null,
    }
  } catch (err) {
    if (
      isUndefinedTable(err) ||
      (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '42703')
    ) {
      return { email: null, name: null }
    }
    throw err
  }
}
