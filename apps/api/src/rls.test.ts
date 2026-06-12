import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'

/**
 * Proves the row-level-security policies (originally migration 066, now baked
 * into 000_baseline.sql) actually scope rows to `app.company_id`. The baseline
 * ships `projects` ENABLE+FORCE'd; these tests re-assert that posture, verify
 * the policy works, and leave the table in the same baseline state on
 * teardown.
 *
 * GATED separately from RUN_API_INTEGRATION because the CI postgres role
 * (`sitelayer`) is a SUPERUSER by default in the postgres:18-alpine image,
 * and superusers bypass RLS regardless of `FORCE ROW LEVEL SECURITY`. To run
 * this test, point DATABASE_URL at a non-superuser role with select/insert/
 * delete on `projects` and `companies`, then set `RUN_RLS_TEST=1`. Phase 2
 * of the RLS rollout (docs/SECURITY_RLS.md) provisions that role.
 */
const describeIntegration =
  process.env.RUN_API_INTEGRATION === '1' && process.env.RUN_RLS_TEST === '1' ? describe : describe.skip

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'

describeIntegration('row-level security (migration 066)', () => {
  let pool: Pool
  let companyA: string
  let companyB: string
  let projectA: string
  let projectB: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
    companyA = randomUUID()
    companyB = randomUUID()
    projectA = randomUUID()
    projectB = randomUUID()
    await pool.query(
      'insert into companies (id, slug, name) values ($1, $2, $3), ($4, $5, $6) on conflict (id) do nothing',
      [
        companyA,
        `rls-test-a-${companyA.slice(0, 8)}`,
        'RLS Test A',
        companyB,
        `rls-test-b-${companyB.slice(0, 8)}`,
        'RLS Test B',
      ],
    )
    await pool.query(
      `insert into projects (id, company_id, name, customer_name, division_code, status)
       values ($1, $2, 'A project', 'A customer', 'D1', 'planning'),
              ($3, $4, 'B project', 'B customer', 'D1', 'planning')
       on conflict (id) do nothing`,
      [projectA, companyA, projectB, companyB],
    )
    await pool.query('alter table projects enable row level security')
    await pool.query('alter table projects force row level security')
  })

  afterAll(async () => {
    if (!pool) return
    // Cleanup is best-effort — a teardown failure should never mask a
    // test assertion failure. Each step is independently try/caught so a
    // half-rolled-back state still drains as much as possible.
    const swallow = async (sql: string, params: unknown[] = []) => {
      try {
        await pool.query(sql, params)
      } catch {
        // best-effort
      }
    }
    // Restore the BASELINE posture: 000_baseline.sql ships projects
    // ENABLE+FORCE'd, so leave it that way (the pre-squash version of this
    // test disabled RLS here, which drifted the DB from baseline and failed
    // any later forced-coverage audit against the same database).
    await swallow('alter table projects enable row level security')
    await swallow('alter table projects force row level security')
    // Drop the bootstrap-state rows our fixtures created so the projects
    // DELETE trigger doesn't fail FK if companies are wiped by an
    // adjacent test before our cleanup runs.
    await swallow('delete from company_bootstrap_state where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from projects where id = any($1::uuid[])', [[projectA, projectB]])
    await swallow('delete from companies where id = any($1::uuid[])', [[companyA, companyB]])
    await pool.end()
  })

  async function withSetting(companyId: string | null, fn: (c: PoolClient) => Promise<void>) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      if (companyId) {
        await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])
      }
      await fn(client)
      await client.query('commit')
    } catch (err) {
      await client.query('rollback').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  it('sees only company A rows when app.company_id = A', async () => {
    await withSetting(companyA, async (c) => {
      const result = await c.query<{ id: string }>('select id from projects where id = any($1::uuid[])', [
        [projectA, projectB],
      ])
      expect(result.rows.map((r) => r.id)).toEqual([projectA])
    })
  })

  it('sees only company B rows when app.company_id = B', async () => {
    await withSetting(companyB, async (c) => {
      const result = await c.query<{ id: string }>('select id from projects where id = any($1::uuid[])', [
        [projectA, projectB],
      ])
      expect(result.rows.map((r) => r.id)).toEqual([projectB])
    })
  })

  it('is permissive when app.company_id is unset (shadow-mode fallback)', async () => {
    await withSetting(null, async (c) => {
      const result = await c.query<{ id: string }>('select id from projects where id = any($1::uuid[]) order by name', [
        [projectA, projectB],
      ])
      expect(result.rows.map((r) => r.id).sort()).toEqual([projectA, projectB].sort())
    })
  })

  it('rejects INSERT of a project with cross-company company_id (WITH CHECK)', async () => {
    const orphanId = randomUUID()
    await expect(
      withSetting(companyA, async (c) => {
        await c.query(
          `insert into projects (id, company_id, name, customer_name, division_code, status)
           values ($1, $2, 'X', 'X cust', 'D1', 'planning')`,
          [orphanId, companyB],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })
})
