#!/usr/bin/env -S npx tsx
/**
 * YAML-driven fixture builder.
 *
 * Reads a single YAML file describing a tenant, its projects, members,
 * inventory, rentals, and any deterministic-workflow event sequences
 * you want walked through the registered reducers — and stamps the DB
 * in one idempotent transaction.
 *
 * The motivating gap (from the task brief): `scripts/onboard-company.ts`
 * gets you a slug + admin + division seed, and `seed-e2e-fixtures.ts`
 * primes one stuck-in-the-middle row per workflow. There was no way to
 * say "Acme Construction with 3 foremen, 2 active rentals — one stuck
 * in `posting` 15 minutes ago — an estimate pending QBO push, and a
 * project at closeout" in one command. This script is that command.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     npx tsx scripts/seed-scenario.ts scenarios/mid-flight-rental.yaml
 *
 * Behaviour:
 *   - Refuses to run when APP_TIER=prod. Same guard `seed-e2e-fixtures.ts`
 *     uses; this primitive is only ever safe in local/dev/preview.
 *   - All inserts use ON CONFLICT DO NOTHING so re-running the same
 *     YAML produces the same final state.
 *   - Every entity is named via a stable `ref` string in the YAML; the
 *     ref is hashed into a deterministic UUID so cross-references
 *     ("rental→project") resolve without round-trips.
 *   - Workflow event sequences are walked through `applyEventSequence`
 *     from @sitelayer/workflows, so the `workflow_event_log` rows match
 *     what `scripts/replay-workflow.ts` would verify in production.
 *   - The script prints a JSON summary `{company_id, projects, ...}` so
 *     CI / shell can grep for the materialized ids.
 *
 * YAML shape (see scenarios/*.yaml for working examples):
 *
 *   company:
 *     slug: acme-construction
 *     name: Acme Construction
 *
 *   members:
 *     - clerk_user_id: e2e-admin
 *       role: admin
 *
 *   customers:                  # optional, default none beyond members
 *     - ref: customer-a
 *       name: Big Customer
 *
 *   workers:
 *     - ref: worker-foreman-1
 *       name: Foreman One
 *       role: foreman
 *
 *   inventory:
 *     - ref: scaffold-frame
 *       code: SCAF-001
 *       description: Scaffold Frame
 *       default_rental_rate: 1.50
 *       replacement_value: 250.00
 *
 *   projects:
 *     - ref: project-alpha
 *       name: Alpha Apartments
 *       customer_ref: customer-a
 *       division_code: D4
 *       status: lead            # legacy column; defaults to 'lead'
 *       bid_total: 50000.00
 *       lifecycle_state: in_progress
 *       lifecycle_state_version: 4
 *
 *   rentals:                    # exercises rental_billing_run workflow
 *     - ref: rental-stuck
 *       project_ref: project-alpha
 *       inventory_ref: scaffold-frame
 *       quantity: 25
 *       billing_cycle_days: 25
 *       billing_event_log:
 *         - type: APPROVE
 *           approved_at: '2026-01-15T10:00:00.000Z'
 *           approved_by: e2e-office
 *         - type: POST_REQUESTED
 *       # forces the worker's mutation_outbox row to be 15 min in the past
 *       outbox_next_attempt_offset_minutes: -15
 *
 *   estimates:                  # exercises estimate_push workflow
 *     - ref: est-pending-push
 *       project_ref: project-alpha
 *       subtotal: 25000.00
 *       push_event_log:
 *         - type: REVIEW
 *           reviewed_at: '2026-01-15T10:00:00.000Z'
 *           reviewed_by: e2e-office
 *         - type: APPROVE
 *           approved_at: '2026-01-15T11:00:00.000Z'
 *           approved_by: e2e-admin
 *         - type: POST_REQUESTED
 *
 *   worker_issues:              # exercises field_event workflow
 *     - ref: issue-stopped
 *       project_ref: project-alpha
 *       worker_ref: worker-foreman-1
 *       reporter_clerk_user_id: e2e-foreman
 *       kind: materials_out
 *       severity: stopped
 *       message: 'Crew stopped: materials short on south elevation'
 *       created_offset_minutes: -20
 *
 *   clock_events:               # raw clock_events rows, no workflow
 *     - worker_ref: worker-foreman-1
 *       project_ref: project-alpha
 *       event_type: in
 *       occurred_at: '2026-01-15T08:00:00.000Z'
 *
 *   takeoff_measurements:       # bulk insert helper for perf scenarios
 *     project_ref: project-alpha
 *     count: 500
 *     service_item_code: EPS
 *
 *   damage_charges:             # exercises damage_charge_settlement workflow
 *     - ref: damage-frame-bent
 *       project_ref: project-alpha
 *       customer_ref: customer-a
 *       kind: damage
 *       quantity: 1
 *       unit_amount: 250.00
 *       total_amount: 250.00
 *       description: 'Bent frame returned from site'
 *       settlement_event_log:
 *         - type: INVOICE
 *           invoiced_at: '2026-01-15T10:00:00.000Z'
 *           invoiced_by: e2e-office
 *
 *   rental_requests:            # exercises rental_request_approval workflow
 *     - ref: req-portal-1
 *       customer_ref: customer-a
 *       contact_email: foo@bar.com
 *       approval_event_log:
 *         - type: APPROVE
 *           approved_at: '2026-01-15T10:00:00.000Z'
 *           approved_by: e2e-office
 *
 *   qbo_sync_runs:              # exercises qbo_sync_run workflow
 *     - ref: sync-failed
 *       triggered_by: e2e-admin
 *       sync_event_log:
 *         - type: START_SYNC
 *           started_at: '2026-01-15T10:00:00.000Z'
 *           triggered_by: e2e-admin
 *         - type: SYNC_FAILED
 *           failed_at: '2026-01-15T10:00:15.000Z'
 *           error: 'Intuit 503'
 *
 *   boms:                       # exercises scaffold_ops_approval workflow
 *     - ref: bom-elev-east
 *       project_ref: project-alpha
 *       name: 'East elevation scaffold'
 *       approval_event_log:
 *         - type: APPROVE
 *           approved_at: '2026-01-15T10:00:00.000Z'
 *           approved_by: e2e-admin
 *
 * Exit codes:
 *   0  success (idempotent)
 *   1  bad arguments / config / scenario parse failure
 *   2  DB error during seeding
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { parse as parseYaml } from 'yaml'

// Importing each workflow module registers its reducer in the shared
// registry. applyEventSequence then resolves them by name.
import {
  applyEventSequence,
  rentalBillingWorkflow as _rentalBilling,
  estimatePushWorkflow as _estimatePush,
  fieldEventWorkflow as _fieldEvent,
  projectLifecycleWorkflow as _projectLifecycle,
  crewScheduleWorkflow as _crewSchedule,
  rentalWorkflow as _rental,
  damageChargeSettlementWorkflow as _damageChargeSettlement,
  rentalRequestApprovalWorkflow as _rentalRequestApproval,
  qboSyncRunWorkflow as _qboSyncRun,
  scaffoldOpsApprovalWorkflow as _scaffoldOpsApproval,
  type RentalBillingWorkflowEvent,
  type RentalBillingWorkflowSnapshot,
  type EstimatePushWorkflowEvent,
  type EstimatePushWorkflowSnapshot,
  type FieldEventWorkflowEvent,
  type FieldEventWorkflowSnapshot,
  type DamageChargeSettlementWorkflowEvent,
  type DamageChargeSettlementWorkflowSnapshot,
  type RentalRequestApprovalWorkflowEvent,
  type RentalRequestApprovalWorkflowSnapshot,
  type QboSyncRunWorkflowEvent,
  type QboSyncRunWorkflowSnapshot,
  type ScaffoldOpsApprovalWorkflowEvent,
  type ScaffoldOpsApprovalWorkflowSnapshot,
} from '@sitelayer/workflows'
import { loadAppConfig, TierConfigError, type AppTier } from '../apps/api/src/tier.js'
import { COMPANY_SLUG_PATTERN, seedCompanyDefaults } from '../apps/api/src/onboarding.js'

void _rentalBilling
void _estimatePush
void _fieldEvent
void _projectLifecycle
void _crewSchedule
void _rental
void _damageChargeSettlement
void _rentalRequestApproval
void _qboSyncRun
void _scaffoldOpsApproval

// ---------- YAML schema (TypeScript-side) ----------

interface ScenarioYaml {
  company: { slug: string; name: string }
  members?: Array<{ clerk_user_id: string; role: string }>
  customers?: Array<{ ref: string; name: string }>
  workers?: Array<{ ref: string; name: string; role?: string; clerk_user_id?: string }>
  inventory?: Array<{
    ref: string
    code: string
    description?: string
    category?: string
    unit?: string
    default_rental_rate?: number
    replacement_value?: number
    tracking_mode?: string
  }>
  projects?: Array<{
    ref: string
    name: string
    customer_ref?: string
    customer_name?: string
    division_code?: string
    status?: string
    bid_total?: number
    labor_rate?: number
    target_sqft_per_hr?: number
    bonus_pool?: number
    lifecycle_state?: string
    lifecycle_state_version?: number
    lifecycle_event_log?: Array<Record<string, unknown>>
  }>
  rentals?: Array<{
    ref: string
    project_ref: string
    customer_ref?: string
    inventory_ref: string
    quantity: number
    billing_cycle_days?: number
    billing_mode?: string
    agreed_rate?: number
    rate_unit?: string
    on_rent_date?: string
    billing_start_date?: string
    period_start?: string
    period_end?: string
    subtotal?: number
    billing_event_log?: Array<Record<string, unknown>>
    outbox_next_attempt_offset_minutes?: number
  }>
  estimates?: Array<{
    ref: string
    project_ref: string
    customer_ref?: string
    subtotal?: number
    push_event_log?: Array<Record<string, unknown>>
  }>
  worker_issues?: Array<{
    ref: string
    project_ref?: string
    worker_ref?: string
    reporter_clerk_user_id: string
    kind: string
    message: string
    severity?: string
    created_offset_minutes?: number
    issue_event_log?: Array<Record<string, unknown>>
  }>
  clock_events?: Array<{
    worker_ref?: string
    project_ref?: string
    clerk_user_id?: string
    event_type: string
    occurred_at: string
    inside_geofence?: boolean
  }>
  takeoff_measurements?: {
    project_ref: string
    count: number
    service_item_code?: string
    unit?: string
  }
  damage_charges?: Array<{
    ref: string
    project_ref: string
    customer_ref?: string
    kind?: string
    quantity?: number
    unit_amount?: number
    total_amount?: number
    description: string
    settlement_event_log?: Array<Record<string, unknown>>
  }>
  rental_requests?: Array<{
    ref: string
    customer_ref?: string
    contact_name?: string
    contact_email?: string
    contact_phone?: string
    requested_start?: string
    requested_end?: string
    notes?: string
    items?: Array<Record<string, unknown>>
    approval_event_log?: Array<Record<string, unknown>>
  }>
  qbo_sync_runs?: Array<{
    ref: string
    provider?: string
    triggered_by?: string
    sync_event_log?: Array<Record<string, unknown>>
  }>
  boms?: Array<{
    ref: string
    project_ref: string
    name: string
    source?: string
    source_ref?: string
    notes?: string
    total_weight_kg?: number
    total_lines?: number
    approval_event_log?: Array<Record<string, unknown>>
  }>
}

// ---------- Deterministic UUIDs ----------

/**
 * UUID derived from a scoped ref. Same ref+scope → same id forever, so
 * tests can reference rows by name across runs. The output respects
 * UUIDv4 version/variant nibbles so it passes `isValidUuid` in
 * apps/api/src/http-utils.ts.
 */
function refUuid(scope: string, ref: string): string {
  const hash = createHash('sha256').update(`sitelayer:scenario:${scope}:${ref}`).digest('hex')
  // Version 4 (random) layout: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y is 8/9/a/b.
  const variant = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join('-')
}

// ---------- DB connection ----------

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

// ---------- Per-section seeders ----------

async function ensureCompany(client: PoolClient, scenario: ScenarioYaml): Promise<string> {
  if (!COMPANY_SLUG_PATTERN.test(scenario.company.slug)) {
    throw new Error(`company.slug "${scenario.company.slug}" does not match ${COMPANY_SLUG_PATTERN}`)
  }
  await client.query(`insert into companies (slug, name) values ($1, $2) on conflict (slug) do nothing`, [
    scenario.company.slug,
    scenario.company.name,
  ])
  const result = await client.query<{ id: string }>(`select id from companies where slug = $1 limit 1`, [
    scenario.company.slug,
  ])
  if (result.rows.length === 0) throw new Error(`failed to upsert company ${scenario.company.slug}`)
  return result.rows[0]!.id
}

async function ensureMemberships(
  client: PoolClient,
  companyId: string,
  members: ScenarioYaml['members'],
): Promise<void> {
  if (!members) return
  for (const m of members) {
    await client.query(
      `insert into company_memberships (company_id, clerk_user_id, role)
       values ($1, $2, $3)
       on conflict (company_id, clerk_user_id) do nothing`,
      [companyId, m.clerk_user_id, m.role],
    )
  }
}

interface RefMaps {
  customers: Map<string, string>
  workers: Map<string, string>
  inventory: Map<string, string>
  projects: Map<string, string>
  rentalContracts: Map<string, string>
  rentalBillingRuns: Map<string, string>
  estimates: Map<string, string>
  workerIssues: Map<string, string>
  damageCharges: Map<string, string>
  rentalRequests: Map<string, string>
  qboSyncRuns: Map<string, string>
  boms: Map<string, string>
}

function newRefMaps(): RefMaps {
  return {
    customers: new Map(),
    workers: new Map(),
    inventory: new Map(),
    projects: new Map(),
    rentalContracts: new Map(),
    rentalBillingRuns: new Map(),
    estimates: new Map(),
    workerIssues: new Map(),
    damageCharges: new Map(),
    rentalRequests: new Map(),
    qboSyncRuns: new Map(),
    boms: new Map(),
  }
}

async function ensureCustomers(
  client: PoolClient,
  companyId: string,
  customers: ScenarioYaml['customers'],
  refs: RefMaps,
): Promise<void> {
  if (!customers) return
  for (const c of customers) {
    const id = refUuid('customer', c.ref)
    refs.customers.set(c.ref, id)
    await client.query(
      `insert into customers (id, company_id, name, source)
       values ($1, $2, $3, 'seed')
       on conflict (id) do nothing`,
      [id, companyId, c.name],
    )
  }
}

async function ensureWorkers(
  client: PoolClient,
  companyId: string,
  workers: ScenarioYaml['workers'],
  refs: RefMaps,
): Promise<void> {
  if (!workers) return
  for (const w of workers) {
    const id = refUuid('worker', w.ref)
    refs.workers.set(w.ref, id)
    await client.query(
      `insert into workers (id, company_id, name, role)
       values ($1, $2, $3, $4)
       on conflict (id) do nothing`,
      [id, companyId, w.name, w.role ?? 'crew'],
    )
  }
}

async function ensureInventory(
  client: PoolClient,
  companyId: string,
  inventory: ScenarioYaml['inventory'],
  refs: RefMaps,
): Promise<void> {
  if (!inventory) return
  for (const item of inventory) {
    const id = refUuid('inventory', item.ref)
    refs.inventory.set(item.ref, id)
    await client.query(
      `insert into inventory_items
         (id, company_id, code, description, category, unit, default_rental_rate, replacement_value, tracking_mode, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        item.code,
        item.description ?? item.code,
        item.category ?? 'scaffold',
        item.unit ?? 'ea',
        item.default_rental_rate ?? 0,
        item.replacement_value ?? null,
        item.tracking_mode ?? 'quantity',
      ],
    )
  }
}

async function ensureProjects(
  client: PoolClient,
  companyId: string,
  projects: ScenarioYaml['projects'],
  refs: RefMaps,
): Promise<void> {
  if (!projects) return
  for (const p of projects) {
    const id = refUuid('project', p.ref)
    refs.projects.set(p.ref, id)
    const customerId = p.customer_ref ? (refs.customers.get(p.customer_ref) ?? null) : null
    const customerName = p.customer_name ?? p.customer_ref ?? 'Direct'
    await client.query(
      `insert into projects
         (id, company_id, customer_id, customer_name, name, division_code, status,
          bid_total, labor_rate, target_sqft_per_hr, bonus_pool,
          lifecycle_state, lifecycle_state_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        customerId,
        customerName,
        p.name,
        p.division_code ?? 'D4',
        p.status ?? 'lead',
        p.bid_total ?? 0,
        p.labor_rate ?? 0,
        p.target_sqft_per_hr ?? null,
        p.bonus_pool ?? 0,
        p.lifecycle_state ?? 'draft',
        p.lifecycle_state_version ?? 1,
      ],
    )
  }
}

// ---------- Rentals (rental_billing_run workflow) ----------

async function ensureRentals(
  client: PoolClient,
  companyId: string,
  rentals: ScenarioYaml['rentals'],
  refs: RefMaps,
): Promise<void> {
  if (!rentals) return
  for (const r of rentals) {
    const projectId = mustResolve('project', r.project_ref, refs.projects)
    const inventoryId = mustResolve('inventory', r.inventory_ref, refs.inventory)
    const customerId = r.customer_ref ? (refs.customers.get(r.customer_ref) ?? null) : null
    const contractId = refUuid('rental_contract', r.ref)
    const billingRunId = refUuid('rental_billing_run', r.ref)
    const billingLineId = refUuid('rental_billing_line', r.ref)
    refs.rentalContracts.set(r.ref, contractId)
    refs.rentalBillingRuns.set(r.ref, billingRunId)

    const billingStart = r.billing_start_date ?? '2026-01-01'
    const periodStart = r.period_start ?? billingStart
    const periodEnd = r.period_end ?? '2026-01-25'

    await client.query(
      `insert into job_rental_contracts
         (id, company_id, project_id, customer_id, billing_cycle_days, billing_mode,
          billing_start_date, next_billing_date, status, notes)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, 'active', 'seed-scenario contract')
       on conflict (id) do nothing`,
      [
        contractId,
        companyId,
        projectId,
        customerId,
        r.billing_cycle_days ?? 25,
        r.billing_mode ?? 'arrears',
        billingStart,
        periodEnd,
      ],
    )

    // Contract line, then billing run.
    await client.query(
      `insert into job_rental_lines
         (id, company_id, contract_id, inventory_item_id, quantity, agreed_rate, rate_unit, on_rent_date, status, billable, taxable)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date, 'active', true, true)
       on conflict (id) do nothing`,
      [
        refUuid('rental_line', r.ref),
        companyId,
        contractId,
        inventoryId,
        r.quantity,
        r.agreed_rate ?? 0,
        r.rate_unit ?? 'cycle',
        r.on_rent_date ?? billingStart,
      ],
    )

    await client.query(
      `insert into rental_billing_runs
         (id, company_id, contract_id, project_id, customer_id,
          period_start, period_end, status, state_version, subtotal)
       values ($1, $2, $3, $4, $5, $6::date, $7::date, 'generated', 1, $8)
       on conflict (id) do nothing`,
      [billingRunId, companyId, contractId, projectId, customerId, periodStart, periodEnd, r.subtotal ?? 0],
    )

    if (r.billing_event_log && r.billing_event_log.length > 0) {
      const events = r.billing_event_log as RentalBillingWorkflowEvent[]
      const initial: RentalBillingWorkflowSnapshot = { state: 'generated', state_version: 1 }
      const result = await applyEventSequence<RentalBillingWorkflowSnapshot, RentalBillingWorkflowEvent>(client, {
        workflowName: 'rental_billing_run',
        entityType: 'rental_billing_run',
        entityId: billingRunId,
        companyId,
        initialSnapshot: initial as unknown as Record<string, unknown> & {
          state: string
          state_version: number
        },
        events,
      })
      // Stamp the materialized row to match the reducer output.
      const final = result.finalSnapshot
      await client.query(
        `update rental_billing_runs
           set status = $1,
               state_version = $2,
               approved_at = $3,
               approved_by = $4,
               posted_at = $5,
               failed_at = $6,
               error = $7,
               qbo_invoice_id = $8,
               updated_at = now()
         where id = $9 and company_id = $10`,
        [
          final.state,
          final.state_version,
          final.approved_at ?? null,
          final.approved_by ?? null,
          final.posted_at ?? null,
          final.failed_at ?? null,
          final.error ?? null,
          final.qbo_invoice_id ?? null,
          billingRunId,
          companyId,
        ],
      )

      // If the final state is `posting`, enqueue a mutation_outbox row so
      // the worker has something to claim. The unique constraint is on
      // (company_id, idempotency_key); use a deterministic key tied to the
      // billing run id so a re-run is a no-op. `next_attempt_at` defaults
      // to now() and the YAML's `outbox_next_attempt_offset_minutes` lets
      // a scenario backdate the row (e.g. -15 to force an immediate retry).
      if (final.state === 'posting') {
        const idempotencyKey = `rental_billing_run:post:${billingRunId}`
        await client.query(
          `insert into mutation_outbox
             (company_id, entity_type, entity_id, mutation_type, payload, idempotency_key, status, next_attempt_at)
           values ($1, 'rental_billing_run', $2, 'post_qbo_invoice', $3::jsonb, $4, 'pending', now() + ($5 || ' minutes')::interval)
           on conflict (company_id, idempotency_key) do nothing`,
          [
            companyId,
            billingRunId,
            JSON.stringify({ rental_billing_run_id: billingRunId }),
            idempotencyKey,
            String(r.outbox_next_attempt_offset_minutes ?? 0),
          ],
        )
      }
    }

    // Suppress unused-warning when no event log was supplied: the line id
    // is still useful as a hook for follow-up tests inspecting the seed.
    void billingLineId
  }
}

// ---------- Estimate pushes ----------

async function ensureEstimates(
  client: PoolClient,
  companyId: string,
  estimates: ScenarioYaml['estimates'],
  refs: RefMaps,
): Promise<void> {
  if (!estimates) return
  for (const e of estimates) {
    const projectId = mustResolve('project', e.project_ref, refs.projects)
    const customerId = e.customer_ref ? (refs.customers.get(e.customer_ref) ?? null) : null
    const pushId = refUuid('estimate_push', e.ref)
    refs.estimates.set(e.ref, pushId)

    await client.query(
      `insert into estimate_pushes
         (id, company_id, project_id, customer_id, status, state_version, subtotal)
       values ($1, $2, $3, $4, 'drafted', 1, $5)
       on conflict (id) do nothing`,
      [pushId, companyId, projectId, customerId, e.subtotal ?? 0],
    )

    if (e.push_event_log && e.push_event_log.length > 0) {
      const events = e.push_event_log as EstimatePushWorkflowEvent[]
      const initial: EstimatePushWorkflowSnapshot = { state: 'drafted', state_version: 1 }
      const result = await applyEventSequence<EstimatePushWorkflowSnapshot, EstimatePushWorkflowEvent>(client, {
        workflowName: 'estimate_push',
        entityType: 'estimate_push',
        entityId: pushId,
        companyId,
        initialSnapshot: initial as unknown as Record<string, unknown> & {
          state: string
          state_version: number
        },
        events,
      })
      const final = result.finalSnapshot
      await client.query(
        `update estimate_pushes
           set status = $1,
               state_version = $2,
               reviewed_at = $3,
               reviewed_by = $4,
               approved_at = $5,
               approved_by = $6,
               posted_at = $7,
               failed_at = $8,
               error = $9,
               qbo_estimate_id = $10,
               updated_at = now()
         where id = $11 and company_id = $12`,
        [
          final.state,
          final.state_version,
          final.reviewed_at ?? null,
          final.reviewed_by ?? null,
          final.approved_at ?? null,
          final.approved_by ?? null,
          final.posted_at ?? null,
          final.failed_at ?? null,
          final.error ?? null,
          final.qbo_estimate_id ?? null,
          pushId,
          companyId,
        ],
      )
    }
  }
}

// ---------- Worker issues (field_event workflow) ----------

async function ensureWorkerIssues(
  client: PoolClient,
  companyId: string,
  issues: ScenarioYaml['worker_issues'],
  refs: RefMaps,
): Promise<void> {
  if (!issues) return
  for (const issue of issues) {
    const id = refUuid('worker_issue', issue.ref)
    refs.workerIssues.set(issue.ref, id)
    const projectId = issue.project_ref ? (refs.projects.get(issue.project_ref) ?? null) : null
    const workerId = issue.worker_ref ? (refs.workers.get(issue.worker_ref) ?? null) : null
    const createdOffset = issue.created_offset_minutes ?? 0

    await client.query(
      `insert into worker_issues
         (id, company_id, project_id, worker_id, reporter_clerk_user_id,
          kind, message, severity, state_version, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, now() + ($9 || ' minutes')::interval)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        projectId,
        workerId,
        issue.reporter_clerk_user_id,
        issue.kind,
        issue.message,
        issue.severity ?? 'slowing',
        String(createdOffset),
      ],
    )

    if (issue.issue_event_log && issue.issue_event_log.length > 0) {
      const events = issue.issue_event_log as FieldEventWorkflowEvent[]
      const initial: FieldEventWorkflowSnapshot = { state: 'open', state_version: 1 }
      const result = await applyEventSequence<FieldEventWorkflowSnapshot, FieldEventWorkflowEvent>(client, {
        workflowName: 'field_event',
        entityType: 'worker_issue',
        entityId: id,
        companyId,
        initialSnapshot: initial as unknown as Record<string, unknown> & {
          state: string
          state_version: number
        },
        events,
      })
      const final = result.finalSnapshot
      await client.query(
        `update worker_issues
           set state_version = $1,
               resolved_at = $2,
               resolved_by_clerk_user_id = $3,
               resolved_action = $4,
               resolution_message = $5,
               escalated_to_estimator_at = $6,
               escalation_reason = $7
         where id = $8 and company_id = $9`,
        [
          final.state_version,
          final.resolved_at ?? null,
          final.resolved_by_user_id ?? null,
          final.resolved_action ?? null,
          final.resolution_message ?? null,
          final.escalated_to_estimator_at ?? null,
          final.escalation_reason ?? null,
          id,
          companyId,
        ],
      )
    }
  }
}

// ---------- Clock events ----------

async function ensureClockEvents(
  client: PoolClient,
  companyId: string,
  clockEvents: ScenarioYaml['clock_events'],
  refs: RefMaps,
): Promise<void> {
  if (!clockEvents) return
  for (let i = 0; i < clockEvents.length; i++) {
    const ev = clockEvents[i]!
    const workerId = ev.worker_ref ? (refs.workers.get(ev.worker_ref) ?? null) : null
    const projectId = ev.project_ref ? (refs.projects.get(ev.project_ref) ?? null) : null
    // Deterministic id per (worker, project, occurred_at, event_type) so
    // re-runs collapse to the same row.
    const id = refUuid(
      'clock_event',
      `${ev.worker_ref ?? '-'}|${ev.project_ref ?? '-'}|${ev.occurred_at}|${ev.event_type}|${i}`,
    )
    await client.query(
      `insert into clock_events
         (id, company_id, worker_id, project_id, clerk_user_id, event_type, occurred_at, inside_geofence)
       values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        workerId,
        projectId,
        ev.clerk_user_id ?? null,
        ev.event_type,
        ev.occurred_at,
        ev.inside_geofence ?? true,
      ],
    )
  }
}

// ---------- Takeoff bulk ----------

async function ensureTakeoffMeasurements(
  client: PoolClient,
  companyId: string,
  spec: ScenarioYaml['takeoff_measurements'],
  refs: RefMaps,
): Promise<void> {
  if (!spec) return
  const projectId = mustResolve('project', spec.project_ref, refs.projects)
  // Materialize the draft row the new measurements will hang off — the
  // existing migration set requires draft_id NOT NULL.
  const draftId = refUuid('takeoff_draft', `${spec.project_ref}:bulk`)
  await client.query(
    `insert into takeoff_drafts
       (id, company_id, project_id, name, status)
     values ($1, $2, $3, 'scenario-bulk', 'active')
     on conflict (id) do nothing`,
    [draftId, companyId, projectId],
  )
  const code = spec.service_item_code ?? 'EPS'
  const unit = spec.unit ?? 'sqft'

  // Bulk insert — one round-trip per row would be slow at 500. Compose a
  // multi-row VALUES list so a 500-row scenario only round-trips once.
  const valueClauses: string[] = []
  const values: unknown[] = []
  for (let i = 0; i < spec.count; i++) {
    const id = refUuid('takeoff_measurement', `${spec.project_ref}:bulk:${i}`)
    const q = 100 + (i % 50)
    const idx = valueClauses.length * 7
    valueClauses.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`)
    values.push(id, companyId, projectId, draftId, code, q, unit)
  }
  if (valueClauses.length > 0) {
    await client.query(
      `insert into takeoff_measurements
         (id, company_id, project_id, draft_id, service_item_code, quantity, unit)
       values ${valueClauses.join(', ')}
       on conflict (id) do nothing`,
      values,
    )
  }
}

// ---------- Damage charges (damage_charge_settlement workflow) ----------

async function ensureDamageCharges(
  client: PoolClient,
  companyId: string,
  charges: ScenarioYaml['damage_charges'],
  refs: RefMaps,
): Promise<void> {
  if (!charges) return
  for (const c of charges) {
    const id = refUuid('damage_charge', c.ref)
    refs.damageCharges.set(c.ref, id)
    const projectId = mustResolve('project', c.project_ref, refs.projects)
    const customerId = c.customer_ref ? (refs.customers.get(c.customer_ref) ?? null) : null
    const kind = c.kind ?? 'damage'
    const quantity = c.quantity ?? 1
    const unitAmount = c.unit_amount ?? 0
    const totalAmount = c.total_amount ?? quantity * unitAmount

    await client.query(
      `insert into damage_charges
         (id, company_id, project_id, customer_id, kind, quantity, unit_amount, total_amount,
          description, status, state_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', 1)
       on conflict (id) do nothing`,
      [id, companyId, projectId, customerId, kind, quantity, unitAmount, totalAmount, c.description],
    )

    if (c.settlement_event_log && c.settlement_event_log.length > 0) {
      const events = c.settlement_event_log as DamageChargeSettlementWorkflowEvent[]
      const initial: DamageChargeSettlementWorkflowSnapshot = { state: 'open', state_version: 1 }
      const result = await applyEventSequence<
        DamageChargeSettlementWorkflowSnapshot,
        DamageChargeSettlementWorkflowEvent
      >(client, {
        workflowName: 'damage_charge_settlement',
        entityType: 'damage_charge',
        entityId: id,
        companyId,
        initialSnapshot: initial as unknown as Record<string, unknown> & {
          state: string
          state_version: number
        },
        events,
      })
      const final = result.finalSnapshot
      await client.query(
        `update damage_charges
           set status = $1,
               state_version = $2,
               invoiced_at = $3,
               invoiced_by = $4,
               waived_at = $5,
               waived_by = $6,
               waive_reason = $7,
               updated_at = now()
         where id = $8 and company_id = $9`,
        [
          final.state,
          final.state_version,
          final.invoiced_at ?? null,
          final.invoiced_by ?? null,
          final.waived_at ?? null,
          final.waived_by ?? null,
          final.waive_reason ?? null,
          id,
          companyId,
        ],
      )
    }
  }
}

// ---------- Rental requests (rental_request_approval workflow) ----------

async function ensureRentalRequests(
  client: PoolClient,
  companyId: string,
  requests: ScenarioYaml['rental_requests'],
  refs: RefMaps,
): Promise<void> {
  if (!requests) return
  for (const r of requests) {
    const id = refUuid('rental_request', r.ref)
    refs.rentalRequests.set(r.ref, id)
    const customerId = r.customer_ref ? (refs.customers.get(r.customer_ref) ?? null) : null

    await client.query(
      `insert into rental_requests
         (id, company_id, customer_id, items, requested_start, requested_end,
          contact_name, contact_email, contact_phone, notes, status, state_version)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, 'pending', 1)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        customerId,
        JSON.stringify(r.items ?? []),
        r.requested_start ?? null,
        r.requested_end ?? null,
        r.contact_name ?? null,
        r.contact_email ?? null,
        r.contact_phone ?? null,
        r.notes ?? null,
      ],
    )

    if (r.approval_event_log && r.approval_event_log.length > 0) {
      const events = r.approval_event_log as RentalRequestApprovalWorkflowEvent[]
      const initial: RentalRequestApprovalWorkflowSnapshot = { state: 'pending', state_version: 1 }
      const result = await applyEventSequence<
        RentalRequestApprovalWorkflowSnapshot,
        RentalRequestApprovalWorkflowEvent
      >(client, {
        workflowName: 'rental_request_approval',
        entityType: 'rental_request',
        entityId: id,
        companyId,
        initialSnapshot: initial as unknown as Record<string, unknown> & {
          state: string
          state_version: number
        },
        events,
      })
      const final = result.finalSnapshot
      await client.query(
        `update rental_requests
           set status = $1,
               state_version = $2,
               approved_at = $3,
               approved_by = $4,
               rejected_at = $5,
               updated_at = now()
         where id = $6 and company_id = $7`,
        [
          final.state,
          final.state_version,
          final.approved_at ?? null,
          final.approved_by ?? null,
          final.declined_at ?? null,
          id,
          companyId,
        ],
      )
    }
  }
}

// ---------- QBO sync runs (qbo_sync_run workflow) ----------

async function ensureQboSyncRuns(
  client: PoolClient,
  companyId: string,
  runs: ScenarioYaml['qbo_sync_runs'],
  refs: RefMaps,
): Promise<void> {
  if (!runs) return
  for (const r of runs) {
    const id = refUuid('qbo_sync_run', r.ref)
    refs.qboSyncRuns.set(r.ref, id)
    const provider = r.provider ?? 'qbo'

    // Ensure an integration_connections row exists for this provider.
    // qbo_sync_runs.integration_connection_id is NOT NULL, so we create
    // a stub connection for the scenario tenant if none exists yet.
    const connectionId = refUuid('integration_connection', `${provider}:${r.ref}`)
    await client.query(
      `insert into integration_connections (id, company_id, provider, status)
       values ($1, $2, $3, 'connecting')
       on conflict (id) do nothing`,
      [connectionId, companyId, provider],
    )

    await client.query(
      `insert into qbo_sync_runs
         (id, company_id, integration_connection_id, status, state_version, triggered_by)
       values ($1, $2, $3, 'pending', 1, $4)
       on conflict (id) do nothing`,
      [id, companyId, connectionId, r.triggered_by ?? null],
    )

    if (r.sync_event_log && r.sync_event_log.length > 0) {
      const events = r.sync_event_log as QboSyncRunWorkflowEvent[]
      const initial: QboSyncRunWorkflowSnapshot = { state: 'pending', state_version: 1 }
      const result = await applyEventSequence<QboSyncRunWorkflowSnapshot, QboSyncRunWorkflowEvent>(client, {
        workflowName: 'qbo_sync_run',
        entityType: 'qbo_sync_run',
        entityId: id,
        companyId,
        initialSnapshot: initial as unknown as Record<string, unknown> & {
          state: string
          state_version: number
        },
        events,
      })
      const final = result.finalSnapshot
      await client.query(
        `update qbo_sync_runs
           set status = $1,
               state_version = $2,
               started_at = $3,
               succeeded_at = $4,
               failed_at = $5,
               retried_at = $6,
               error = $7,
               snapshot = coalesce($8::jsonb, snapshot),
               triggered_by = coalesce($9, triggered_by),
               updated_at = now()
         where id = $10 and company_id = $11`,
        [
          final.state,
          final.state_version,
          final.started_at ?? null,
          final.succeeded_at ?? null,
          final.failed_at ?? null,
          final.retried_at ?? null,
          final.error ?? null,
          final.snapshot ? JSON.stringify(final.snapshot) : null,
          final.triggered_by ?? null,
          id,
          companyId,
        ],
      )
    }
  }
}

// ---------- BOMs (scaffold_ops_approval workflow) ----------

async function ensureBoms(
  client: PoolClient,
  companyId: string,
  boms: ScenarioYaml['boms'],
  refs: RefMaps,
): Promise<void> {
  if (!boms) return
  for (const b of boms) {
    const id = refUuid('bom', b.ref)
    refs.boms.set(b.ref, id)
    const projectId = mustResolve('project', b.project_ref, refs.projects)

    await client.query(
      `insert into boms
         (id, company_id, project_id, source, source_ref, name, notes,
          status, state_version, total_weight_kg, total_lines)
       values ($1, $2, $3, $4, $5, $6, $7, 'draft', 1, $8, $9)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        projectId,
        b.source ?? 'manual',
        b.source_ref ?? null,
        b.name,
        b.notes ?? null,
        b.total_weight_kg ?? 0,
        b.total_lines ?? 0,
      ],
    )

    if (b.approval_event_log && b.approval_event_log.length > 0) {
      const events = b.approval_event_log as ScaffoldOpsApprovalWorkflowEvent[]
      const initial: ScaffoldOpsApprovalWorkflowSnapshot = { state: 'draft', state_version: 1 }
      const result = await applyEventSequence<ScaffoldOpsApprovalWorkflowSnapshot, ScaffoldOpsApprovalWorkflowEvent>(
        client,
        {
          workflowName: 'scaffold_ops_approval',
          entityType: 'bom',
          entityId: id,
          companyId,
          initialSnapshot: initial as unknown as Record<string, unknown> & {
            state: string
            state_version: number
          },
          events,
        },
      )
      const final = result.finalSnapshot
      await client.query(
        `update boms
           set status = $1,
               state_version = $2,
               approved_at = $3,
               approved_by = $4,
               updated_at = now()
         where id = $5 and company_id = $6`,
        [final.state, final.state_version, final.approved_at ?? null, final.approved_by ?? null, id, companyId],
      )
    }
  }
}

// ---------- Helpers ----------

function mustResolve(scope: string, ref: string, map: Map<string, string>): string {
  const id = map.get(ref)
  if (!id) {
    throw new Error(`scenario references unknown ${scope}: "${ref}" — define it before the section that uses it`)
  }
  return id
}

interface SeedSummary {
  company_id: string
  company_slug: string
  customers: Array<{ ref: string; id: string }>
  workers: Array<{ ref: string; id: string }>
  inventory: Array<{ ref: string; id: string }>
  projects: Array<{ ref: string; id: string }>
  rentals: Array<{ ref: string; contract_id: string; billing_run_id: string }>
  estimates: Array<{ ref: string; id: string }>
  worker_issues: Array<{ ref: string; id: string }>
  damage_charges: Array<{ ref: string; id: string }>
  rental_requests: Array<{ ref: string; id: string }>
  qbo_sync_runs: Array<{ ref: string; id: string }>
  boms: Array<{ ref: string; id: string }>
}

function summarize(scenario: ScenarioYaml, companyId: string, refs: RefMaps): SeedSummary {
  return {
    company_id: companyId,
    company_slug: scenario.company.slug,
    customers: Array.from(refs.customers.entries()).map(([ref, id]) => ({ ref, id })),
    workers: Array.from(refs.workers.entries()).map(([ref, id]) => ({ ref, id })),
    inventory: Array.from(refs.inventory.entries()).map(([ref, id]) => ({ ref, id })),
    projects: Array.from(refs.projects.entries()).map(([ref, id]) => ({ ref, id })),
    rentals: Array.from(refs.rentalContracts.entries()).map(([ref, contract_id]) => ({
      ref,
      contract_id,
      billing_run_id: refs.rentalBillingRuns.get(ref) ?? '',
    })),
    estimates: Array.from(refs.estimates.entries()).map(([ref, id]) => ({ ref, id })),
    worker_issues: Array.from(refs.workerIssues.entries()).map(([ref, id]) => ({ ref, id })),
    damage_charges: Array.from(refs.damageCharges.entries()).map(([ref, id]) => ({ ref, id })),
    rental_requests: Array.from(refs.rentalRequests.entries()).map(([ref, id]) => ({ ref, id })),
    qbo_sync_runs: Array.from(refs.qboSyncRuns.entries()).map(([ref, id]) => ({ ref, id })),
    boms: Array.from(refs.boms.entries()).map(([ref, id]) => ({ ref, id })),
  }
}

// ---------- Main ----------

export async function seedScenario(scenarioPath: string): Promise<SeedSummary> {
  const config = loadAppConfig()
  if (config.tier === 'prod') {
    throw new TierConfigError('seed-scenario refuses to run when APP_TIER=prod')
  }

  const raw = readFileSync(scenarioPath, 'utf-8')
  const scenario = parseYaml(raw) as ScenarioYaml
  if (!scenario || typeof scenario !== 'object' || !scenario.company?.slug) {
    throw new Error(`scenario file ${scenarioPath} missing required \`company.slug\``)
  }

  const pool = new Pool(getPoolConfig(config.databaseUrl, config.tier))
  try {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const refs = newRefMaps()
      const companyId = await ensureCompany(client, scenario)
      await ensureMemberships(client, companyId, scenario.members)
      // Reuse the canonical onboarding seed for divisions / service items /
      // pricing profile / bonus rule / default yard — keeps every scenario
      // tenant aligned with how new customers come online.
      await seedCompanyDefaults(client, companyId)
      await ensureCustomers(client, companyId, scenario.customers, refs)
      await ensureWorkers(client, companyId, scenario.workers, refs)
      await ensureInventory(client, companyId, scenario.inventory, refs)
      await ensureProjects(client, companyId, scenario.projects, refs)
      await ensureRentals(client, companyId, scenario.rentals, refs)
      await ensureEstimates(client, companyId, scenario.estimates, refs)
      await ensureWorkerIssues(client, companyId, scenario.worker_issues, refs)
      await ensureClockEvents(client, companyId, scenario.clock_events, refs)
      await ensureTakeoffMeasurements(client, companyId, scenario.takeoff_measurements, refs)
      await ensureDamageCharges(client, companyId, scenario.damage_charges, refs)
      await ensureRentalRequests(client, companyId, scenario.rental_requests, refs)
      await ensureQboSyncRuns(client, companyId, scenario.qbo_sync_runs, refs)
      await ensureBoms(client, companyId, scenario.boms, refs)
      await client.query('commit')
      return summarize(scenario, companyId, refs)
    } catch (err) {
      await client.query('rollback').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed-scenario.ts')
if (isMain) {
  const scenarioArg = process.argv[2]
  if (!scenarioArg) {
    process.stderr.write('usage: seed-scenario.ts <path-to-scenario.yaml>\n')
    process.exit(1)
  }
  const resolved = path.resolve(scenarioArg)
  seedScenario(resolved)
    .then((summary) => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
      process.exit(0)
    })
    .catch((err) => {
      if (err instanceof TierConfigError) {
        process.stderr.write(`[seed-scenario] config error: ${err.message}\n`)
        process.exit(1)
      }
      process.stderr.write(
        `[seed-scenario] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      )
      process.exit(2)
    })
}
