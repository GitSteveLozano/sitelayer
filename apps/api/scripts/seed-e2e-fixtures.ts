// Idempotent seed for the dedicated `e2e-fixtures` test tenant.
//
// Migration 072 stands up the company plus one membership per role
// (admin / foreman / office / member / bookkeeper). This script lights
// up every deterministic workflow in its ready-state so a Playwright
// suite can dispatch role × event coverage immediately:
//
//   - 1 project in lifecycle_state='draft'           (project-lifecycle)
//   - 1 time_review_run in state='pending' covering
//     two labor_entries                              (time-review)
//   - 1 labor_payroll_run in state='generated'       (labor-payroll)
//   - 1 job_rental_contract + 1 rental_billing_run
//     in status='generated'                          (rental-billing)
//   - 1 estimate_push in status='drafted'            (estimate-push)
//   - 1 worker_issue (open: resolved_at IS NULL)     (field-event)
//   - 1 crew_schedule in status='draft'              (crew-schedule)
//
// Plus the bootstrap data they all depend on:
//   - LA-template divisions, service_items, pricing_profile, bonus_rule,
//     default yard location (via seedCompanyDefaults)
//   - 2 customers, 1 worker tied to e2e-foreman, 1 inventory_item
//
// Deterministic UUIDs are used throughout so Playwright fixtures can
// reference rows by name (e.g. the seed project always has id
// '00000000-0000-0000-0000-000000000101'). Re-running this script is a
// no-op against an already-seeded tenant.
//
// Run via: npm run seed:e2e   (local + preview only; refuses prod tier).
//
// SAFETY: this script targets the tier of the running DATABASE_URL. It
// inserts into a DEDICATED tenant (`e2e-fixtures`); the production
// `la-operations` seed is never touched.
import { Pool, type PoolClient } from 'pg'
import { loadAppConfig, TierConfigError, type AppTier } from '../src/tier.js'
import { seedCompanyDefaults } from '../src/onboarding.js'

const E2E_COMPANY_SLUG = 'e2e-fixtures'
const E2E_COMPANY_NAME = 'E2E Fixtures'

// Deterministic UUIDs for every workflow seed row. Grouped by entity so
// future additions follow the same pattern (100s = bootstrap entities,
// 200s = workflow rows). Tests reference these directly.
// Deterministic UUIDs with the UUIDv4 version/variant nibbles (`4` at
// position 14, `8` at position 19). `apps/api/src/http-utils.ts:isValidUuid`
// requires version 1-5 + variant 8-b, so the original all-zero ids were
// rejected at route entry with "id must be a valid uuid".
// Numeric block at the tail: 100s = bootstrap entities, 200s = workflow rows.
const IDS = {
  customerA: '00000000-0000-4000-8000-000000000101',
  customerB: '00000000-0000-4000-8000-000000000102',
  worker: '00000000-0000-4000-8000-000000000103',
  inventoryItem: '00000000-0000-4000-8000-000000000104',
  project: '00000000-0000-4000-8000-000000000201',
  laborEntry1: '00000000-0000-4000-8000-000000000202',
  laborEntry2: '00000000-0000-4000-8000-000000000203',
  timeReviewRun: '00000000-0000-4000-8000-000000000204',
  laborPayrollRun: '00000000-0000-4000-8000-000000000205',
  rentalContract: '00000000-0000-4000-8000-000000000206',
  rentalBillingRun: '00000000-0000-4000-8000-000000000207',
  estimatePush: '00000000-0000-4000-8000-000000000208',
  workerIssue: '00000000-0000-4000-8000-000000000209',
  crewSchedule: '00000000-0000-4000-8000-000000000210',
} as const

function getPoolConfig(connectionString: string, tier: AppTier) {
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
  try {
    const url = new URL(connectionString)
    const sslMode = url.searchParams.get('sslmode')
    if (!rejectUnauthorized && sslMode && sslMode !== 'disable') {
      url.searchParams.delete('sslmode')
      return {
        connectionString: url.toString(),
        ssl: { rejectUnauthorized: false },
        options: `-c app.tier=${tier}`,
      }
    }
  } catch {
    return { connectionString, options: `-c app.tier=${tier}` }
  }
  return { connectionString, options: `-c app.tier=${tier}` }
}

async function ensureCompany(client: PoolClient): Promise<string> {
  // Migration 072 creates this row; tolerate the case where the migration
  // hasn't been applied yet (dev hot-loop) by inserting defensively.
  await client.query(`insert into companies (slug, name) values ($1, $2) on conflict (slug) do nothing`, [
    E2E_COMPANY_SLUG,
    E2E_COMPANY_NAME,
  ])
  const result = await client.query<{ id: string }>(`select id from companies where slug = $1 limit 1`, [
    E2E_COMPANY_SLUG,
  ])
  const row = result.rows[0]
  if (!row) throw new Error(`failed to locate company ${E2E_COMPANY_SLUG} after upsert`)
  return row.id
}

async function ensureMemberships(client: PoolClient, companyId: string): Promise<void> {
  // Migration 072 owns these rows; this is a belt-and-braces so the
  // script remains useful when run against a fresh tier whose ordering
  // hasn't promoted 072 yet.
  const memberships: Array<[string, string]> = [
    ['e2e-admin', 'admin'],
    ['e2e-foreman', 'foreman'],
    ['e2e-office', 'office'],
    ['e2e-member', 'member'],
    ['e2e-bookkeeper', 'bookkeeper'],
  ]
  for (const [userId, role] of memberships) {
    await client.query(
      `insert into company_memberships (company_id, clerk_user_id, role)
       values ($1, $2, $3)
       on conflict (company_id, clerk_user_id) do nothing`,
      [companyId, userId, role],
    )
  }
}

async function ensureCustomers(client: PoolClient, companyId: string): Promise<void> {
  // Two customers — one anchors the rental contract + project, the other
  // is available so role tests can flip the customer on the project.
  await client.query(
    `insert into customers (id, company_id, name, source)
     values ($1, $2, 'E2E Customer A', 'seed')
     on conflict (id) do nothing`,
    [IDS.customerA, companyId],
  )
  await client.query(
    `insert into customers (id, company_id, name, source)
     values ($1, $2, 'E2E Customer B', 'seed')
     on conflict (id) do nothing`,
    [IDS.customerB, companyId],
  )
}

async function ensureWorker(client: PoolClient, companyId: string): Promise<void> {
  await client.query(
    `insert into workers (id, company_id, name, role)
     values ($1, $2, 'E2E Foreman Crew', 'foreman')
     on conflict (id) do nothing`,
    [IDS.worker, companyId],
  )
}

async function ensureInventory(client: PoolClient, companyId: string): Promise<void> {
  // seedCompanyDefaults provisions the default yard location.
  await client.query(
    `insert into inventory_items
       (id, company_id, code, description, category, unit, default_rental_rate, replacement_value, tracking_mode, active)
     values ($1, $2, 'SCAF-E2E', 'E2E Scaffold Frame', 'scaffold', 'ea', 1.50, 250.00, 'quantity', true)
     on conflict (id) do nothing`,
    [IDS.inventoryItem, companyId],
  )
}

async function ensureProject(client: PoolClient, companyId: string): Promise<void> {
  // Lifecycle starts in 'draft'; legacy `status` stays at 'lead' so the
  // backfill in migration 048 doesn't bump lifecycle_state past 'draft'.
  await client.query(
    `insert into projects
       (id, company_id, customer_id, customer_name, name, division_code, status,
        bid_total, labor_rate, target_sqft_per_hr, bonus_pool,
        lifecycle_state, lifecycle_state_version)
     values ($1, $2, $3, 'E2E Customer A', 'E2E Project Alpha', 'D4', 'lead',
             25000.00, 38.00, 4.50, 5000.00, 'draft', 1)
     on conflict (id) do nothing`,
    [IDS.project, companyId, IDS.customerA],
  )
}

async function ensureLaborEntries(client: PoolClient, companyId: string): Promise<void> {
  // Two entries covered by the time_review_run. occurred_on is fixed at
  // a recent date so the period_start/end on the run remains stable
  // across runs.
  const occurredOn = '2026-01-15'
  await client.query(
    `insert into labor_entries
       (id, company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code)
     values ($1, $2, $3, $4, 'EPS', 6.5, 220, 'draft', $5::date, 'D4')
     on conflict (id) do nothing`,
    [IDS.laborEntry1, companyId, IDS.project, IDS.worker, occurredOn],
  )
  await client.query(
    `insert into labor_entries
       (id, company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code)
     values ($1, $2, $3, $4, 'Basecoat', 7.0, 180, 'draft', $5::date, 'D4')
     on conflict (id) do nothing`,
    [IDS.laborEntry2, companyId, IDS.project, IDS.worker, occurredOn],
  )
}

async function ensureTimeReviewRun(client: PoolClient, companyId: string): Promise<void> {
  // covered_entry_ids snapshots the two labor_entries above; if either is
  // missing (which shouldn't happen given ordering) the array still
  // matches the rows that exist when the test boots.
  await client.query(
    `insert into time_review_runs
       (id, company_id, project_id, period_start, period_end,
        state, state_version, covered_entry_ids, total_hours, total_entries, anomaly_count)
     values ($1, $2, $3, '2026-01-15'::date, '2026-01-15'::date,
             'pending', 1, $4::uuid[], 13.5, 2, 0)
     on conflict (id) do nothing`,
    [IDS.timeReviewRun, companyId, IDS.project, [IDS.laborEntry1, IDS.laborEntry2]],
  )
}

async function ensureLaborPayrollRun(client: PoolClient, companyId: string): Promise<void> {
  // Distinct period from the time-review run so the (company, period)
  // UNIQUE constraint is honored when both are present in the same tier.
  await client.query(
    `insert into labor_payroll_runs
       (id, company_id, period_start, period_end,
        state, state_version, covered_labor_entry_ids, total_hours, total_cents)
     values ($1, $2, '2026-01-01'::date, '2026-01-14'::date,
             'generated', 1, '{}'::uuid[], 0, 0)
     on conflict (id) do nothing`,
    [IDS.laborPayrollRun, companyId],
  )
}

async function ensureRentalContractAndRun(client: PoolClient, companyId: string): Promise<void> {
  await client.query(
    `insert into job_rental_contracts
       (id, company_id, project_id, customer_id, billing_cycle_days, billing_mode,
        billing_start_date, next_billing_date, status, notes)
     values ($1, $2, $3, $4, 25, 'arrears',
             '2026-01-01'::date, '2026-01-26'::date, 'active', 'E2E fixture contract')
     on conflict (id) do nothing`,
    [IDS.rentalContract, companyId, IDS.project, IDS.customerA],
  )
  await client.query(
    `insert into rental_billing_runs
       (id, company_id, contract_id, project_id, customer_id,
        period_start, period_end, status, state_version, subtotal)
     values ($1, $2, $3, $4, $5, '2026-01-01'::date, '2026-01-25'::date,
             'generated', 1, 125.00)
     on conflict (id) do nothing`,
    [IDS.rentalBillingRun, companyId, IDS.rentalContract, IDS.project, IDS.customerA],
  )
}

async function ensureEstimatePush(client: PoolClient, companyId: string): Promise<void> {
  await client.query(
    `insert into estimate_pushes
       (id, company_id, project_id, customer_id, status, state_version, subtotal)
     values ($1, $2, $3, $4, 'drafted', 1, 25000.00)
     on conflict (id) do nothing`,
    [IDS.estimatePush, companyId, IDS.project, IDS.customerA],
  )
}

async function ensureWorkerIssue(client: PoolClient, companyId: string): Promise<void> {
  // 'Open' state = resolved_at IS NULL. Reporter is the e2e-foreman so
  // notification fan-out tests can target this row deterministically.
  await client.query(
    `insert into worker_issues
       (id, company_id, project_id, worker_id, reporter_clerk_user_id, kind, message, severity, state_version)
     values ($1, $2, $3, $4, 'e2e-foreman', 'materials_out',
             'E2E fixture: materials short on the south elevation', 'slowing', 1)
     on conflict (id) do nothing`,
    [IDS.workerIssue, companyId, IDS.project, IDS.worker],
  )
}

async function ensureCrewSchedule(client: PoolClient, companyId: string): Promise<void> {
  await client.query(
    `insert into crew_schedules
       (id, company_id, project_id, scheduled_for, crew, status, state_version)
     values ($1, $2, $3, '2026-02-01'::date,
             '[{"worker_id":"e2e-foreman","role":"foreman"}]'::jsonb,
             'draft', 1)
     on conflict (id) do nothing`,
    [IDS.crewSchedule, companyId, IDS.project],
  )
}

export interface SeedSummary {
  companyId: string
  inserted: typeof IDS
}

export async function seedE2eFixtures(): Promise<SeedSummary> {
  const config = loadAppConfig()
  if (config.tier === 'prod') {
    throw new TierConfigError('seed-e2e-fixtures refuses to run when APP_TIER=prod')
  }

  const pool = new Pool(getPoolConfig(config.databaseUrl, config.tier))
  try {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const companyId = await ensureCompany(client)
      await ensureMemberships(client, companyId)
      // Reuse the production onboarding seed for divisions, service items,
      // default pricing profile, bonus rule, and yard location — this
      // keeps the fixture tenant aligned with new-customer behaviour.
      await seedCompanyDefaults(client, companyId)
      await ensureCustomers(client, companyId)
      await ensureWorker(client, companyId)
      await ensureInventory(client, companyId)
      await ensureProject(client, companyId)
      await ensureLaborEntries(client, companyId)
      await ensureTimeReviewRun(client, companyId)
      await ensureLaborPayrollRun(client, companyId)
      await ensureRentalContractAndRun(client, companyId)
      await ensureEstimatePush(client, companyId)
      await ensureWorkerIssue(client, companyId)
      await ensureCrewSchedule(client, companyId)
      await client.query('commit')
      return { companyId, inserted: IDS }
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed-e2e-fixtures.ts')
if (isMain) {
  seedE2eFixtures()
    .then((summary) => {
      console.log(`[seed-e2e] company ${E2E_COMPANY_SLUG} (${summary.companyId}) ready`)
      for (const [name, id] of Object.entries(summary.inserted)) {
        console.log(`  ${name.padEnd(20)} ${id}`)
      }
      process.exit(0)
    })
    .catch((err) => {
      console.error('[seed-e2e] failed:', err)
      process.exit(1)
    })
}
