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
 *   capture_sessions:           # exercises the capture -> context work loop
 *     - ref: walkthrough-gap
 *       actor_user_id: e2e-admin
 *       mode: feedback
 *       route_path: /desktop/estimator/ai-takeoff
 *       consent_version: pilot-feedback-v1
 *       events:
 *         - event_type: ui.dead_control
 *           event_class: feedback
 *       artifacts:
 *         - kind: transcript
 *           uri: scenario://walkthrough-gap/transcript.txt
 *           content_type: text/plain
 *       work_item:
 *         title: Verify captured feedback turns into work
 *         summary: Seeded scenario item linked to a capture session.
 *         lane: both
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
  changeOrderWorkflow as _changeOrder,
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
  type ChangeOrderWorkflowEvent,
  type ChangeOrderWorkflowSnapshot,
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
void _changeOrder

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
    // Supply either a literal ISO timestamp or a relative offset in minutes
    // from now (negative = in the past). The offset keeps a "clocked-in right
    // now" demo row live no matter when it is seeded.
    occurred_at?: string
    occurred_at_offset_minutes?: number
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
  // ---- Demo-oriented sections (steve-demo.yaml) ----
  estimate_lines?: Array<{
    project_ref: string
    service_item_code: string
    quantity: number
    unit?: string
    rate?: number
    amount?: number
  }>
  material_bills?: Array<{
    project_ref: string
    vendor_name: string
    amount: number
    bill_type?: string
    description?: string
    occurred_on?: string
    occurred_on_offset_days?: number
  }>
  labor_entries?: Array<{
    project_ref: string
    worker_ref?: string
    service_item_code: string
    hours?: number
    sqft_done?: number
    status?: string
    occurred_on?: string
    occurred_on_offset_days?: number
  }>
  change_orders?: Array<{
    ref: string
    project_ref: string
    number: number
    description?: string
    value_delta: number
    schedule_impact_days?: number
    created_by?: string
    co_event_log?: Array<Record<string, unknown>>
  }>
  crew_schedules?: Array<{
    ref: string
    project_ref: string
    scheduled_for?: string
    scheduled_for_offset_days?: number
    crew?: Array<{ worker_ref?: string; clerk_user_id?: string; name?: string }>
    status?: string
    confirmed_by?: string
  }>
  daily_logs?: Array<{
    ref?: string
    project_ref: string
    foreman_user_id: string
    occurred_on?: string
    occurred_on_offset_days?: number
    status?: string
    notes?: string
    scope_progress?: unknown[]
  }>
  takeoff_drafts?: Array<{
    ref: string
    project_ref: string
    name: string
    type?: string
    source?: string
    kind?: string
    status?: string
    review_required?: boolean
    result_json?: Record<string, unknown>
    measurements?: Array<{ service_item_code: string; quantity: number; unit?: string }>
  }>
  capture_sessions?: Array<{
    ref: string
    actor_user_id?: string
    mode?: string
    status?: string
    route_path?: string
    device_kind?: string
    platform?: string
    viewport?: string
    app_build_sha?: string
    consent_version?: string
    consent_actor_kind?: string
    consent_actor_ref?: string
    consent_authority?: string
    consent_scope?: Record<string, unknown>
    metadata?: Record<string, unknown>
    started_at?: string
    started_offset_minutes?: number
    stopped_at?: string
    stopped_offset_minutes?: number
    discarded_at?: string
    discarded_offset_minutes?: number
    retention_expires_at?: string
    retention_offset_days?: number
    events?: Array<{
      event_type: string
      event_class?: string
      route_path?: string
      workflow_id?: string
      entity_type?: string
      entity_id?: string
      entity_ref?: string
      client_event_id?: string
      seq?: number
      request_id?: string
      payload?: Record<string, unknown>
      occurred_at?: string
      occurred_offset_minutes?: number
    }>
    artifacts?: Array<{
      ref?: string
      kind: string
      storage_key?: string
      uri?: string
      content_type?: string
      byte_size?: number
      content_hash?: string
      duration_ms?: number
      pii_level?: string
      access_policy?: string
      metadata?: Record<string, unknown>
      retention_expires_at?: string
      retention_offset_days?: number
      created_at?: string
      created_offset_minutes?: number
      deleted_at?: string
      redaction_version?: string
    }>
    work_item?: {
      ref?: string
      support_packet_ref?: string
      title: string
      summary?: string
      status?: string
      lane?: string
      severity?: string
      route?: string
      entity_type?: string
      entity_id?: string
      entity_ref?: string
      assignee_user_id?: string
      created_by_user_id?: string
      metadata?: Record<string, unknown>
      reversibility_window_seconds?: number
      created_at?: string
      created_offset_minutes?: number
      resolved_at?: string
      handoff_events?: Array<{
        event_type: string
        actor_kind?: string
        actor_user_id?: string
        actor_ref?: string
        source_system?: string
        payload?: Record<string, unknown>
        metadata?: Record<string, unknown>
        idempotency_key?: string
        request_id?: string
        build_sha?: string
        redaction_version?: string
        occurred_at?: string
        occurred_offset_minutes?: number
      }>
    }
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
  changeOrders: Map<string, string>
  crewSchedules: Map<string, string>
  takeoffDrafts: Map<string, string>
  captureSessions: Map<string, string>
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
    changeOrders: new Map(),
    crewSchedules: new Map(),
    takeoffDrafts: new Map(),
    captureSessions: new Map(),
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
    // Resolve the timestamp from a literal ISO or a relative minute offset.
    let occurredAt = ev.occurred_at
    if (!occurredAt) {
      const d = new Date()
      d.setUTCMinutes(d.getUTCMinutes() + (ev.occurred_at_offset_minutes ?? 0))
      occurredAt = d.toISOString()
    }
    // Deterministic id. For literal timestamps key on the full instant; for
    // offset rows key on the calendar day so a "clocked-in now" event mints a
    // fresh row each day while same-day re-seeds collapse to one row.
    const idKey = ev.occurred_at ? occurredAt : occurredAt.slice(0, 10)
    const id = refUuid('clock_event', `${ev.worker_ref ?? '-'}|${ev.project_ref ?? '-'}|${idKey}|${ev.event_type}|${i}`)
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
        occurredAt,
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

// ---------- Demo sections: estimate lines, money, crew, logs, AI-queue ----------

/**
 * Resolve a date column value either from a literal ISO date or a relative
 * offset in days from today. Offset rows keep a demo looking "live" no matter
 * when it is seeded; literal dates pin historical rows. The returned value is a
 * `YYYY-MM-DD` string bound as a normal parameter and cast `::date` in SQL.
 */
function resolveDate(literal: string | undefined, offsetDays: number | undefined): string {
  if (literal) return literal
  const offset = offsetDays ?? 0
  // Compute deterministically in JS so the resulting row id (which keys on the
  // resolved date) is stable for a given calendar day — re-seeding the same day
  // is a no-op, a new day mints a fresh "today" row.
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

/**
 * Ensure a single active default takeoff draft exists for a project and return
 * its id. estimate_lines.draft_id is NOT NULL (migration 068), so every line we
 * stamp needs a draft to hang off. Mirrors migration 066's 'Default' draft.
 */
async function ensureProjectDefaultDraft(
  client: PoolClient,
  companyId: string,
  projectRef: string,
  projectId: string,
): Promise<string> {
  const draftId = refUuid('takeoff_draft', `${projectRef}:default`)
  await client.query(
    `insert into takeoff_drafts (id, company_id, project_id, name, type, status, source, kind)
     values ($1, $2, $3, 'Default', 'measurement', 'active', 'manual', 'takeoff')
     on conflict (id) do nothing`,
    [draftId, companyId, projectId],
  )
  return draftId
}

async function ensureEstimateLines(
  client: PoolClient,
  companyId: string,
  lines: ScenarioYaml['estimate_lines'],
  refs: RefMaps,
): Promise<void> {
  if (!lines) return
  // estimate_lines.draft_id is NOT NULL — share one default draft per project.
  const draftCache = new Map<string, string>()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const projectId = mustResolve('project', l.project_ref, refs.projects)
    let draftId = draftCache.get(l.project_ref)
    if (!draftId) {
      draftId = await ensureProjectDefaultDraft(client, companyId, l.project_ref, projectId)
      draftCache.set(l.project_ref, draftId)
    }
    const id = refUuid('estimate_line', `${l.project_ref}:${i}`)
    const quantity = l.quantity ?? 0
    const rate = l.rate ?? 0
    const amount = l.amount ?? quantity * rate
    await client.query(
      `insert into estimate_lines
         (id, company_id, project_id, draft_id, service_item_code, quantity, unit, rate, amount)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do nothing`,
      [id, companyId, projectId, draftId, l.service_item_code, quantity, l.unit ?? 'sqft', rate, amount],
    )
  }
}

async function ensureMaterialBills(
  client: PoolClient,
  companyId: string,
  bills: ScenarioYaml['material_bills'],
  refs: RefMaps,
): Promise<void> {
  if (!bills) return
  for (let i = 0; i < bills.length; i++) {
    const b = bills[i]!
    const projectId = mustResolve('project', b.project_ref, refs.projects)
    const id = refUuid('material_bill', `${b.project_ref}:${i}`)
    const occurredOn = resolveDate(b.occurred_on, b.occurred_on_offset_days)
    await client.query(
      `insert into material_bills
         (id, company_id, project_id, vendor_name, amount, bill_type, description, occurred_on)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date)
       on conflict (id) do nothing`,
      [id, companyId, projectId, b.vendor_name, b.amount, b.bill_type ?? 'material', b.description ?? null, occurredOn],
    )
  }
}

async function ensureLaborEntries(
  client: PoolClient,
  companyId: string,
  entries: ScenarioYaml['labor_entries'],
  refs: RefMaps,
): Promise<void> {
  if (!entries) return
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const projectId = mustResolve('project', e.project_ref, refs.projects)
    const workerId = e.worker_ref ? (refs.workers.get(e.worker_ref) ?? null) : null
    const occurredOn = resolveDate(e.occurred_on, e.occurred_on_offset_days)
    // Deterministic id keyed on the resolved date so a date-relative entry
    // mints a fresh row each calendar day and re-seeding the same day is a
    // no-op.
    const id = refUuid(
      'labor_entry',
      `${e.project_ref}:${e.worker_ref ?? '-'}:${e.service_item_code}:${occurredOn}:${i}`,
    )
    await client.query(
      `insert into labor_entries
         (id, company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        projectId,
        workerId,
        e.service_item_code,
        e.hours ?? 0,
        e.sqft_done ?? 0,
        e.status ?? 'locked',
        occurredOn,
      ],
    )
  }
}

async function ensureChangeOrders(
  client: PoolClient,
  companyId: string,
  orders: ScenarioYaml['change_orders'],
  refs: RefMaps,
): Promise<void> {
  if (!orders) return
  for (const co of orders) {
    const id = refUuid('change_order', co.ref)
    refs.changeOrders.set(co.ref, id)
    const projectId = mustResolve('project', co.project_ref, refs.projects)
    await client.query(
      `insert into change_orders
         (id, company_id, project_id, number, description, value_delta, schedule_impact_days,
          status, state_version, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'draft', 1, $8)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        projectId,
        co.number,
        co.description ?? '',
        co.value_delta,
        co.schedule_impact_days ?? 0,
        co.created_by ?? null,
      ],
    )

    if (co.co_event_log && co.co_event_log.length > 0) {
      const events = co.co_event_log as ChangeOrderWorkflowEvent[]
      const initial: ChangeOrderWorkflowSnapshot = { state: 'draft', state_version: 1 }
      const result = await applyEventSequence<ChangeOrderWorkflowSnapshot, ChangeOrderWorkflowEvent>(client, {
        workflowName: 'change_order',
        entityType: 'change_order',
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
        `update change_orders
           set status = $1,
               state_version = $2,
               sent_at = $3,
               accepted_at = $4,
               rejected_at = $5,
               voided_at = $6,
               reject_reason = $7,
               approved_by = coalesce($8, approved_by),
               updated_at = now()
         where id = $9 and company_id = $10`,
        [
          final.state,
          final.state_version,
          final.sent_at ?? null,
          final.accepted_at ?? null,
          final.rejected_at ?? null,
          final.voided_at ?? null,
          final.reject_reason ?? null,
          final.approved_by ?? null,
          id,
          companyId,
        ],
      )
    }
  }
}

async function ensureCrewSchedules(
  client: PoolClient,
  companyId: string,
  schedules: ScenarioYaml['crew_schedules'],
  refs: RefMaps,
): Promise<void> {
  if (!schedules) return
  for (const s of schedules) {
    const projectId = mustResolve('project', s.project_ref, refs.projects)
    const scheduledFor = resolveDate(s.scheduled_for, s.scheduled_for_offset_days)
    // Key the id on the resolved date so an offset 'today' schedule mints a
    // fresh row each day (and re-seeding the same day is a no-op).
    const id = refUuid('crew_schedule', `${s.ref}:${scheduledFor}`)
    refs.crewSchedules.set(s.ref, id)
    const crew = (s.crew ?? []).map((c) => ({
      worker_id: c.worker_ref ? (refs.workers.get(c.worker_ref) ?? null) : null,
      name: c.name ?? c.worker_ref ?? null,
      clerk_user_id: c.clerk_user_id ?? null,
    }))
    const status = s.status ?? 'confirmed'
    // The crew_schedule reducer only has draft/confirmed; a confirmed row lands
    // at state_version=2 with confirmed_at/by (migration 022 backfill shape).
    const isConfirmed = status === 'confirmed'
    await client.query(
      `insert into crew_schedules
         (id, company_id, project_id, scheduled_for, crew, status, version, state_version,
          confirmed_at, confirmed_by, created_by)
       values ($1, $2, $3, $4::date, $5::jsonb, $6, 1, $7, $8, $9, $10)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        projectId,
        scheduledFor,
        JSON.stringify(crew),
        status,
        isConfirmed ? 2 : 1,
        isConfirmed ? new Date().toISOString() : null,
        isConfirmed ? (s.confirmed_by ?? null) : null,
        s.confirmed_by ?? null,
      ],
    )
  }
}

async function ensureDailyLogs(
  client: PoolClient,
  companyId: string,
  logs: ScenarioYaml['daily_logs'],
  refs: RefMaps,
): Promise<void> {
  if (!logs) return
  for (const log of logs) {
    const projectId = mustResolve('project', log.project_ref, refs.projects)
    const occurredOn = resolveDate(log.occurred_on, log.occurred_on_offset_days)
    // daily_logs is UNIQUE (company, project, occurred_on, foreman_user_id);
    // key the id on the same tuple so re-seeding collapses to one row and an
    // offset 'today' draft log refreshes per calendar day.
    const id = refUuid('daily_log', log.ref ?? `${log.project_ref}:${log.foreman_user_id}:${occurredOn}`)
    const status = log.status ?? 'draft'
    // Check constraint (082): submitted ⇒ submitted_at set + state_version=2;
    // draft ⇒ submitted_at null + state_version=1.
    const isSubmitted = status === 'submitted'
    await client.query(
      `insert into daily_logs
         (id, company_id, project_id, occurred_on, foreman_user_id, scope_progress, notes,
          status, submitted_at, state_version)
       values ($1, $2, $3, $4::date, $5, $6::jsonb, $7, $8, $9, $10)
       on conflict (id) do nothing`,
      [
        id,
        companyId,
        projectId,
        occurredOn,
        log.foreman_user_id,
        JSON.stringify(log.scope_progress ?? []),
        log.notes ?? null,
        status,
        isSubmitted ? new Date().toISOString() : null,
        isSubmitted ? 2 : 1,
      ],
    )
  }
}

/**
 * Rich takeoff drafts (distinct from the bulk `takeoff_measurements` perf
 * helper). Each draft can declare a capture `source` and `kind` so an
 * AI-queue item (source<>'manual' + review_required=true) surfaces in
 * GET /api/takeoff-drafts, and an optional `measurements[]` gives the draft
 * real geometry to review.
 */
async function ensureTakeoffDraftsRich(
  client: PoolClient,
  companyId: string,
  drafts: ScenarioYaml['takeoff_drafts'],
  refs: RefMaps,
): Promise<void> {
  if (!drafts) return
  for (const d of drafts) {
    const projectId = mustResolve('project', d.project_ref, refs.projects)
    const draftId = refUuid('takeoff_draft', d.ref)
    refs.takeoffDrafts.set(d.ref, draftId)
    await client.query(
      `insert into takeoff_drafts
         (id, company_id, project_id, name, type, status, source, kind, review_required, takeoff_result_json)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       on conflict (id) do nothing`,
      [
        draftId,
        companyId,
        projectId,
        d.name,
        d.type ?? 'measurement',
        d.status ?? 'active',
        d.source ?? 'manual',
        d.kind ?? 'takeoff',
        d.review_required ?? false,
        d.result_json ? JSON.stringify(d.result_json) : null,
      ],
    )

    if (d.measurements && d.measurements.length > 0) {
      for (let i = 0; i < d.measurements.length; i++) {
        const m = d.measurements[i]!
        const id = refUuid('takeoff_measurement', `${d.ref}:${i}`)
        await client.query(
          `insert into takeoff_measurements
             (id, company_id, project_id, draft_id, service_item_code, quantity, unit)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (id) do nothing`,
          [id, companyId, projectId, draftId, m.service_item_code, m.quantity, m.unit ?? 'sqft'],
        )
      }
    }
  }
}

// ---------- Demo sections: capture sessions -> support packet -> context work ----------

function resolveTimestamp(
  literal: string | undefined,
  offsetMinutes: number | undefined,
  fallbackOffsetMinutes: number,
): string {
  if (literal) return literal
  const d = new Date()
  d.setUTCMinutes(d.getUTCMinutes() + (offsetMinutes ?? fallbackOffsetMinutes))
  return d.toISOString()
}

function resolveOptionalTimestamp(literal: string | undefined, offsetMinutes: number | undefined): string | null {
  if (literal) return literal
  if (offsetMinutes === undefined) return null
  const d = new Date()
  d.setUTCMinutes(d.getUTCMinutes() + offsetMinutes)
  return d.toISOString()
}

function resolveRetentionTimestamp(literal: string | undefined, offsetDays: number | undefined): string | null {
  if (literal) return literal
  if (offsetDays === undefined) return null
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString()
}

function entityIdFromRef(entityType: string | undefined, entityRef: string | undefined, refs: RefMaps): string | null {
  if (!entityRef) return null
  if (!entityType) throw new Error(`entity_ref "${entityRef}" requires entity_type`)

  const normalized = entityType.trim()
  switch (normalized) {
    case 'customer':
      return mustResolve('customer', entityRef, refs.customers)
    case 'worker':
      return mustResolve('worker', entityRef, refs.workers)
    case 'inventory_item':
    case 'inventory':
      return mustResolve('inventory', entityRef, refs.inventory)
    case 'project':
      return mustResolve('project', entityRef, refs.projects)
    case 'rental_contract':
      return mustResolve('rental_contract', entityRef, refs.rentalContracts)
    case 'rental_billing_run':
      return mustResolve('rental_billing_run', entityRef, refs.rentalBillingRuns)
    case 'estimate_push':
    case 'estimate':
      return mustResolve('estimate_push', entityRef, refs.estimates)
    case 'worker_issue':
      return mustResolve('worker_issue', entityRef, refs.workerIssues)
    case 'damage_charge':
      return mustResolve('damage_charge', entityRef, refs.damageCharges)
    case 'rental_request':
      return mustResolve('rental_request', entityRef, refs.rentalRequests)
    case 'qbo_sync_run':
      return mustResolve('qbo_sync_run', entityRef, refs.qboSyncRuns)
    case 'bom':
      return mustResolve('bom', entityRef, refs.boms)
    case 'change_order':
      return mustResolve('change_order', entityRef, refs.changeOrders)
    case 'crew_schedule':
      return mustResolve('crew_schedule', entityRef, refs.crewSchedules)
    case 'takeoff_draft':
      return mustResolve('takeoff_draft', entityRef, refs.takeoffDrafts)
    case 'capture_session':
      return mustResolve('capture_session', entityRef, refs.captureSessions)
    default:
      throw new Error(`scenario references unsupported entity_type "${entityType}" for entity_ref "${entityRef}"`)
  }
}

function resolveEntityId(
  refs: RefMaps,
  entityType: string | undefined,
  entityId: string | undefined,
  entityRef: string | undefined,
): string | null {
  return entityId ?? entityIdFromRef(entityType, entityRef, refs)
}

async function ensureCaptureSessions(
  client: PoolClient,
  companyId: string,
  sessions: ScenarioYaml['capture_sessions'],
  refs: RefMaps,
  scenarioSlug: string,
): Promise<void> {
  if (!sessions) return
  for (const session of sessions) {
    const sessionId = refUuid('capture_session', session.ref)
    refs.captureSessions.set(session.ref, sessionId)
    const actorUserId = session.actor_user_id ?? 'scenario-seed'
    const mode = session.mode ?? 'feedback'
    const status = session.status ?? 'stopped'
    const startedAt = resolveTimestamp(session.started_at, session.started_offset_minutes, -20)
    const stoppedAt =
      status === 'stopped' || status === 'failed' || status === 'redacted'
        ? resolveTimestamp(session.stopped_at, session.stopped_offset_minutes, -5)
        : resolveOptionalTimestamp(session.stopped_at, session.stopped_offset_minutes)
    const discardedAt =
      status === 'discarded'
        ? resolveTimestamp(session.discarded_at, session.discarded_offset_minutes, -5)
        : resolveOptionalTimestamp(session.discarded_at, session.discarded_offset_minutes)
    const retentionExpiresAt = resolveRetentionTimestamp(
      session.retention_expires_at,
      session.retention_offset_days ?? 30,
    )
    const consentVersion = session.consent_version ?? (mode === 'trace' ? '' : 'scenario-feedback-v1')
    const consentActorKind = session.consent_actor_kind ?? (consentVersion ? 'user' : null)
    const consentActorRef = session.consent_actor_ref ?? (consentVersion ? actorUserId : null)
    const consentAuthority = session.consent_authority ?? (consentVersion ? 'scenario_seed' : null)
    const consentedAt = consentVersion ? startedAt : null
    const lastSeenAt = stoppedAt ?? discardedAt ?? startedAt
    const routePath = session.route_path ?? null
    const appBuildSha = session.app_build_sha ?? 'seed-scenario'
    const sessionMetadata = {
      source: 'seed_scenario',
      scenario: scenarioSlug,
      ref: session.ref,
      ...(session.metadata ?? {}),
    }

    await client.query(
      `insert into capture_sessions (
         id, company_id, actor_user_id, mode, status, route_path, device_kind,
         platform, viewport, app_build_sha, consent_version, redaction_version,
         metadata, started_at, last_seen_at, stopped_at, discarded_at,
         retention_expires_at, consent_actor_kind, consent_actor_ref,
         consent_authority, consent_scope, consented_at
       )
       values (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, 'capture-session-v1',
         $12::jsonb, $13::timestamptz, $14::timestamptz, $15::timestamptz, $16::timestamptz,
         $17::timestamptz, $18, $19,
         $20, $21::jsonb, $22::timestamptz
       )
       on conflict (id) do nothing`,
      [
        sessionId,
        companyId,
        actorUserId,
        mode,
        status,
        routePath,
        session.device_kind ?? null,
        session.platform ?? null,
        session.viewport ?? null,
        appBuildSha,
        consentVersion,
        JSON.stringify(sessionMetadata),
        startedAt,
        lastSeenAt,
        stoppedAt,
        discardedAt,
        retentionExpiresAt,
        consentActorKind,
        consentActorRef,
        consentAuthority,
        JSON.stringify({
          mode,
          route_path: routePath,
          ...(session.consent_scope ?? {}),
        }),
        consentedAt,
      ],
    )

    for (let i = 0; i < (session.events ?? []).length; i++) {
      const ev = session.events![i]!
      const eventId = refUuid('capture_session_event', `${session.ref}:${i}`)
      const occurredAt = resolveTimestamp(ev.occurred_at, ev.occurred_offset_minutes, -20 + i)
      await client.query(
        `insert into capture_session_events (
           id, company_id, capture_session_id, seq, client_event_id, event_type,
           event_class, route_path, workflow_id, entity_type, entity_id,
           request_id, payload, redaction_version, occurred_at
         )
         values (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12, $13::jsonb, 'capture-session-v1', $14::timestamptz
         )
         on conflict (id) do nothing`,
        [
          eventId,
          companyId,
          sessionId,
          ev.seq ?? i,
          ev.client_event_id ?? `${session.ref}:${i}`,
          ev.event_type,
          ev.event_class ?? 'scenario',
          ev.route_path ?? routePath,
          ev.workflow_id ?? null,
          ev.entity_type ?? null,
          resolveEntityId(refs, ev.entity_type, ev.entity_id, ev.entity_ref),
          ev.request_id ?? null,
          JSON.stringify(ev.payload ?? {}),
          occurredAt,
        ],
      )
    }

    for (let i = 0; i < (session.artifacts ?? []).length; i++) {
      const artifact = session.artifacts![i]!
      const artifactRef = artifact.ref ?? `${session.ref}:${i}`
      const artifactId = refUuid('capture_artifact', artifactRef)
      const createdAt = resolveTimestamp(artifact.created_at, artifact.created_offset_minutes, -10 + i)
      const artifactRetention =
        resolveRetentionTimestamp(artifact.retention_expires_at, artifact.retention_offset_days ?? undefined) ??
        retentionExpiresAt
      await client.query(
        `insert into capture_artifacts (
           id, company_id, capture_session_id, kind, storage_key, uri, content_type,
           byte_size, content_hash, duration_ms, pii_level, access_policy,
           metadata, created_at, deleted_at, retention_expires_at, redaction_version
         )
         values (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12,
           $13::jsonb, $14::timestamptz, $15::timestamptz, $16::timestamptz, $17
         )
         on conflict (id) do nothing`,
        [
          artifactId,
          companyId,
          sessionId,
          artifact.kind,
          artifact.storage_key ?? null,
          artifact.uri ?? (artifact.storage_key ? null : `scenario://${scenarioSlug}/capture/${artifactRef}`),
          artifact.content_type ?? null,
          artifact.byte_size ?? null,
          artifact.content_hash ?? null,
          artifact.duration_ms ?? null,
          artifact.pii_level ?? 'internal',
          artifact.access_policy ?? 'support_only',
          JSON.stringify({
            source: 'seed_scenario',
            scenario: scenarioSlug,
            ref: artifactRef,
            ...(artifact.metadata ?? {}),
          }),
          createdAt,
          artifact.deleted_at ?? null,
          artifactRetention,
          artifact.redaction_version ?? 'capture-session-v1',
        ],
      )
    }

    if (session.work_item) {
      const itemSpec = session.work_item
      const eventCount = session.events?.length ?? 0
      const artifactCount = session.artifacts?.length ?? 0
      const supportPacketId = refUuid('support_debug_packet', itemSpec.support_packet_ref ?? `${session.ref}:packet`)
      const workItemId = refUuid('context_work_item', itemSpec.ref ?? `${session.ref}:work-item`)
      const itemRoute = itemSpec.route ?? routePath
      const itemCreatedAt = resolveTimestamp(itemSpec.created_at, itemSpec.created_offset_minutes, -4)
      const itemCreatedBy = itemSpec.created_by_user_id ?? actorUserId
      const entityType = itemSpec.entity_type ?? null
      const entityId = resolveEntityId(refs, itemSpec.entity_type, itemSpec.entity_id, itemSpec.entity_ref)
      const summary =
        itemSpec.summary ??
        `Seeded capture session ${sessionId} finalized from ${mode} mode with ${eventCount} event(s) and ${artifactCount} artifact(s).`
      await client.query(
        `insert into support_debug_packets (
           id, company_id, actor_user_id, request_id, route, capture_session_id,
           build_sha, problem, client, server_context, created_at, expires_at,
           redaction_version
         )
         values (
           $1, $2, $3, null, $4, $5::uuid,
           $6, $7, $8::jsonb, $9::jsonb, $10::timestamptz, $11::timestamptz,
           'support-packet-v1'
         )
         on conflict (id) do nothing`,
        [
          supportPacketId,
          companyId,
          itemCreatedBy,
          itemRoute,
          sessionId,
          appBuildSha,
          summary,
          JSON.stringify({
            source: 'seed_scenario',
            scenario: scenarioSlug,
            capture_session_id: sessionId,
            capture_session: {
              id: sessionId,
              mode,
              status,
              route_path: routePath,
              event_count: eventCount,
              artifact_count: artifactCount,
              consent_version: consentVersion,
              consent_authority: consentAuthority,
            },
            finalization: {
              category: 'capture_session',
              title: itemSpec.title,
              summary,
              lane: itemSpec.lane ?? 'triage',
              severity: itemSpec.severity ?? 'normal',
            },
          }),
          JSON.stringify({
            source: 'seed_scenario',
            scenario: scenarioSlug,
            seeded_tables: [
              'capture_sessions',
              'capture_session_events',
              'capture_artifacts',
              'support_debug_packets',
              'context_work_items',
              'context_handoff_events',
            ],
          }),
          itemCreatedAt,
          retentionExpiresAt,
        ],
      )

      await client.query(
        `insert into context_work_items (
           id, company_id, support_packet_id, title, summary, status, lane,
           severity, route, capture_session_id, entity_type, entity_id,
           assignee_user_id, created_by_user_id, created_at, updated_at,
           resolved_at, metadata, reversibility_window_seconds
         )
         values (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10::uuid, $11, $12,
           $13, $14, $15::timestamptz, $15::timestamptz,
           $16::timestamptz, $17::jsonb, $18
         )
         on conflict (id) do nothing`,
        [
          workItemId,
          companyId,
          supportPacketId,
          itemSpec.title,
          summary,
          itemSpec.status ?? 'new',
          itemSpec.lane ?? 'triage',
          itemSpec.severity ?? 'normal',
          itemRoute,
          sessionId,
          entityType,
          entityId,
          itemSpec.assignee_user_id ?? null,
          itemCreatedBy,
          itemCreatedAt,
          itemSpec.resolved_at ?? null,
          JSON.stringify({
            ...(itemSpec.metadata ?? {}),
            category: 'capture_session',
            source: 'capture_session_finalize',
            scenario: scenarioSlug,
            capture_session_id: sessionId,
            client_request_id: `capture_session_finalize:${sessionId}`,
            support_packet_expires_at: retentionExpiresAt,
            event_count: eventCount,
            artifact_count: artifactCount,
            private_artifact_count: (session.artifacts ?? []).filter((a) =>
              ['private', 'restricted'].includes(a.pii_level ?? ''),
            ).length,
          }),
          itemSpec.reversibility_window_seconds ?? 86400,
        ],
      )

      await insertScenarioHandoffEvent(client, {
        companyId,
        workItemId,
        captureSessionId: sessionId,
        eventId: refUuid('context_handoff_event', `${session.ref}:work-item-created`),
        eventType: 'work_item.created',
        actorKind: 'user',
        actorUserId: itemCreatedBy,
        actorRef: null,
        sourceSystem: 'seed-scenario',
        payload: {
          title: itemSpec.title,
          summary,
          status: itemSpec.status ?? 'new',
          lane: itemSpec.lane ?? 'triage',
          severity: itemSpec.severity ?? 'normal',
          route: itemRoute,
          capture_session_id: sessionId,
          support_packet_id: supportPacketId,
          event_count: eventCount,
          artifact_count: artifactCount,
        },
        metadata: {
          category: 'capture_session',
          source: 'capture_session_finalize',
          scenario: scenarioSlug,
          capture_session_id: sessionId,
          evidence_refs: [{ type: 'support_debug_packet', id: supportPacketId }],
        },
        idempotencyKey: `capture_session:finalize:${sessionId}:work_item_created`,
        requestId: null,
        buildSha: appBuildSha,
        redactionVersion: 'context-handoff-v1',
        occurredAt: itemCreatedAt,
      })

      for (let i = 0; i < (itemSpec.handoff_events ?? []).length; i++) {
        const ev = itemSpec.handoff_events![i]!
        await insertScenarioHandoffEvent(client, {
          companyId,
          workItemId,
          captureSessionId: sessionId,
          eventId: refUuid('context_handoff_event', `${session.ref}:handoff:${i}`),
          eventType: ev.event_type,
          actorKind: ev.actor_kind ?? 'system',
          actorUserId: ev.actor_user_id ?? null,
          actorRef: ev.actor_ref ?? null,
          sourceSystem: ev.source_system ?? 'seed-scenario',
          payload: ev.payload ?? {},
          metadata: {
            source: 'seed_scenario',
            scenario: scenarioSlug,
            ...(ev.metadata ?? {}),
          },
          idempotencyKey: ev.idempotency_key ?? `seed_scenario:${sessionId}:handoff:${i}`,
          requestId: ev.request_id ?? null,
          buildSha: ev.build_sha ?? appBuildSha,
          redactionVersion: ev.redaction_version ?? 'context-handoff-v1',
          occurredAt: resolveTimestamp(ev.occurred_at, ev.occurred_offset_minutes, -3 + i),
        })
      }
    }
  }
}

async function insertScenarioHandoffEvent(
  client: PoolClient,
  args: {
    companyId: string
    workItemId: string
    captureSessionId: string
    eventId: string
    eventType: string
    actorKind: string
    actorUserId: string | null
    actorRef: string | null
    sourceSystem: string
    payload: Record<string, unknown>
    metadata: Record<string, unknown>
    idempotencyKey: string
    requestId: string | null
    buildSha: string | null
    redactionVersion: string
    occurredAt: string
  },
): Promise<void> {
  await client.query(
    `insert into context_handoff_events (
       id, company_id, work_item_id, event_type, actor_kind, actor_user_id,
       actor_ref, source_system, payload, metadata, idempotency_key,
       request_id, capture_session_id, build_sha, redaction_version, occurred_at
     )
     values (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9::jsonb, $10::jsonb, $11,
       $12, $13::uuid, $14, $15, $16::timestamptz
     )
     on conflict (id) do nothing`,
    [
      args.eventId,
      args.companyId,
      args.workItemId,
      args.eventType,
      args.actorKind,
      args.actorUserId,
      args.actorRef,
      args.sourceSystem,
      JSON.stringify(args.payload),
      JSON.stringify(args.metadata),
      args.idempotencyKey,
      args.requestId,
      args.captureSessionId,
      args.buildSha,
      args.redactionVersion,
      args.occurredAt,
    ],
  )
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
  change_orders: Array<{ ref: string; id: string }>
  crew_schedules: Array<{ ref: string; id: string }>
  takeoff_drafts: Array<{ ref: string; id: string }>
  capture_sessions: Array<{ ref: string; id: string }>
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
    change_orders: Array.from(refs.changeOrders.entries()).map(([ref, id]) => ({ ref, id })),
    crew_schedules: Array.from(refs.crewSchedules.entries()).map(([ref, id]) => ({ ref, id })),
    takeoff_drafts: Array.from(refs.takeoffDrafts.entries()).map(([ref, id]) => ({ ref, id })),
    capture_sessions: Array.from(refs.captureSessions.entries()).map(([ref, id]) => ({ ref, id })),
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
      // Demo-oriented sections (steve-demo.yaml). All additive + idempotent;
      // run after projects/workers so their refs resolve.
      await ensureTakeoffDraftsRich(client, companyId, scenario.takeoff_drafts, refs)
      await ensureEstimateLines(client, companyId, scenario.estimate_lines, refs)
      await ensureMaterialBills(client, companyId, scenario.material_bills, refs)
      await ensureLaborEntries(client, companyId, scenario.labor_entries, refs)
      await ensureChangeOrders(client, companyId, scenario.change_orders, refs)
      await ensureCrewSchedules(client, companyId, scenario.crew_schedules, refs)
      await ensureDailyLogs(client, companyId, scenario.daily_logs, refs)
      await ensureCaptureSessions(client, companyId, scenario.capture_sessions, refs, scenario.company.slug)
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
