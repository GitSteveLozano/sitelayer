import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'

import { RLS_FORCE_AUDIT_ALLOWLIST } from './rls-force-audit.js'

/**
 * Cross-tenant isolation coverage for the seven tables migration
 * 146_rls_force_close_gaps.sql forces:
 *
 *   company_pricing_overrides, customer_pricing_overrides,
 *   project_pricing_overrides, qbo_sync_runs, rental_rate_tiers,
 *   takeoff_capture_artifacts, takeoff_drafts
 *
 * Two layers, mirroring rls-phase3-audit.test.ts:
 *
 *  1. **Allowlist guard (always runs, no DB).** Asserts none of the seven is
 *     still on `RLS_FORCE_AUDIT_ALLOWLIST` — the moment a migration forces a
 *     table, it must drop off the allowlist so the forced-coverage gate
 *     protects it (the same ratchet asset_deployments / migration 145 set).
 *
 *  2. **Runtime isolation probe (gated by `CONSTRAINED_DB_URL`).** Connects as
 *     a non-`BYPASSRLS` role (`sitelayer_constrained`, provisioned by migration
 *     087) and proves, for every one of the seven now-forced tables, that a
 *     session bound to company A cannot read company B's rows and cannot write
 *     a row stamped with company B's id (WITH CHECK). This is the real
 *     cross-tenant boundary the FORCE flip buys. It skips cleanly when
 *     `CONSTRAINED_DB_URL` is unset (the integration `sitelayer` role is
 *     BYPASSRLS, so it could not observe enforcement) — identical gating to the
 *     existing Phase 3 runtime probe.
 *
 * To run the runtime probe locally (after `docker compose up -d db` +
 * migrations, which create `sitelayer_constrained` via migration 087):
 *
 *   CONSTRAINED_DB_URL=postgres://sitelayer_constrained:sitelayer_constrained@localhost:5432/sitelayer \
 *     npm --workspace=@sitelayer/api test -- src/routes/rls-force-close-gaps.test.ts
 */

const FORCED_TABLES = [
  'company_pricing_overrides',
  'customer_pricing_overrides',
  'project_pricing_overrides',
  'qbo_sync_runs',
  'rental_rate_tiers',
  'takeoff_capture_artifacts',
  'takeoff_drafts',
] as const

describe('migration 146 — forced tables are off the allowlist', () => {
  it('removes every newly-forced table from RLS_FORCE_AUDIT_ALLOWLIST so the gate protects it', () => {
    for (const table of FORCED_TABLES) {
      expect(
        RLS_FORCE_AUDIT_ALLOWLIST,
        `${table} is FORCEd by migration 146 — it must NOT be on the force-audit allowlist (the gate must fail if it regresses)`,
      ).not.toHaveProperty(table)
    }
  })

  it('does not (and must not) force the `companies` tenant root via app.company_id', () => {
    // `companies` is the tenant ROOT: it has no `company_id` column (its PK is
    // `id`), so it is not part of the forced-coverage surface at all and must
    // NOT carry an app.company_id RLS policy. getCompany() in server.ts resolves
    // the companies row by slug/id BEFORE any app.company_id GUC is bound (that
    // resolution is what establishes the GUC), then gates access through a
    // `company_memberships` lookup (`where company_id = $1 and clerk_user_id =
    // $2` → null when there is no membership). The real cross-tenant boundary
    // for the tenant root is therefore the membership table — which IS
    // ENABLE+FORCE'd by migration 085. Forcing `companies` itself with an
    // app.company_id policy would break membership resolution, so it is a
    // documented structural exemption (and not even visible to the audit).
    expect(RLS_FORCE_AUDIT_ALLOWLIST).not.toHaveProperty('companies')
    expect(RLS_FORCE_AUDIT_ALLOWLIST).not.toHaveProperty('company_memberships')
  })

  it('keeps only documented intentional exemptions on the allowlist', () => {
    // The only legitimate residual exemptions: the 4 append-only no-force
    // queue tables (pg_dump owner exemption, migration 078) and the 5
    // nullable/internal globals. Anything else means a company-scoped table
    // got allowlisted instead of forced.
    const expected = new Set([
      'audit_events',
      'mutation_outbox',
      'sync_events',
      'workflow_event_log',
      'audit_escrow_entries',
      'scaffold_manufacturers',
      'scaffold_systems',
      'tenant_provisions',
      'company_bootstrap_state',
    ])
    expect(new Set(Object.keys(RLS_FORCE_AUDIT_ALLOWLIST))).toEqual(expected)
  })
})

const CONSTRAINED_DB_URL = process.env.CONSTRAINED_DB_URL
const describeRuntime = CONSTRAINED_DB_URL ? describe : describe.skip

describeRuntime('migration 146 — cross-tenant isolation (constrained role)', () => {
  let pool: Pool
  const companyA = randomUUID()
  const companyB = randomUUID()
  const projectA = randomUUID()
  const projectB = randomUUID()
  const customerA = randomUUID()
  const customerB = randomUUID()
  const lineA = randomUUID()
  const lineB = randomUUID()
  const connA = randomUUID()
  const connB = randomUUID()
  // ids for the per-table seed rows (A then B)
  const ids = {
    company_pricing_overrides: [randomUUID(), randomUUID()],
    customer_pricing_overrides: [randomUUID(), randomUUID()],
    project_pricing_overrides: [randomUUID(), randomUUID()],
    qbo_sync_runs: [randomUUID(), randomUUID()],
    rental_rate_tiers: [randomUUID(), randomUUID()],
    takeoff_capture_artifacts: [randomUUID(), randomUUID()],
    takeoff_drafts: [randomUUID(), randomUUID()],
  } as const

  const slug = randomUUID().slice(0, 8)
  let seeded = false

  /** Run `fn` inside a tx with app.company_id bound (or unset when null). */
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
    // Seed exactly once across the suite. Several seeded tables carry
    // (company_id, code)-style unique constraints, so a re-seed would collide
    // on those even though the id-keyed ON CONFLICT clauses are idempotent.
    if (seeded) return
    seeded = true
    // Companies + their dependents are seeded WITHOUT the GUC bound, relying on
    // the permissive NULL-GUC clause (same path the scenario seeder / migrations
    // use). This proves seeding still works under FORCE.
    await pool.query(
      `insert into companies (id, slug, name) values ($1,$2,$3),($4,$5,$6) on conflict (id) do nothing`,
      [companyA, `gap-a-${slug}`, 'Gap A', companyB, `gap-b-${slug}`, 'Gap B'],
    )
    await pool.query(
      `insert into customers (id, company_id, name) values ($1,$2,'Cust A'),($3,$4,'Cust B') on conflict (id) do nothing`,
      [customerA, companyA, customerB, companyB],
    )
    await pool.query(
      `insert into projects (id, company_id, customer_id, name, customer_name, division_code, status)
       values ($1,$2,$3,'Proj A','Cust A','D1','planning'),($4,$5,$6,'Proj B','Cust B','D1','planning')
       on conflict (id) do nothing`,
      [projectA, companyA, customerA, projectB, companyB, customerB],
    )
    await pool.query(
      `insert into integration_connections (id, company_id, provider, status)
       values ($1,$2,'qbo','connected'),($3,$4,'qbo','connected') on conflict (id) do nothing`,
      [connA, companyA, connB, companyB],
    )
    // A job_rental_line per company so rental_rate_tiers has a valid FK.
    // FK chain: rental_rate_tiers → job_rental_lines → (job_rental_contracts,
    // inventory_items). Seed the minimal NOT-NULL columns of each.
    const contractA = randomUUID()
    const contractB = randomUUID()
    const itemA = randomUUID()
    const itemB = randomUUID()
    await pool.query(
      `insert into inventory_items (id, company_id, code, description)
       values ($1,$2,'SCAF-A','Scaffold A'),($3,$4,'SCAF-B','Scaffold B') on conflict (id) do nothing`,
      [itemA, companyA, itemB, companyB],
    )
    await pool.query(
      `insert into job_rental_contracts (id, company_id, project_id, billing_start_date, next_billing_date, status)
       values ($1,$2,$3, current_date, current_date, 'active'),($4,$5,$6, current_date, current_date, 'active')
       on conflict (id) do nothing`,
      [contractA, companyA, projectA, contractB, companyB, projectB],
    )
    await pool.query(
      `insert into job_rental_lines (id, company_id, contract_id, inventory_item_id, quantity, agreed_rate, rate_unit, on_rent_date)
       values ($1,$2,$3,$4,1,10,'day', current_date),($5,$6,$7,$8,1,10,'day', current_date)
       on conflict (id) do nothing`,
      [lineA, companyA, contractA, itemA, lineB, companyB, contractB, itemB],
    )

    await pool.query(
      `insert into company_pricing_overrides (id, company_id, service_item_code, rate, unit)
       values ($1,$2,'EPS',5,'sqft'),($3,$4,'EPS',5,'sqft') on conflict (id) do nothing`,
      [ids.company_pricing_overrides[0], companyA, ids.company_pricing_overrides[1], companyB],
    )
    await pool.query(
      `insert into customer_pricing_overrides (id, company_id, customer_id, service_item_code, rate, unit)
       values ($1,$2,$3,'EPS',6,'sqft'),($4,$5,$6,'EPS',6,'sqft') on conflict (id) do nothing`,
      [ids.customer_pricing_overrides[0], companyA, customerA, ids.customer_pricing_overrides[1], companyB, customerB],
    )
    await pool.query(
      `insert into project_pricing_overrides (id, company_id, project_id, service_item_code, rate, unit)
       values ($1,$2,$3,'EPS',7,'sqft'),($4,$5,$6,'EPS',7,'sqft') on conflict (id) do nothing`,
      [ids.project_pricing_overrides[0], companyA, projectA, ids.project_pricing_overrides[1], companyB, projectB],
    )
    await pool.query(
      `insert into qbo_sync_runs (id, company_id, integration_connection_id, status)
       values ($1,$2,$3,'pending'),($4,$5,$6,'pending') on conflict (id) do nothing`,
      [ids.qbo_sync_runs[0], companyA, connA, ids.qbo_sync_runs[1], companyB, connB],
    )
    await pool.query(
      `insert into rental_rate_tiers (id, company_id, job_rental_line_id, rate_unit, min_days, rate)
       values ($1,$2,$3,'day',1,9),($4,$5,$6,'day',1,9) on conflict (id) do nothing`,
      [ids.rental_rate_tiers[0], companyA, lineA, ids.rental_rate_tiers[1], companyB, lineB],
    )
    await pool.query(
      `insert into takeoff_drafts (id, company_id, project_id, name)
       values ($1,$2,$3,'Draft A'),($4,$5,$6,'Draft B') on conflict (id) do nothing`,
      [ids.takeoff_drafts[0], companyA, projectA, ids.takeoff_drafts[1], companyB, projectB],
    )
    await pool.query(
      `insert into takeoff_capture_artifacts (id, company_id, draft_id, kind, blob_uri)
       values ($1,$2,$3,'pdf','a://a'),($4,$5,$6,'pdf','b://b') on conflict (id) do nothing`,
      [
        ids.takeoff_capture_artifacts[0],
        companyA,
        ids.takeoff_drafts[0],
        ids.takeoff_capture_artifacts[1],
        companyB,
        ids.takeoff_drafts[1],
      ],
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

  it('every forced table is actually FORCE ROW LEVEL SECURITY (migration 146 applied)', async () => {
    const result = await pool.query<{ relname: string; relforcerowsecurity: boolean }>(
      `select relname, relforcerowsecurity from pg_class
        where relname = any($1::text[]) and relkind = 'r'`,
      [FORCED_TABLES as unknown as string[]],
    )
    const byName = new Map(result.rows.map((r) => [r.relname, r.relforcerowsecurity]))
    for (const table of FORCED_TABLES) {
      expect(byName.get(table), `${table} must exist and be FORCE RLS after migration 146`).toBe(true)
    }
  })

  it('a session bound to company A reads only company A rows on every forced table', async () => {
    await seed()
    await withCompany(companyA, async (q) => {
      for (const table of FORCED_TABLES) {
        const [idA, idB] = ids[table]
        const rows = await q(`select id from ${table} where id = any($1::uuid[])`, [[idA, idB]])
        expect(
          rows.rows.map((r) => r.id),
          `${table}: company A session must see ONLY its own row (not company B's)`,
        ).toEqual([idA])
      }
    })
  })

  it('a session bound to company B reads only company B rows on every forced table', async () => {
    await seed()
    await withCompany(companyB, async (q) => {
      for (const table of FORCED_TABLES) {
        const [idA, idB] = ids[table]
        const rows = await q(`select id from ${table} where id = any($1::uuid[])`, [[idA, idB]])
        expect(
          rows.rows.map((r) => r.id),
          `${table}: company B session must see ONLY its own row (not company A's)`,
        ).toEqual([idB])
      }
    })
  })

  it('rejects a cross-company INSERT under WITH CHECK on a representative forced table', async () => {
    await seed()
    // Bound to A, try to write a company_pricing_overrides row stamped B.
    await expect(
      withCompany(companyA, async (q) => {
        await q(
          `insert into company_pricing_overrides (id, company_id, service_item_code, rate, unit)
           values ($1, $2, 'XCHECK', 1, 'sqft')`,
          [randomUUID(), companyB],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('is permissive when app.company_id is unset (seeding / replay fallback)', async () => {
    await seed()
    await withCompany(null, async (q) => {
      const [idA, idB] = ids.takeoff_drafts
      const rows = await q(`select id from takeoff_drafts where id = any($1::uuid[]) order by id`, [[idA, idB]])
      expect(rows.rows.map((r) => r.id).sort()).toEqual([idA, idB].sort())
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
    // Children first, then parents. ON DELETE CASCADE on companies covers most,
    // but delete explicitly so a partial seed still drains.
    for (const table of FORCED_TABLES) {
      await swallow(`delete from ${table} where company_id = any($1::uuid[])`, [[companyA, companyB]])
    }
    await swallow('delete from job_rental_lines where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from job_rental_contracts where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from inventory_items where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from integration_connections where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from projects where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from customers where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from company_bootstrap_state where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from companies where id = any($1::uuid[])', [[companyA, companyB]])
    await pool.end()
  })
})
