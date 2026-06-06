import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'

import { getCompanySetting, setCompanySetting, deleteCompanySetting, listCompanySettings } from '@sitelayer/domain'
import { RLS_FORCE_AUDIT_ALLOWLIST } from './rls-force-audit.js'

/**
 * Coverage for the generic per-company settings store (migration 152) + its
 * @sitelayer/domain helper. Three layers, mirroring rls-force-close-gaps.test.ts:
 *
 *  1. **Allowlist guard (always runs, no DB).** `company_settings` is a
 *     `company_id NOT NULL` child table, so the forced-coverage RLS audit
 *     (rls-force-audit.ts) will fail the deploy gate unless the table is
 *     ENABLE+FORCE'd. It must therefore NOT be on RLS_FORCE_AUDIT_ALLOWLIST —
 *     migration 152 forces it, so the gate protects it. This is the same ratchet
 *     migrations 145/146 set.
 *
 *  2. **Helper round-trip (gated by RUN_API_INTEGRATION).** Runs the real
 *     getCompanySetting / setCompanySetting against the migrated throwaway
 *     Postgres the deploy gate stands up: read/write, default-fallback,
 *     type-mismatch fallback, and company-scoping (company A's setting is
 *     invisible to company B). This runs under the integration `sitelayer` role
 *     (BYPASSRLS in CI), so it proves the APP-LAYER `where company_id = $1`
 *     scoping — the half that holds regardless of RLS.
 *
 *  3. **RLS isolation probe (gated by CONSTRAINED_DB_URL).** Connects as the
 *     non-BYPASSRLS `sitelayer_constrained` role (migration 087) and proves the
 *     DB-level FORCE actually blocks a cross-company read and rejects a
 *     cross-company INSERT under WITH CHECK. Skips cleanly when the var is unset
 *     (the integration role bypasses RLS so it could not observe enforcement) —
 *     identical gating to the Phase 3 / force-close-gaps runtime probes.
 *
 * To run the RLS probe locally (after migrations create sitelayer_constrained):
 *   CONSTRAINED_DB_URL=postgres://sitelayer_constrained:sitelayer_constrained@localhost:5432/sitelayer \
 *     npm --workspace=@sitelayer/api test -- src/routes/company-settings.test.ts
 */

describe('migration 152 — company_settings is force-audited, not allowlisted', () => {
  it('is NOT on RLS_FORCE_AUDIT_ALLOWLIST (the FORCE gate must protect it)', () => {
    expect(
      RLS_FORCE_AUDIT_ALLOWLIST,
      'company_settings is a company_id child table FORCEd by migration 152 — it must not be allowlisted, ' +
        'so the force-audit gate fails if its RLS ever regresses',
    ).not.toHaveProperty('company_settings')
  })
})

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'
const describeIntegration = process.env.RUN_API_INTEGRATION === '1' ? describe : describe.skip

describeIntegration('company_settings helper — real Postgres (migration 152)', () => {
  let pool: Pool
  const companyA = randomUUID()
  const companyB = randomUUID()
  const slug = randomUUID().slice(0, 8)

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
    await pool.query(
      `insert into companies (id, slug, name) values ($1,$2,$3),($4,$5,$6) on conflict (id) do nothing`,
      [companyA, `cs-a-${slug}`, 'CS A', companyB, `cs-b-${slug}`, 'CS B'],
    )
  })

  afterAll(async () => {
    if (!pool) return
    const swallow = async (sql: string, params: unknown[] = []) => {
      try {
        await pool.query(sql, params)
      } catch {
        // best-effort teardown
      }
    }
    await swallow('delete from company_settings where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from company_bootstrap_state where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from companies where id = any($1::uuid[])', [[companyA, companyB]])
    await pool.end()
  })

  it('round-trips bool / number / string / object through real jsonb', async () => {
    await setCompanySetting(pool, companyA, 'notifications.digest_enabled', true)
    expect(await getCompanySetting(pool, companyA, 'notifications.digest_enabled', false)).toBe(true)

    await setCompanySetting(pool, companyA, 'billing.cap', 5000)
    expect(await getCompanySetting(pool, companyA, 'billing.cap', 0)).toBe(5000)

    await setCompanySetting(pool, companyA, 'branding.accent', '#0a0')
    expect(await getCompanySetting(pool, companyA, 'branding.accent', '#fff')).toBe('#0a0')

    await setCompanySetting(pool, companyA, 'limits', { seats: 10 })
    expect(await getCompanySetting<Record<string, unknown>>(pool, companyA, 'limits', {})).toEqual({ seats: 10 })
  })

  it('returns the call-site default when a key is absent', async () => {
    expect(await getCompanySetting(pool, companyA, 'never.set', 'fallback')).toBe('fallback')
    expect(await getCompanySetting(pool, companyA, 'never.set', 7)).toBe(7)
  })

  it('upserts in place (a second write overwrites, no duplicate row)', async () => {
    await setCompanySetting(pool, companyA, 'upsert.k', 1)
    await setCompanySetting(pool, companyA, 'upsert.k', 2)
    const count = await pool.query<{ n: string }>(
      'select count(*)::text as n from company_settings where company_id = $1 and key = $2',
      [companyA, 'upsert.k'],
    )
    expect(count.rows[0]?.n).toBe('1')
    expect(await getCompanySetting(pool, companyA, 'upsert.k', 0)).toBe(2)
  })

  it('falls back to the default when the stored jsonb type mismatches', async () => {
    await setCompanySetting(pool, companyA, 'mismatch', 'a-string')
    // Caller expects a boolean → the string row is treated as absent.
    expect(await getCompanySetting(pool, companyA, 'mismatch', false)).toBe(false)
  })

  it('scopes by company: A cannot read B (same key, distinct values)', async () => {
    await setCompanySetting(pool, companyA, 'shared.key', 'A-value')
    await setCompanySetting(pool, companyB, 'shared.key', 'B-value')
    expect(await getCompanySetting(pool, companyA, 'shared.key', 'def')).toBe('A-value')
    expect(await getCompanySetting(pool, companyB, 'shared.key', 'def')).toBe('B-value')
    // A key set only for A returns the default for B.
    await setCompanySetting(pool, companyA, 'a.only', 'secret')
    expect(await getCompanySetting(pool, companyB, 'a.only', 'b-default')).toBe('b-default')
  })

  it('listCompanySettings returns only the requesting company', async () => {
    const aMap = await listCompanySettings(pool, companyA)
    const bMap = await listCompanySettings(pool, companyB)
    expect(aMap['shared.key']).toBe('A-value')
    expect(bMap['shared.key']).toBe('B-value')
    expect(bMap).not.toHaveProperty('a.only')
  })

  it('deletes a setting (reverts to default)', async () => {
    await setCompanySetting(pool, companyA, 'temp', 'x')
    expect(await deleteCompanySetting(pool, companyA, 'temp')).toBe(true)
    expect(await deleteCompanySetting(pool, companyA, 'temp')).toBe(false)
    expect(await getCompanySetting(pool, companyA, 'temp', 'gone')).toBe('gone')
  })
})

const CONSTRAINED_DB_URL = process.env.CONSTRAINED_DB_URL
const describeRuntime = CONSTRAINED_DB_URL ? describe : describe.skip

describeRuntime('migration 152 — company_settings RLS isolation (constrained role)', () => {
  let pool: Pool
  const companyA = randomUUID()
  const companyB = randomUUID()
  const slug = randomUUID().slice(0, 8)
  let seeded = false

  async function withCompany<T>(
    companyId: string | null,
    fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('begin')
      if (companyId) {
        await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])
      }
      const result = await fn((sql, params) => client.query(sql, params))
      await client.query('commit')
      return result
    } catch (err) {
      await client.query('rollback').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  async function seed() {
    if (seeded) return
    seeded = true
    // Seed WITHOUT the GUC bound (permissive NULL-GUC clause) — proves seeding
    // works under FORCE, same as the scenario seeder / migrations.
    await pool.query(
      `insert into companies (id, slug, name) values ($1,$2,$3),($4,$5,$6) on conflict (id) do nothing`,
      [companyA, `csr-a-${slug}`, 'CSR A', companyB, `csr-b-${slug}`, 'CSR B'],
    )
    await pool.query(
      `insert into company_settings (company_id, key, value) values ($1,'k','"A"'::jsonb),($2,'k','"B"'::jsonb)
       on conflict (company_id, key) do nothing`,
      [companyA, companyB],
    )
  }

  it('confirms the configured role is NOT a BYPASSRLS superuser', async () => {
    pool = new Pool({ connectionString: CONSTRAINED_DB_URL, max: 2 })
    const result = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'select rolbypassrls, rolsuper from pg_roles where rolname = current_user',
    )
    const row = result.rows[0]
    expect(row, 'CONSTRAINED_DB_URL must point at a role visible in pg_roles').toBeDefined()
    if (!row) return
    expect(row.rolbypassrls, 'CONSTRAINED_DB_URL must point at a NOBYPASSRLS role').toBe(false)
    expect(row.rolsuper, 'CONSTRAINED_DB_URL must point at a non-superuser role').toBe(false)
  })

  it('company_settings is FORCE ROW LEVEL SECURITY (migration 152 applied)', async () => {
    const result = await pool.query<{ relforcerowsecurity: boolean }>(
      `select relforcerowsecurity from pg_class where relname = 'company_settings' and relkind = 'r'`,
    )
    expect(result.rows[0]?.relforcerowsecurity, 'company_settings must be FORCE RLS after migration 152').toBe(true)
  })

  it('a session bound to company A reads only company A rows', async () => {
    await seed()
    await withCompany(companyA, async (q) => {
      const rows = await q(`select company_id, value from company_settings where key = 'k'`)
      expect(rows.rows.map((r) => r.company_id)).toEqual([companyA])
    })
    await withCompany(companyB, async (q) => {
      const rows = await q(`select company_id, value from company_settings where key = 'k'`)
      expect(rows.rows.map((r) => r.company_id)).toEqual([companyB])
    })
  })

  it('rejects a cross-company INSERT under WITH CHECK', async () => {
    await seed()
    await expect(
      withCompany(companyA, async (q) => {
        await q(`insert into company_settings (company_id, key, value) values ($1, 'xcheck', '1'::jsonb)`, [companyB])
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('is permissive when app.company_id is unset (seeding / replay fallback)', async () => {
    await seed()
    await withCompany(null, async (q) => {
      const rows = await q(`select company_id from company_settings where key = 'k' order by company_id`)
      expect(rows.rows.map((r) => r.company_id).sort()).toEqual([companyA, companyB].sort())
    })
  })

  afterAll(async () => {
    if (!pool) return
    const swallow = async (sql: string, params: unknown[] = []) => {
      try {
        await pool.query(sql, params)
      } catch {
        // best-effort teardown
      }
    }
    await swallow('delete from company_settings where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from company_bootstrap_state where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from companies where id = any($1::uuid[])', [[companyA, companyB]])
    await pool.end()
  })
})
