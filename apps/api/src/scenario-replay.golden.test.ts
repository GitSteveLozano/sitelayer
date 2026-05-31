import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { applyScenario, parseScenario } from '@sitelayer/scenario'
import { seedCompanyDefaults } from './onboarding.js'

/**
 * Scenario-replay golden tests against an ephemeral Postgres.
 *
 * Gated on RUN_API_INTEGRATION=1 (the CI `test-integration` job spins up a
 * migrated Postgres 18 — see .github/workflows/quality.yml). Each test runs in
 * its own BEGIN/ROLLBACK so it leaves no residue.
 *
 * This is the row-level parity proof for `@sitelayer/scenario`: it applies the
 * real `scenarios/*.yaml` through the engine + the real `seedCompanyDefaults`
 * and asserts the materialized rows match what the imperative seeder produced —
 * including the deterministic-workflow timelines replayed through the live
 * reducers, and full re-apply idempotency.
 */

const describeIntegration = process.env.RUN_API_INTEGRATION === '1' ? describe : describe.skip
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'
const scenariosDir = fileURLToPath(new URL('../../../scenarios', import.meta.url))
// Fixed clock so re-applies key time-relative rows to the same ids (idempotency).
const NOW = new Date('2026-05-31T12:00:00.000Z')

function readScenario(file: string) {
  return parseScenario(readFileSync(`${scenariosDir}/${file}`, 'utf-8'))
}

describeIntegration('scenario replay (golden, ephemeral PG)', () => {
  let pool: Pool
  let client: PoolClient

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 })
  })
  afterAll(async () => {
    await pool?.end()
  })
  beforeEach(async () => {
    client = await pool.connect()
    await client.query('begin')
  })
  afterEach(async () => {
    await client.query('rollback').catch(() => undefined)
    client.release()
  })

  async function count(sql: string, params: unknown[]): Promise<number> {
    const r = await client.query<{ n: number }>(sql, params)
    return r.rows[0]?.n ?? -1
  }

  it('mid-flight-rental: rental lands in `posting` with a 2-row event log + backdated outbox', async () => {
    const summary = await applyScenario(client, readScenario('mid-flight-rental.yaml'), {
      seedCompanyDefaults,
      now: NOW,
    })
    const companyId = summary.company_id

    const run = await client.query<{ status: string; state_version: number }>(
      `select status, state_version from rental_billing_runs where company_id = $1`,
      [companyId],
    )
    expect(run.rows).toHaveLength(1)
    expect(run.rows[0]?.status).toBe('posting')
    expect(run.rows[0]?.state_version).toBe(3)

    expect(
      await count(
        `select count(*)::int n from workflow_event_log where company_id = $1 and workflow_name = 'rental_billing_run'`,
        [companyId],
      ),
    ).toBe(2)

    // The outbox row is backdated 15m so the worker claims it immediately.
    expect(
      await count(
        `select count(*)::int n from mutation_outbox
         where company_id = $1 and mutation_type = 'post_qbo_invoice' and next_attempt_at < now()`,
        [companyId],
      ),
    ).toBe(1)
  })

  it('steve-demo: the live demo seed materializes (5 projects, posted invoice, captured work item)', async () => {
    const summary = await applyScenario(client, readScenario('steve-demo.yaml'), { seedCompanyDefaults, now: NOW })
    const companyId = summary.company_id

    expect(await count(`select count(*)::int n from projects where company_id = $1`, [companyId])).toBe(5)
    expect(await count(`select count(*)::int n from customers where company_id = $1`, [companyId])).toBe(5)
    expect(await count(`select count(*)::int n from context_work_items where company_id = $1`, [companyId])).toBe(1)
    // POST_SUCCEEDED carried the seeded QBO invoice id into the terminal row.
    expect(
      await count(
        `select count(*)::int n from rental_billing_runs
         where company_id = $1 and status = 'posted' and qbo_invoice_id = 'DEMO-INV-1041'`,
        [companyId],
      ),
    ).toBe(1)
    // seedCompanyDefaults ran: LA divisions + service items are present.
    expect(await count(`select count(*)::int n from divisions where company_id = $1`, [companyId])).toBeGreaterThan(0)
    expect(await count(`select count(*)::int n from service_items where company_id = $1`, [companyId])).toBeGreaterThan(
      0,
    )
  })

  it('re-applying steve-demo in the same tx is a no-op (idempotent)', async () => {
    const summary = await applyScenario(client, readScenario('steve-demo.yaml'), { seedCompanyDefaults, now: NOW })
    const companyId = summary.company_id

    const tables = [
      'projects',
      'customers',
      'workers',
      'rental_billing_runs',
      'estimate_pushes',
      'change_orders',
      'crew_schedules',
      'daily_logs',
      'estimate_lines',
      'capture_sessions',
      'context_work_items',
      'context_handoff_events',
    ]
    const snapshot = async () => {
      const out: Record<string, number> = {}
      for (const t of tables) {
        out[t] = await count(`select count(*)::int n from ${t} where company_id = $1`, [companyId])
      }
      out['workflow_event_log'] = await count(
        `select count(*)::int n from workflow_event_log where company_id = $1`,
        [companyId],
      )
      return out
    }

    const before = await snapshot()
    // Re-apply with the same clock → identical ids → every insert is ON CONFLICT DO NOTHING.
    await applyScenario(client, readScenario('steve-demo.yaml'), { seedCompanyDefaults, now: NOW })
    const after = await snapshot()

    expect(after).toEqual(before)
  })
})
