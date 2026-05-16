import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'

/**
 * Proves the row-level-security policies created by migration 066 actually
 * scope rows to `app.company_id`. The migration leaves RLS DISABLED on each
 * table (shadow mode); these tests temporarily enable+force it on `projects`
 * to verify the policy works, then disable it again so the rest of the suite
 * (and the dev DB) keeps the permissive default.
 *
 * Gated on RUN_API_INTEGRATION=1 because it needs a live Postgres with the
 * sitelayer schema applied.
 */
const describeIntegration = process.env.RUN_API_INTEGRATION === '1' ? describe : describe.skip

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
    await pool.query('insert into companies (id, slug, name) values ($1, $2, $3), ($4, $5, $6)', [
      companyA,
      `rls-test-a-${companyA.slice(0, 8)}`,
      'RLS Test A',
      companyB,
      `rls-test-b-${companyB.slice(0, 8)}`,
      'RLS Test B',
    ])
    await pool.query(
      `insert into projects (id, company_id, name, customer_name, division_code, status)
       values ($1, $2, 'A project', 'A customer', 'D1', 'planning'),
              ($3, $4, 'B project', 'B customer', 'D1', 'planning')`,
      [projectA, companyA, projectB, companyB],
    )
    await pool.query('alter table projects enable row level security')
    await pool.query('alter table projects force row level security')
  })

  afterAll(async () => {
    if (!pool) return
    try {
      await pool.query('alter table projects no force row level security')
      await pool.query('alter table projects disable row level security')
      await pool.query('delete from projects where id = any($1::uuid[])', [[projectA, projectB]])
      await pool.query('delete from companies where id = any($1::uuid[])', [[companyA, companyB]])
    } finally {
      await pool.end()
    }
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
