import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { processQueueWithClient } from '@sitelayer/queue'
import { listActiveCompanies } from './companies.js'
import { resolveCompanyQboLive } from './qbo-live.js'

/**
 * MULTI-TENANT WORKER — integration proof against a real, migrated Postgres.
 *
 * Gated on RUN_API_INTEGRATION=1 (the deterministic deploy gate runs this).
 * Needs migration 144 applied (integration_connections.qbo_live_enabled).
 *
 * Proves the three load-bearing properties of the multi-tenant fix:
 *   (a) the worker drains outbox/sync rows for MULTIPLE companies in one tick;
 *   (b) company A's rows never process under company B's scope (isolation);
 *   (c) the per-company QBO-live flag gates correctly with the global
 *       kill-switch (default dry-run; live only when global-on AND flag-on).
 */
const describeIntegration = process.env.RUN_API_INTEGRATION === '1' ? describe : describe.skip

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'

describeIntegration('multi-tenant worker drain + per-company QBO-live (migration 144)', () => {
  let pool: Pool
  let companyA: string
  let companyB: string
  let slugA: string
  let slugB: string

  // Run a unit of work inside a tx with app.company_id bound, mirroring the
  // worker's queue-drain runner (setCompanyGuc + processQueueWithClient).
  async function drainCompanyQueue(companyId: string) {
    const client: PoolClient = await pool.connect()
    try {
      await client.query('begin')
      await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])
      const result = await processQueueWithClient(client, companyId, 25)
      await client.query('commit')
      return result
    } catch (err) {
      await client.query('rollback').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  async function pendingOutboxIds(companyId: string): Promise<string[]> {
    const r = await pool.query<{ id: string }>(
      `select id from mutation_outbox where company_id = $1 and status in ('pending','processing') order by created_at`,
      [companyId],
    )
    return r.rows.map((row) => row.id)
  }

  async function insertGenericOutbox(companyId: string, key: string): Promise<string> {
    // A generic mutation_type (NOT in DEDICATED_HANDLER_MUTATION_TYPES) is
    // claimed by the generic drain and marked applied — exactly the path the
    // worker takes for cross-tenant queue draining.
    const id = randomUUID()
    await pool.query(
      `insert into mutation_outbox (id, company_id, entity_type, entity_id, mutation_type, payload, idempotency_key, status)
       values ($1, $2, 'project', $3, 'generic_test_mutation', '{}'::jsonb, $4, 'pending')`,
      [id, companyId, randomUUID(), key],
    )
    return id
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
    companyA = randomUUID()
    companyB = randomUUID()
    slugA = `mt-a-${companyA.slice(0, 8)}`
    slugB = `mt-b-${companyB.slice(0, 8)}`

    await pool.query(
      `insert into companies (id, slug, name) values ($1, $2, 'MT Company A'), ($3, $4, 'MT Company B')
       on conflict (id) do nothing`,
      [companyA, slugA, companyB, slugB],
    )

    // QBO integration_connections: company A is flagged live-enabled, company B
    // is left at the DEFAULT (false / dry-run).
    await pool.query(
      `insert into integration_connections (company_id, provider, provider_account_id, status, qbo_live_enabled)
       values ($1, 'qbo', 'realm-A', 'connected', true),
              ($2, 'qbo', 'realm-B', 'connected', false)`,
      [companyA, companyB],
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
    await swallow('delete from mutation_outbox where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from sync_events where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from integration_connections where company_id = any($1::uuid[])', [[companyA, companyB]])
    await swallow('delete from companies where id = any($1::uuid[])', [[companyA, companyB]])
    await pool.end()
  })

  it('(a) drains outbox rows for MULTIPLE companies in one tick', async () => {
    await insertGenericOutbox(companyA, `mt-a-${randomUUID()}`)
    await insertGenericOutbox(companyB, `mt-b-${randomUUID()}`)

    // Mirror the heartbeat: iterate ALL companies and drain each.
    const companies = await listActiveCompanies(pool)
    const involved = companies.filter((c) => c.id === companyA || c.id === companyB)
    expect(involved.map((c) => c.slug).sort()).toEqual([slugA, slugB].sort())

    let totalProcessed = 0
    for (const company of involved) {
      const result = await drainCompanyQueue(company.id)
      totalProcessed += result.processedOutboxCount
    }
    // Both companies' rows drained in the single iteration.
    expect(totalProcessed).toBe(2)
    expect(await pendingOutboxIds(companyA)).toEqual([])
    expect(await pendingOutboxIds(companyB)).toEqual([])
  })

  it("(b) isolation: company A's drain never touches company B's rows", async () => {
    const idA = await insertGenericOutbox(companyA, `iso-a-${randomUUID()}`)
    const idB = await insertGenericOutbox(companyB, `iso-b-${randomUUID()}`)

    // Drain ONLY company A.
    const resultA = await drainCompanyQueue(companyA)
    expect(resultA.processedOutboxCount).toBe(1)
    expect(resultA.outbox.map((r) => r.id)).toEqual([idA])

    // Company A's row is applied; company B's row is UNTOUCHED (still pending).
    const aStatus = await pool.query<{ status: string }>('select status from mutation_outbox where id = $1', [idA])
    const bStatus = await pool.query<{ status: string }>('select status from mutation_outbox where id = $1', [idB])
    expect(aStatus.rows[0]?.status).toBe('applied')
    expect(bStatus.rows[0]?.status).toBe('pending')
    expect(await pendingOutboxIds(companyB)).toContain(idB)

    // Now draining company B picks up exactly B's row, never A's (already done).
    const resultB = await drainCompanyQueue(companyB)
    expect(resultB.outbox.map((r) => r.id)).toEqual([idB])
  })

  it('(c) per-company QBO-live gate: default dry-run; live only when global-on AND company-flag-on', async () => {
    // Global kill switch OFF → NO company is live, regardless of its flag.
    expect(await resolveCompanyQboLive(pool, companyA, 'QBO_TEST_LIVE', {})).toBe(false)
    expect(await resolveCompanyQboLive(pool, companyB, 'QBO_TEST_LIVE', {})).toBe(false)

    // Global kill switch ON:
    //   - company A (qbo_live_enabled=true)  → LIVE
    //   - company B (qbo_live_enabled=false) → dry-run (default)
    expect(await resolveCompanyQboLive(pool, companyA, 'QBO_TEST_LIVE', { QBO_TEST_LIVE: '1' })).toBe(true)
    expect(await resolveCompanyQboLive(pool, companyB, 'QBO_TEST_LIVE', { QBO_TEST_LIVE: '1' })).toBe(false)

    // A company with NO QBO connection row is dry-run even with the global on.
    const lonelyCompany = randomUUID()
    await pool.query(
      `insert into companies (id, slug, name) values ($1, $2, 'MT Lonely') on conflict (id) do nothing`,
      [lonelyCompany, `mt-lonely-${lonelyCompany.slice(0, 8)}`],
    )
    try {
      expect(await resolveCompanyQboLive(pool, lonelyCompany, 'QBO_TEST_LIVE', { QBO_TEST_LIVE: '1' })).toBe(false)
    } finally {
      await pool.query('delete from companies where id = $1', [lonelyCompany])
    }
  })

  it('(c2) flipping company B live-enabled true takes effect (and back to default false)', async () => {
    await pool.query('update integration_connections set qbo_live_enabled = true where company_id = $1', [companyB])
    expect(await resolveCompanyQboLive(pool, companyB, 'QBO_TEST_LIVE', { QBO_TEST_LIVE: '1' })).toBe(true)
    // Restore the dry-run default so other assertions/cleanup see B as default.
    await pool.query('update integration_connections set qbo_live_enabled = false where company_id = $1', [companyB])
    expect(await resolveCompanyQboLive(pool, companyB, 'QBO_TEST_LIVE', { QBO_TEST_LIVE: '1' })).toBe(false)
  })
})
