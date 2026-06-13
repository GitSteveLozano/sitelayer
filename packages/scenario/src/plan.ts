import { parse as parseYaml } from 'yaml'
import { getWorkflow, type ApplyEventSequenceArgs } from '@sitelayer/workflows'
import { buildGeometry, type GeometryInput, type GeometryKind } from './geometry-fixtures.js'
import { refUuid } from './ids.js'
import { ScenarioDoc } from './schema.js'

/**
 * Pure scenario engine.
 *
 * `parseScenario(yaml)` validates a doc; `planScenario(doc, { companyId, now })`
 * resolves every fixture + timeline into an ordered, side-effect-free list of
 * `ApplyOp`s; `applyScenario` (see ./apply.ts) runs them against a client in one
 * tx. The plan is a 1:1 lift of the imperative seeders that used to live in
 * `scripts/seed-scenario.ts` — same SQL text, same bound values, same order —
 * so a re-seed materialises byte-identical rows.
 *
 * Two ops are not plain SQL:
 *   - `event_log` carries `ApplyEventSequenceArgs` and is applied via the SAME
 *     `applyEventSequence` production paths use, so `workflow_event_log` rows are
 *     identical. The matching entity-row stamp is emitted as a `query` op whose
 *     values come from a plan-time reducer fold (`replaySnapshot`) — the same
 *     pure `(snapshot, event) → snapshot` the reducer would compute at apply.
 *   - `company_defaults` is the one apply-time dependency on `apps/api`
 *     (`seedCompanyDefaults`), injected by the caller (see ApplyContext) so this
 *     package never imports `apps/*`.
 *
 * Time: the imperative seeders called `new Date()` at several points to keep
 * "today" rows live. Those are funnelled through a single injected `now` so a
 * plan is fully deterministic for a fixed `(doc, companyId, now)` — which is
 * what the golden tests assert. DB-clock `now()` calls inside SQL (audit
 * timestamps, outbox intervals) are left as SQL and are intentionally NOT part
 * of the determinism contract.
 */

/** A scenario event payload — loosely typed; each reducer validates its own. */
export type ScenarioEvent = Record<string, unknown> & { type: string }
type Snapshot = Record<string, unknown> & { state: string; state_version: number }

export type ApplyOp =
  | { kind: 'query'; label: string; text: string; values: unknown[] }
  | { kind: 'event_log'; label: string; args: ApplyEventSequenceArgs<ScenarioEvent> }
  | { kind: 'company_defaults'; label: string; companyId: string }
  /**
   * Run the DETERMINISTIC dry-run blueprint-vision capture at apply time and
   * UPDATE the draft's `takeoff_result_json` with its real output (SIM-2). The
   * capture fn is injected via ApplyContext so this package never imports
   * `@sitelayer/pipe-blueprint` (which pulls the Anthropic SDK) — mirroring how
   * `company_defaults` injects `seedCompanyDefaults`. Emitted only when a
   * takeoff draft declares `run_capture: { blueprint_vision, dry-run }`.
   */
  | { kind: 'dry_run_capture'; label: string; companyId: string; draftId: string; projectId: string }

export interface PlanContext {
  /** The resolved `companies.id` (DB-generated; obtained by the caller before
   *  planning — see `ensureCompanyRow` in ./apply.ts). */
  companyId: string
  /** Single clock instant for all relative-time resolution. Defaults to
   *  `new Date()`; tests pass a fixed value for deterministic golden plans. */
  now?: Date
}

export interface SeedSummary {
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

export interface ScenarioPlan {
  /** The resolved company id the ops are bound to. */
  companyId: string
  /** Ordered operations; run them in one tx (see applyScenario). */
  ops: ApplyOp[]
  /** Deterministically-resolved ref → id maps, ready to return as the CLI summary. */
  summary: SeedSummary
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
  blueprintDocuments: Map<string, string>
  blueprintPages: Map<string, string>
  takeoffConditions: Map<string, string>
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
    blueprintDocuments: new Map(),
    blueprintPages: new Map(),
    takeoffConditions: new Map(),
  }
}

// ---------- Plan builder ----------

interface Builder {
  ops: ApplyOp[]
  refs: RefMaps
  companyId: string
  now: Date
}

function q(b: Builder, label: string, text: string, values: unknown[]): void {
  b.ops.push({ kind: 'query', label, text, values })
}

// ---------- Pure reducer fold (mirrors applyEventSequence's reduce loop) ----------

/**
 * Fold a sequence of events through the registered reducer WITHOUT writing the
 * event log — used at plan time to compute the final snapshot for the entity
 * stamp. `applyEventSequence` performs the identical fold at apply time (and
 * writes the log), so the stamp always agrees with the persisted log.
 */
function replaySnapshot(workflowName: string, initial: Snapshot, events: readonly ScenarioEvent[]): Snapshot {
  const definition = getWorkflow(workflowName)
  if (!definition) {
    throw new Error(`planScenario: no workflow registered for ${workflowName}`)
  }
  let snapshot: Snapshot = initial
  for (const event of events) {
    snapshot = definition.reduce(snapshot as never, event as never) as Snapshot
  }
  return snapshot
}

function eventLogOp(
  b: Builder,
  label: string,
  workflowName: string,
  entityType: string,
  entityId: string,
  events: readonly ScenarioEvent[],
): void {
  const initial: Snapshot = entityInitialState(workflowName)
  b.ops.push({
    kind: 'event_log',
    label,
    args: {
      workflowName,
      entityType,
      entityId,
      companyId: b.companyId,
      initialSnapshot: initial,
      events,
    },
  })
}

// Initial snapshots per workflow — copied from the per-section seeders.
function entityInitialState(workflowName: string): Snapshot {
  switch (workflowName) {
    case 'rental_billing_run':
      return { state: 'generated', state_version: 1 }
    case 'estimate_push':
      return { state: 'drafted', state_version: 1 }
    case 'field_event':
      return { state: 'open', state_version: 1 }
    case 'damage_charge_settlement':
      return { state: 'open', state_version: 1 }
    case 'rental_request_approval':
      return { state: 'pending', state_version: 1 }
    case 'qbo_sync_run':
      return { state: 'pending', state_version: 1 }
    case 'scaffold_ops_approval':
      return { state: 'draft', state_version: 1 }
    case 'change_order':
      return { state: 'draft', state_version: 1 }
    default:
      throw new Error(`planScenario: no initial state defined for workflow ${workflowName}`)
  }
}

// ---------- Time resolution (now is injected, not new Date()) ----------

function resolveDate(now: Date, literal: string | undefined, offsetDays: number | undefined): string {
  if (literal) return literal
  const offset = offsetDays ?? 0
  const d = new Date(now.getTime())
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

function resolveTimestamp(
  now: Date,
  literal: string | undefined,
  offsetMinutes: number | undefined,
  fallbackOffsetMinutes: number,
): string {
  if (literal) return literal
  const d = new Date(now.getTime())
  d.setUTCMinutes(d.getUTCMinutes() + (offsetMinutes ?? fallbackOffsetMinutes))
  return d.toISOString()
}

function resolveOptionalTimestamp(
  now: Date,
  literal: string | undefined,
  offsetMinutes: number | undefined,
): string | null {
  if (literal) return literal
  if (offsetMinutes === undefined) return null
  const d = new Date(now.getTime())
  d.setUTCMinutes(d.getUTCMinutes() + offsetMinutes)
  return d.toISOString()
}

function resolveRetentionTimestamp(
  now: Date,
  literal: string | undefined,
  offsetDays: number | undefined,
): string | null {
  if (literal) return literal
  if (offsetDays === undefined) return null
  const d = new Date(now.getTime())
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString()
}

// ---------- Ref resolution ----------

function mustResolve(scope: string, ref: string, map: Map<string, string>): string {
  const id = map.get(ref)
  if (!id) {
    throw new Error(`scenario references unknown ${scope}: "${ref}" — define it before the section that uses it`)
  }
  return id
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

// ---------- Section planners ----------

function planMemberships(b: Builder, members: ScenarioDoc['members']): void {
  if (!members) return
  for (const m of members) {
    q(
      b,
      `membership:${m.clerk_user_id}`,
      `insert into company_memberships (company_id, clerk_user_id, role)
       values ($1, $2, $3)
       on conflict (company_id, clerk_user_id) do nothing`,
      [b.companyId, m.clerk_user_id, m.role],
    )
  }
}

function planCustomers(b: Builder, customers: ScenarioDoc['customers']): void {
  if (!customers) return
  for (const c of customers) {
    const id = refUuid('customer', c.ref)
    b.refs.customers.set(c.ref, id)
    q(
      b,
      `customer:${c.ref}`,
      `insert into customers (id, company_id, name, source)
       values ($1, $2, $3, 'seed')
       on conflict (id) do nothing`,
      [id, b.companyId, c.name],
    )
  }
}

function planWorkers(b: Builder, workers: ScenarioDoc['workers']): void {
  if (!workers) return
  for (const w of workers) {
    const id = refUuid('worker', w.ref)
    b.refs.workers.set(w.ref, id)
    q(
      b,
      `worker:${w.ref}`,
      `insert into workers (id, company_id, name, role)
       values ($1, $2, $3, $4)
       on conflict (id) do nothing`,
      [id, b.companyId, w.name, w.role ?? 'crew'],
    )
  }
}

function planInventory(b: Builder, inventory: ScenarioDoc['inventory']): void {
  if (!inventory) return
  for (const item of inventory) {
    const id = refUuid('inventory', item.ref)
    b.refs.inventory.set(item.ref, id)
    q(
      b,
      `inventory:${item.ref}`,
      `insert into inventory_items
         (id, company_id, code, description, category, unit, default_rental_rate, replacement_value, tracking_mode, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
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

function planProjects(b: Builder, projects: ScenarioDoc['projects']): void {
  if (!projects) return
  for (const p of projects) {
    const id = refUuid('project', p.ref)
    b.refs.projects.set(p.ref, id)
    const customerId = p.customer_ref ? (b.refs.customers.get(p.customer_ref) ?? null) : null
    const customerName = p.customer_name ?? p.customer_ref ?? 'Direct'
    q(
      b,
      `project:${p.ref}`,
      `insert into projects
         (id, company_id, customer_id, customer_name, name, division_code, status,
          bid_total, labor_rate, target_sqft_per_hr, bonus_pool,
          lifecycle_state, lifecycle_state_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
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

function planRentals(b: Builder, rentals: ScenarioDoc['rentals']): void {
  if (!rentals) return
  for (const r of rentals) {
    const projectId = mustResolve('project', r.project_ref, b.refs.projects)
    const inventoryId = mustResolve('inventory', r.inventory_ref, b.refs.inventory)
    const customerId = r.customer_ref ? (b.refs.customers.get(r.customer_ref) ?? null) : null
    const contractId = refUuid('rental_contract', r.ref)
    const billingRunId = refUuid('rental_billing_run', r.ref)
    b.refs.rentalContracts.set(r.ref, contractId)
    b.refs.rentalBillingRuns.set(r.ref, billingRunId)

    const billingStart = r.billing_start_date ?? '2026-01-01'
    const periodStart = r.period_start ?? billingStart
    const periodEnd = r.period_end ?? '2026-01-25'

    q(
      b,
      `rental_contract:${r.ref}`,
      `insert into job_rental_contracts
         (id, company_id, project_id, customer_id, billing_cycle_days, billing_mode,
          billing_start_date, next_billing_date, status, notes)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, 'active', 'seed-scenario contract')
       on conflict (id) do nothing`,
      [
        contractId,
        b.companyId,
        projectId,
        customerId,
        r.billing_cycle_days ?? 25,
        r.billing_mode ?? 'arrears',
        billingStart,
        periodEnd,
      ],
    )

    q(
      b,
      `rental_line:${r.ref}`,
      `insert into job_rental_lines
         (id, company_id, contract_id, inventory_item_id, quantity, agreed_rate, rate_unit, on_rent_date, status, billable, taxable)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date, 'active', true, true)
       on conflict (id) do nothing`,
      [
        refUuid('rental_line', r.ref),
        b.companyId,
        contractId,
        inventoryId,
        r.quantity,
        r.agreed_rate ?? 0,
        r.rate_unit ?? 'cycle',
        r.on_rent_date ?? billingStart,
      ],
    )

    q(
      b,
      `rental_billing_run:${r.ref}`,
      `insert into rental_billing_runs
         (id, company_id, contract_id, project_id, customer_id,
          period_start, period_end, status, state_version, subtotal)
       values ($1, $2, $3, $4, $5, $6::date, $7::date, 'generated', 1, $8)
       on conflict (id) do nothing`,
      [billingRunId, b.companyId, contractId, projectId, customerId, periodStart, periodEnd, r.subtotal ?? 0],
    )

    if (r.billing_event_log && r.billing_event_log.length > 0) {
      const events = r.billing_event_log as ScenarioEvent[]
      eventLogOp(
        b,
        `rental_billing_run:events:${r.ref}`,
        'rental_billing_run',
        'rental_billing_run',
        billingRunId,
        events,
      )
      const final = replaySnapshot('rental_billing_run', entityInitialState('rental_billing_run'), events)
      q(
        b,
        `rental_billing_run:stamp:${r.ref}`,
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
          b.companyId,
        ],
      )

      if (final.state === 'posting') {
        const idempotencyKey = `rental_billing_run:post:${billingRunId}`
        q(
          b,
          `rental_billing_run:outbox:${r.ref}`,
          `insert into mutation_outbox
             (company_id, entity_type, entity_id, mutation_type, payload, idempotency_key, status, next_attempt_at)
           values ($1, 'rental_billing_run', $2, 'post_qbo_invoice', $3::jsonb, $4, 'pending', now() + ($5 || ' minutes')::interval)
           on conflict (company_id, idempotency_key) do nothing`,
          [
            b.companyId,
            billingRunId,
            JSON.stringify({ rental_billing_run_id: billingRunId }),
            idempotencyKey,
            String(r.outbox_next_attempt_offset_minutes ?? 0),
          ],
        )
      }
    }
  }
}

function planEstimates(b: Builder, estimates: ScenarioDoc['estimates']): void {
  if (!estimates) return
  for (const e of estimates) {
    const projectId = mustResolve('project', e.project_ref, b.refs.projects)
    const customerId = e.customer_ref ? (b.refs.customers.get(e.customer_ref) ?? null) : null
    const pushId = refUuid('estimate_push', e.ref)
    b.refs.estimates.set(e.ref, pushId)

    q(
      b,
      `estimate_push:${e.ref}`,
      `insert into estimate_pushes
         (id, company_id, project_id, customer_id, status, state_version, subtotal)
       values ($1, $2, $3, $4, 'drafted', 1, $5)
       on conflict (id) do nothing`,
      [pushId, b.companyId, projectId, customerId, e.subtotal ?? 0],
    )

    if (e.push_event_log && e.push_event_log.length > 0) {
      const events = e.push_event_log as ScenarioEvent[]
      eventLogOp(b, `estimate_push:events:${e.ref}`, 'estimate_push', 'estimate_push', pushId, events)
      const final = replaySnapshot('estimate_push', entityInitialState('estimate_push'), events)
      q(
        b,
        `estimate_push:stamp:${e.ref}`,
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
          b.companyId,
        ],
      )
    }
  }
}

function planWorkerIssues(b: Builder, issues: ScenarioDoc['worker_issues']): void {
  if (!issues) return
  for (const issue of issues) {
    const id = refUuid('worker_issue', issue.ref)
    b.refs.workerIssues.set(issue.ref, id)
    const projectId = issue.project_ref ? (b.refs.projects.get(issue.project_ref) ?? null) : null
    const workerId = issue.worker_ref ? (b.refs.workers.get(issue.worker_ref) ?? null) : null
    const createdOffset = issue.created_offset_minutes ?? 0

    q(
      b,
      `worker_issue:${issue.ref}`,
      `insert into worker_issues
         (id, company_id, project_id, worker_id, reporter_clerk_user_id,
          kind, message, severity, state_version, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, now() + ($9 || ' minutes')::interval)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
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
      const events = issue.issue_event_log as ScenarioEvent[]
      eventLogOp(b, `worker_issue:events:${issue.ref}`, 'field_event', 'worker_issue', id, events)
      const final = replaySnapshot('field_event', entityInitialState('field_event'), events)
      q(
        b,
        `worker_issue:stamp:${issue.ref}`,
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
          b.companyId,
        ],
      )
    }
  }
}

function planClockEvents(b: Builder, clockEvents: ScenarioDoc['clock_events']): void {
  if (!clockEvents) return
  for (let i = 0; i < clockEvents.length; i++) {
    const ev = clockEvents[i]!
    const workerId = ev.worker_ref ? (b.refs.workers.get(ev.worker_ref) ?? null) : null
    const projectId = ev.project_ref ? (b.refs.projects.get(ev.project_ref) ?? null) : null
    let occurredAt = ev.occurred_at
    if (!occurredAt) {
      const d = new Date(b.now.getTime())
      d.setUTCMinutes(d.getUTCMinutes() + (ev.occurred_at_offset_minutes ?? 0))
      occurredAt = d.toISOString()
    }
    const idKey = ev.occurred_at ? occurredAt : occurredAt.slice(0, 10)
    const id = refUuid('clock_event', `${ev.worker_ref ?? '-'}|${ev.project_ref ?? '-'}|${idKey}|${ev.event_type}|${i}`)
    q(
      b,
      `clock_event:${i}`,
      `insert into clock_events
         (id, company_id, worker_id, project_id, clerk_user_id, event_type, occurred_at, inside_geofence)
       values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
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

// ---------- Blueprints + calibrated pages ----------

function planBlueprints(b: Builder, blueprints: ScenarioDoc['blueprints']): void {
  if (!blueprints) return
  for (const bp of blueprints) {
    const projectId = mustResolve('project', bp.project_ref, b.refs.projects)
    const documentId = refUuid('blueprint_document', bp.ref)
    b.refs.blueprintDocuments.set(bp.ref, documentId)
    const fileName = bp.file_name ?? `${bp.ref}.pdf`
    // Opaque deterministic placeholder (matches the prod `<companyId>/<id>/<file>` shape).
    const storagePath = `${b.companyId}/${documentId}/${fileName}`

    q(
      b,
      `blueprint_document:${bp.ref}`,
      `insert into blueprint_documents
         (id, company_id, project_id, file_name, storage_path, preview_type, version)
       values ($1, $2, $3, $4, $5, $6, 1)
       on conflict (id) do nothing`,
      [documentId, b.companyId, projectId, fileName, storagePath, bp.preview_type ?? 'storage_path'],
    )

    for (let i = 0; i < bp.pages.length; i++) {
      const page = bp.pages[i]!
      const pageId = refUuid('blueprint_page', page.ref)
      b.refs.blueprintPages.set(page.ref, pageId)
      const cal = page.calibration
      const calibrationSetAt = cal ? b.now.toISOString() : null
      const scaleVerifiedAt = cal?.verified ? b.now.toISOString() : null
      q(
        b,
        `blueprint_page:${page.ref}`,
        `insert into blueprint_pages
           (id, company_id, blueprint_document_id, page_number, storage_path,
            calibration_world_distance, calibration_world_unit,
            calibration_x1, calibration_y1, calibration_x2, calibration_y2,
            calibration_set_at, calibration_set_by, scale_verified_at, scale_verified_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14::timestamptz, $15)
         on conflict (id) do nothing`,
        [
          pageId,
          b.companyId,
          documentId,
          page.page_number ?? i + 1,
          page.storage_path ?? null,
          cal?.world_distance ?? null,
          cal?.world_unit ?? null,
          cal?.x1 ?? null,
          cal?.y1 ?? null,
          cal?.x2 ?? null,
          cal?.y2 ?? null,
          calibrationSetAt,
          cal ? 'seed-scenario' : null,
          scaleVerifiedAt,
          cal?.verified ? 'seed-scenario' : null,
        ],
      )
    }
  }
}

// ---------- Takeoff conditions (typed templates) ----------

function planTakeoffConditions(b: Builder, conditions: ScenarioDoc['takeoff_conditions']): void {
  if (!conditions) return
  for (const c of conditions) {
    const id = refUuid('takeoff_condition', c.ref)
    b.refs.takeoffConditions.set(c.ref, id)
    const kind = c.measurement_kind ?? 'area'
    const defaultAssemblyId = c.default_assembly_ref ? refUuid('assembly', c.default_assembly_ref) : null
    q(
      b,
      `takeoff_condition:${c.ref}`,
      `insert into takeoff_conditions
         (id, company_id, name, color, measurement_kind,
          height_value, thickness_value, sides, slope_value, default_assembly_id,
          emit_linear, emit_area, emit_volume, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
        c.name,
        c.color ?? '#2f7d32',
        kind,
        c.height_value ?? null,
        c.thickness_value ?? null,
        c.sides ?? null,
        c.slope_value ?? null,
        defaultAssemblyId,
        c.emit_linear ?? kind === 'linear',
        c.emit_area ?? kind === 'area',
        c.emit_volume ?? kind === 'volume',
        c.created_by ?? null,
      ],
    )
  }
}

// ---------- Measurement geometry/extra-column resolution ----------

const GEOMETRY_DEFAULT_KIND: Record<GeometryKind, GeometryKind> = {
  polygon: 'polygon',
  lineal: 'lineal',
  count: 'count',
  volume: 'volume',
}

/** Fields a measurement may carry beyond the legacy
 *  (service_item_code, quantity, unit) trio. Shared by both measurement
 *  sections so geometry/page/condition handling stays identical. */
interface MeasurementExtras {
  geometry_kind?: GeometryKind | undefined
  geometry?: GeometryInput | undefined
  page_ref?: string | undefined
  blueprint_ref?: string | undefined
  condition_ref?: string | undefined
  is_deduction?: boolean | undefined
  elevation?: string | undefined
  unit_canonical?: string | undefined
  division_code?: string | undefined
}

interface ResolvedMeasurementExtras {
  /** True when ANY renderable/extra field was supplied — gates the wide insert. */
  enriched: boolean
  geometryJson: string | null
  geometryKind: string | null
  pageId: string | null
  blueprintId: string | null
  conditionId: string | null
  isDeduction: boolean | null
  elevation: string | null
  unitCanonical: string | null
  divisionCode: string | null
}

function resolveMeasurementExtras(b: Builder, m: MeasurementExtras): ResolvedMeasurementExtras {
  const hasAny =
    m.geometry !== undefined ||
    m.geometry_kind !== undefined ||
    m.page_ref !== undefined ||
    m.blueprint_ref !== undefined ||
    m.condition_ref !== undefined ||
    m.is_deduction !== undefined ||
    m.elevation !== undefined ||
    m.unit_canonical !== undefined ||
    m.division_code !== undefined

  if (!hasAny) {
    return {
      enriched: false,
      geometryJson: null,
      geometryKind: null,
      pageId: null,
      blueprintId: null,
      conditionId: null,
      isDeduction: null,
      elevation: null,
      unitCanonical: null,
      divisionCode: null,
    }
  }

  let geometryJson: string | null = null
  let geometryKind: string | null = m.geometry_kind ?? null
  if (m.geometry !== undefined) {
    const kind = m.geometry.kind ?? m.geometry_kind ?? 'polygon'
    const geometry = buildGeometry({ ...m.geometry, kind: GEOMETRY_DEFAULT_KIND[kind] })
    geometryJson = JSON.stringify(geometry)
    geometryKind = geometry.kind
  }

  const pageId = m.page_ref ? mustResolve('blueprint_page', m.page_ref, b.refs.blueprintPages) : null
  const blueprintId = m.blueprint_ref
    ? mustResolve('blueprint_document', m.blueprint_ref, b.refs.blueprintDocuments)
    : null
  const conditionId = m.condition_ref
    ? mustResolve('takeoff_condition', m.condition_ref, b.refs.takeoffConditions)
    : null

  return {
    enriched: true,
    geometryJson,
    geometryKind,
    pageId,
    blueprintId,
    conditionId,
    isDeduction: m.is_deduction ?? null,
    elevation: m.elevation ?? null,
    unitCanonical: m.unit_canonical ?? null,
    divisionCode: m.division_code ?? null,
  }
}

function planTakeoffMeasurements(b: Builder, spec: ScenarioDoc['takeoff_measurements']): void {
  if (!spec) return
  const projectId = mustResolve('project', spec.project_ref, b.refs.projects)
  const draftId = refUuid('takeoff_draft', `${spec.project_ref}:bulk`)
  q(
    b,
    `takeoff_measurements:draft:${spec.project_ref}`,
    `insert into takeoff_drafts
       (id, company_id, project_id, name, status)
     values ($1, $2, $3, 'scenario-bulk', 'active')
     on conflict (id) do nothing`,
    [draftId, b.companyId, projectId],
  )
  const code = spec.service_item_code ?? 'EPS'
  const unit = spec.unit ?? 'sqft'

  const extras = resolveMeasurementExtras(b, spec)

  const valueClauses: string[] = []
  const values: unknown[] = []
  if (!extras.enriched) {
    // Legacy narrow path — byte-identical to the original 7-column insert.
    for (let i = 0; i < spec.count; i++) {
      const id = refUuid('takeoff_measurement', `${spec.project_ref}:bulk:${i}`)
      const qv = 100 + (i % 50)
      const idx = valueClauses.length * 7
      valueClauses.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`)
      values.push(id, b.companyId, projectId, draftId, code, qv, unit)
    }
    if (valueClauses.length > 0) {
      q(
        b,
        `takeoff_measurements:bulk:${spec.project_ref}`,
        `insert into takeoff_measurements
         (id, company_id, project_id, draft_id, service_item_code, quantity, unit)
       values ${valueClauses.join(', ')}
       on conflict (id) do nothing`,
        values,
      )
    }
    return
  }

  // Wide path — every bulk row carries the spec's shared geometry + columns.
  const cols = 16
  for (let i = 0; i < spec.count; i++) {
    const id = refUuid('takeoff_measurement', `${spec.project_ref}:bulk:${i}`)
    const qv = 100 + (i % 50)
    const idx = valueClauses.length * cols
    valueClauses.push(
      `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, ` +
        `coalesce($${idx + 8}::jsonb, '{}'::jsonb), $${idx + 9}, $${idx + 10}, $${idx + 11}, $${idx + 12}, ` +
        `$${idx + 13}, $${idx + 14}, $${idx + 15}, $${idx + 16})`,
    )
    values.push(
      id,
      b.companyId,
      projectId,
      draftId,
      code,
      qv,
      unit,
      extras.geometryJson,
      extras.geometryKind ?? 'polygon',
      extras.pageId,
      extras.blueprintId,
      extras.conditionId,
      extras.isDeduction ?? false,
      extras.elevation,
      extras.unitCanonical,
      extras.divisionCode,
    )
  }
  if (valueClauses.length > 0) {
    q(
      b,
      `takeoff_measurements:bulk:${spec.project_ref}`,
      `insert into takeoff_measurements
         (id, company_id, project_id, draft_id, service_item_code, quantity, unit,
          geometry, geometry_kind, page_id, blueprint_document_id, condition_id,
          is_deduction, elevation, unit_canonical, division_code)
       values ${valueClauses.join(', ')}
       on conflict (id) do nothing`,
      values,
    )
  }
}

function planDamageCharges(b: Builder, charges: ScenarioDoc['damage_charges']): void {
  if (!charges) return
  for (const c of charges) {
    const id = refUuid('damage_charge', c.ref)
    b.refs.damageCharges.set(c.ref, id)
    const projectId = mustResolve('project', c.project_ref, b.refs.projects)
    const customerId = c.customer_ref ? (b.refs.customers.get(c.customer_ref) ?? null) : null
    const kind = c.kind ?? 'damage'
    const quantity = c.quantity ?? 1
    const unitAmount = c.unit_amount ?? 0
    const totalAmount = c.total_amount ?? quantity * unitAmount

    q(
      b,
      `damage_charge:${c.ref}`,
      `insert into damage_charges
         (id, company_id, project_id, customer_id, kind, quantity, unit_amount, total_amount,
          description, status, state_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', 1)
       on conflict (id) do nothing`,
      [id, b.companyId, projectId, customerId, kind, quantity, unitAmount, totalAmount, c.description],
    )

    if (c.settlement_event_log && c.settlement_event_log.length > 0) {
      const events = c.settlement_event_log as ScenarioEvent[]
      eventLogOp(b, `damage_charge:events:${c.ref}`, 'damage_charge_settlement', 'damage_charge', id, events)
      const final = replaySnapshot('damage_charge_settlement', entityInitialState('damage_charge_settlement'), events)
      q(
        b,
        `damage_charge:stamp:${c.ref}`,
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
          b.companyId,
        ],
      )
    }
  }
}

function planRentalRequests(b: Builder, requests: ScenarioDoc['rental_requests']): void {
  if (!requests) return
  for (const r of requests) {
    const id = refUuid('rental_request', r.ref)
    b.refs.rentalRequests.set(r.ref, id)
    const customerId = r.customer_ref ? (b.refs.customers.get(r.customer_ref) ?? null) : null

    q(
      b,
      `rental_request:${r.ref}`,
      `insert into rental_requests
         (id, company_id, customer_id, items, requested_start, requested_end,
          contact_name, contact_email, contact_phone, notes, status, state_version)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, 'pending', 1)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
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
      const events = r.approval_event_log as ScenarioEvent[]
      eventLogOp(b, `rental_request:events:${r.ref}`, 'rental_request_approval', 'rental_request', id, events)
      const final = replaySnapshot('rental_request_approval', entityInitialState('rental_request_approval'), events)
      q(
        b,
        `rental_request:stamp:${r.ref}`,
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
          b.companyId,
        ],
      )
    }
  }
}

function planQboSyncRuns(b: Builder, runs: ScenarioDoc['qbo_sync_runs']): void {
  if (!runs) return
  for (const r of runs) {
    const id = refUuid('qbo_sync_run', r.ref)
    b.refs.qboSyncRuns.set(r.ref, id)
    const provider = r.provider ?? 'qbo'

    const connectionId = refUuid('integration_connection', `${provider}:${r.ref}`)
    q(
      b,
      `integration_connection:${r.ref}`,
      `insert into integration_connections (id, company_id, provider, status)
       values ($1, $2, $3, 'connecting')
       on conflict (id) do nothing`,
      [connectionId, b.companyId, provider],
    )

    q(
      b,
      `qbo_sync_run:${r.ref}`,
      `insert into qbo_sync_runs
         (id, company_id, integration_connection_id, status, state_version, triggered_by)
       values ($1, $2, $3, 'pending', 1, $4)
       on conflict (id) do nothing`,
      [id, b.companyId, connectionId, r.triggered_by ?? null],
    )

    if (r.sync_event_log && r.sync_event_log.length > 0) {
      const events = r.sync_event_log as ScenarioEvent[]
      eventLogOp(b, `qbo_sync_run:events:${r.ref}`, 'qbo_sync_run', 'qbo_sync_run', id, events)
      const final = replaySnapshot('qbo_sync_run', entityInitialState('qbo_sync_run'), events)
      q(
        b,
        `qbo_sync_run:stamp:${r.ref}`,
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
          b.companyId,
        ],
      )
    }
  }
}

function planBoms(b: Builder, boms: ScenarioDoc['boms']): void {
  if (!boms) return
  for (const bom of boms) {
    const id = refUuid('bom', bom.ref)
    b.refs.boms.set(bom.ref, id)
    const projectId = mustResolve('project', bom.project_ref, b.refs.projects)

    q(
      b,
      `bom:${bom.ref}`,
      `insert into boms
         (id, company_id, project_id, source, source_ref, name, notes,
          status, state_version, total_weight_kg, total_lines)
       values ($1, $2, $3, $4, $5, $6, $7, 'draft', 1, $8, $9)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
        projectId,
        bom.source ?? 'manual',
        bom.source_ref ?? null,
        bom.name,
        bom.notes ?? null,
        bom.total_weight_kg ?? 0,
        bom.total_lines ?? 0,
      ],
    )

    if (bom.approval_event_log && bom.approval_event_log.length > 0) {
      const events = bom.approval_event_log as ScenarioEvent[]
      eventLogOp(b, `bom:events:${bom.ref}`, 'scaffold_ops_approval', 'bom', id, events)
      const final = replaySnapshot('scaffold_ops_approval', entityInitialState('scaffold_ops_approval'), events)
      q(
        b,
        `bom:stamp:${bom.ref}`,
        `update boms
           set status = $1,
               state_version = $2,
               approved_at = $3,
               approved_by = $4,
               updated_at = now()
         where id = $5 and company_id = $6`,
        [final.state, final.state_version, final.approved_at ?? null, final.approved_by ?? null, id, b.companyId],
      )
    }
  }
}

function planTakeoffDraftsRich(b: Builder, drafts: ScenarioDoc['takeoff_drafts']): void {
  if (!drafts) return
  for (const d of drafts) {
    const projectId = mustResolve('project', d.project_ref, b.refs.projects)
    const draftId = refUuid('takeoff_draft', d.ref)
    b.refs.takeoffDrafts.set(d.ref, draftId)
    // A `run_capture` directive means the engine fills `result_json` from the
    // deterministic dry-run AT APPLY TIME (see the dry_run_capture op below), so
    // the insert defaults to a blueprint_vision review draft and leaves
    // result_json NULL for the apply step to populate with the stub's real
    // output (any hand-authored result_json is ignored when run_capture is set).
    const hasRunCapture = d.run_capture !== undefined
    const source = d.source ?? (hasRunCapture ? 'blueprint_vision' : 'manual')
    const reviewRequired = d.review_required ?? (hasRunCapture ? true : false)
    q(
      b,
      `takeoff_draft:${d.ref}`,
      `insert into takeoff_drafts
         (id, company_id, project_id, name, type, status, source, kind, review_required, takeoff_result_json)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       on conflict (id) do nothing`,
      [
        draftId,
        b.companyId,
        projectId,
        d.name,
        d.type ?? 'measurement',
        d.status ?? 'active',
        source,
        d.kind ?? 'takeoff',
        reviewRequired,
        !hasRunCapture && d.result_json ? JSON.stringify(d.result_json) : null,
      ],
    )

    if (hasRunCapture) {
      b.ops.push({
        kind: 'dry_run_capture',
        label: `takeoff_draft:run_capture:${d.ref}`,
        companyId: b.companyId,
        draftId,
        projectId,
      })
    }

    if (d.measurements && d.measurements.length > 0) {
      for (let i = 0; i < d.measurements.length; i++) {
        const m = d.measurements[i]!
        const id = refUuid('takeoff_measurement', `${d.ref}:${i}`)
        const extras = resolveMeasurementExtras(b, m)
        if (!extras.enriched) {
          // Legacy narrow path — byte-identical to the original 7-column insert.
          q(
            b,
            `takeoff_draft:measurement:${d.ref}:${i}`,
            `insert into takeoff_measurements
             (id, company_id, project_id, draft_id, service_item_code, quantity, unit)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (id) do nothing`,
            [id, b.companyId, projectId, draftId, m.service_item_code, m.quantity, m.unit ?? 'sqft'],
          )
          continue
        }
        q(
          b,
          `takeoff_draft:measurement:${d.ref}:${i}`,
          `insert into takeoff_measurements
             (id, company_id, project_id, draft_id, service_item_code, quantity, unit,
              geometry, geometry_kind, page_id, blueprint_document_id, condition_id,
              is_deduction, elevation, unit_canonical, division_code)
           values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), $9, $10, $11, $12, $13, $14, $15, $16)
           on conflict (id) do nothing`,
          [
            id,
            b.companyId,
            projectId,
            draftId,
            m.service_item_code,
            m.quantity,
            m.unit ?? 'sqft',
            extras.geometryJson,
            extras.geometryKind ?? 'polygon',
            extras.pageId,
            extras.blueprintId,
            extras.conditionId,
            extras.isDeduction ?? false,
            extras.elevation,
            extras.unitCanonical,
            extras.divisionCode,
          ],
        )
      }
    }
  }
}

function resolveProjectDefaultDraft(
  b: Builder,
  projectRef: string,
  projectId: string,
  draftCache: Map<string, string>,
): string {
  const cached = draftCache.get(projectRef)
  if (cached) return cached
  const draftId = refUuid('takeoff_draft', `${projectRef}:default`)
  q(
    b,
    `takeoff_draft:default:${projectRef}`,
    `insert into takeoff_drafts (id, company_id, project_id, name, type, status, source, kind)
     values ($1, $2, $3, 'Default', 'measurement', 'active', 'manual', 'takeoff')
     on conflict (id) do nothing`,
    [draftId, b.companyId, projectId],
  )
  draftCache.set(projectRef, draftId)
  return draftId
}

function planEstimateLines(b: Builder, lines: ScenarioDoc['estimate_lines']): void {
  if (!lines) return
  const draftCache = new Map<string, string>()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const projectId = mustResolve('project', l.project_ref, b.refs.projects)
    const draftId = resolveProjectDefaultDraft(b, l.project_ref, projectId, draftCache)
    const id = refUuid('estimate_line', `${l.project_ref}:${i}`)
    const quantity = l.quantity ?? 0
    const rate = l.rate ?? 0
    const amount = l.amount ?? quantity * rate
    q(
      b,
      `estimate_line:${l.project_ref}:${i}`,
      `insert into estimate_lines
         (id, company_id, project_id, draft_id, service_item_code, quantity, unit, rate, amount)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do nothing`,
      [id, b.companyId, projectId, draftId, l.service_item_code, quantity, l.unit ?? 'sqft', rate, amount],
    )
  }
}

function planMaterialBills(b: Builder, bills: ScenarioDoc['material_bills']): void {
  if (!bills) return
  for (let i = 0; i < bills.length; i++) {
    const bill = bills[i]!
    const projectId = mustResolve('project', bill.project_ref, b.refs.projects)
    const id = refUuid('material_bill', `${bill.project_ref}:${i}`)
    const occurredOn = resolveDate(b.now, bill.occurred_on, bill.occurred_on_offset_days)
    q(
      b,
      `material_bill:${bill.project_ref}:${i}`,
      `insert into material_bills
         (id, company_id, project_id, vendor_name, amount, bill_type, description, occurred_on)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
        projectId,
        bill.vendor_name,
        bill.amount,
        bill.bill_type ?? 'material',
        bill.description ?? null,
        occurredOn,
      ],
    )
  }
}

function planLaborEntries(b: Builder, entries: ScenarioDoc['labor_entries']): void {
  if (!entries) return
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const projectId = mustResolve('project', e.project_ref, b.refs.projects)
    const workerId = e.worker_ref ? (b.refs.workers.get(e.worker_ref) ?? null) : null
    const occurredOn = resolveDate(b.now, e.occurred_on, e.occurred_on_offset_days)
    const id = refUuid(
      'labor_entry',
      `${e.project_ref}:${e.worker_ref ?? '-'}:${e.service_item_code}:${occurredOn}:${i}`,
    )
    q(
      b,
      `labor_entry:${e.project_ref}:${i}`,
      `insert into labor_entries
         (id, company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
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

function planChangeOrders(b: Builder, orders: ScenarioDoc['change_orders']): void {
  if (!orders) return
  for (const co of orders) {
    const id = refUuid('change_order', co.ref)
    b.refs.changeOrders.set(co.ref, id)
    const projectId = mustResolve('project', co.project_ref, b.refs.projects)
    q(
      b,
      `change_order:${co.ref}`,
      `insert into change_orders
         (id, company_id, project_id, number, description, value_delta, schedule_impact_days,
          status, state_version, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'draft', 1, $8)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
        projectId,
        co.number,
        co.description ?? '',
        co.value_delta,
        co.schedule_impact_days ?? 0,
        co.created_by ?? null,
      ],
    )

    if (co.co_event_log && co.co_event_log.length > 0) {
      const events = co.co_event_log as ScenarioEvent[]
      eventLogOp(b, `change_order:events:${co.ref}`, 'change_order', 'change_order', id, events)
      const final = replaySnapshot('change_order', entityInitialState('change_order'), events)
      q(
        b,
        `change_order:stamp:${co.ref}`,
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
          b.companyId,
        ],
      )
    }
  }
}

function planCrewSchedules(b: Builder, schedules: ScenarioDoc['crew_schedules']): void {
  if (!schedules) return
  for (const s of schedules) {
    const projectId = mustResolve('project', s.project_ref, b.refs.projects)
    const scheduledFor = resolveDate(b.now, s.scheduled_for, s.scheduled_for_offset_days)
    const id = refUuid('crew_schedule', `${s.ref}:${scheduledFor}`)
    b.refs.crewSchedules.set(s.ref, id)
    const crew = (s.crew ?? []).map((c) => ({
      worker_id: c.worker_ref ? (b.refs.workers.get(c.worker_ref) ?? null) : null,
      name: c.name ?? c.worker_ref ?? null,
      clerk_user_id: c.clerk_user_id ?? null,
    }))
    const status = s.status ?? 'confirmed'
    const isConfirmed = status === 'confirmed'
    q(
      b,
      `crew_schedule:${s.ref}`,
      `insert into crew_schedules
         (id, company_id, project_id, scheduled_for, crew, status, version, state_version,
          confirmed_at, confirmed_by, created_by)
       values ($1, $2, $3, $4::date, $5::jsonb, $6, 1, $7, $8, $9, $10)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
        projectId,
        scheduledFor,
        JSON.stringify(crew),
        status,
        isConfirmed ? 2 : 1,
        isConfirmed ? b.now.toISOString() : null,
        isConfirmed ? (s.confirmed_by ?? null) : null,
        s.confirmed_by ?? null,
      ],
    )
  }
}

function planDailyLogs(b: Builder, logs: ScenarioDoc['daily_logs']): void {
  if (!logs) return
  for (const log of logs) {
    const projectId = mustResolve('project', log.project_ref, b.refs.projects)
    const occurredOn = resolveDate(b.now, log.occurred_on, log.occurred_on_offset_days)
    const id = refUuid('daily_log', log.ref ?? `${log.project_ref}:${log.foreman_user_id}:${occurredOn}`)
    const status = log.status ?? 'draft'
    const isSubmitted = status === 'submitted'
    q(
      b,
      `daily_log:${log.ref ?? `${log.project_ref}:${occurredOn}`}`,
      `insert into daily_logs
         (id, company_id, project_id, occurred_on, foreman_user_id, scope_progress, notes,
          status, submitted_at, state_version)
       values ($1, $2, $3, $4::date, $5, $6::jsonb, $7, $8, $9, $10)
       on conflict (id) do nothing`,
      [
        id,
        b.companyId,
        projectId,
        occurredOn,
        log.foreman_user_id,
        JSON.stringify(log.scope_progress ?? []),
        log.notes ?? null,
        status,
        isSubmitted ? b.now.toISOString() : null,
        isSubmitted ? 2 : 1,
      ],
    )
  }
}

// ---------- Capture sessions → support packet → context work ----------

function planCaptureSessions(b: Builder, sessions: ScenarioDoc['capture_sessions'], scenarioSlug: string): void {
  if (!sessions) return
  for (const session of sessions) {
    const sessionId = refUuid('capture_session', session.ref)
    b.refs.captureSessions.set(session.ref, sessionId)
    const actorUserId = session.actor_user_id ?? 'scenario-seed'
    const mode = session.mode ?? 'feedback'
    const status = session.status ?? 'stopped'
    const startedAt = resolveTimestamp(b.now, session.started_at, session.started_offset_minutes, -20)
    const stoppedAt =
      status === 'stopped' || status === 'failed' || status === 'redacted'
        ? resolveTimestamp(b.now, session.stopped_at, session.stopped_offset_minutes, -5)
        : resolveOptionalTimestamp(b.now, session.stopped_at, session.stopped_offset_minutes)
    const discardedAt =
      status === 'discarded'
        ? resolveTimestamp(b.now, session.discarded_at, session.discarded_offset_minutes, -5)
        : resolveOptionalTimestamp(b.now, session.discarded_at, session.discarded_offset_minutes)
    const retentionExpiresAt = resolveRetentionTimestamp(
      b.now,
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

    q(
      b,
      `capture_session:${session.ref}`,
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
        b.companyId,
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
      const occurredAt = resolveTimestamp(b.now, ev.occurred_at, ev.occurred_offset_minutes, -20 + i)
      q(
        b,
        `capture_session_event:${session.ref}:${i}`,
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
          b.companyId,
          sessionId,
          ev.seq ?? i,
          ev.client_event_id ?? `${session.ref}:${i}`,
          ev.event_type,
          ev.event_class ?? 'scenario',
          ev.route_path ?? routePath,
          ev.workflow_id ?? null,
          ev.entity_type ?? null,
          resolveEntityId(b.refs, ev.entity_type, ev.entity_id, ev.entity_ref),
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
      const createdAt = resolveTimestamp(b.now, artifact.created_at, artifact.created_offset_minutes, -10 + i)
      const artifactRetention =
        resolveRetentionTimestamp(b.now, artifact.retention_expires_at, artifact.retention_offset_days ?? undefined) ??
        retentionExpiresAt
      q(
        b,
        `capture_artifact:${artifactRef}`,
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
          b.companyId,
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
      planCaptureWorkItem(b, session, sessionId, scenarioSlug, {
        actorUserId,
        mode,
        status,
        routePath,
        appBuildSha,
        consentVersion,
        consentAuthority,
        retentionExpiresAt,
      })
    }
  }
}

interface CaptureSessionDerived {
  actorUserId: string
  mode: string
  status: string
  routePath: string | null
  appBuildSha: string
  consentVersion: string
  consentAuthority: string | null
  retentionExpiresAt: string | null
}

function planCaptureWorkItem(
  b: Builder,
  session: NonNullable<ScenarioDoc['capture_sessions']>[number],
  sessionId: string,
  scenarioSlug: string,
  d: CaptureSessionDerived,
): void {
  const itemSpec = session.work_item!
  const eventCount = session.events?.length ?? 0
  const artifactCount = session.artifacts?.length ?? 0
  const supportPacketId = refUuid('support_debug_packet', itemSpec.support_packet_ref ?? `${session.ref}:packet`)
  const workItemId = refUuid('context_work_item', itemSpec.ref ?? `${session.ref}:work-item`)
  const itemRoute = itemSpec.route ?? d.routePath
  const itemCreatedAt = resolveTimestamp(b.now, itemSpec.created_at, itemSpec.created_offset_minutes, -4)
  const itemCreatedBy = itemSpec.created_by_user_id ?? d.actorUserId
  const entityType = itemSpec.entity_type ?? null
  const entityId = resolveEntityId(b.refs, itemSpec.entity_type, itemSpec.entity_id, itemSpec.entity_ref)
  const summary =
    itemSpec.summary ??
    `Seeded capture session ${sessionId} finalized from ${d.mode} mode with ${eventCount} event(s) and ${artifactCount} artifact(s).`

  q(
    b,
    `support_debug_packet:${session.ref}`,
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
      b.companyId,
      itemCreatedBy,
      itemRoute,
      sessionId,
      d.appBuildSha,
      summary,
      JSON.stringify({
        source: 'seed_scenario',
        scenario: scenarioSlug,
        capture_session_id: sessionId,
        capture_session: {
          id: sessionId,
          mode: d.mode,
          status: d.status,
          route_path: d.routePath,
          event_count: eventCount,
          artifact_count: artifactCount,
          consent_version: d.consentVersion,
          consent_authority: d.consentAuthority,
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
      d.retentionExpiresAt,
    ],
  )

  q(
    b,
    `context_work_item:${session.ref}`,
    `insert into context_work_items (
       id, company_id, support_packet_id, domain, title, summary, status, lane,
       severity, route, capture_session_id, entity_type, entity_id,
       assignee_user_id, created_by_user_id, created_at, updated_at,
       resolved_at, metadata, reversibility_window_seconds
     )
     values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11::uuid, $12, $13,
       $14, $15, $16::timestamptz, $16::timestamptz,
       $17::timestamptz, $18::jsonb, $19
     )
     on conflict (id) do nothing`,
    [
      workItemId,
      b.companyId,
      supportPacketId,
      // Capture-born work items are app feedback, so they always land on the
      // app_issue board — never field_request (mirrors the live finalize path
      // in apps/api/src/routes/capture-sessions.ts; migration 009 defaults the
      // column to field_request, so omitting it here would seed the wrong board).
      'app_issue',
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
        support_packet_expires_at: d.retentionExpiresAt,
        event_count: eventCount,
        artifact_count: artifactCount,
        private_artifact_count: (session.artifacts ?? []).filter((a) =>
          ['private', 'restricted'].includes(a.pii_level ?? ''),
        ).length,
      }),
      itemSpec.reversibility_window_seconds ?? 86400,
    ],
  )

  planScenarioHandoffEvent(b, {
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
    buildSha: d.appBuildSha,
    redactionVersion: 'context-handoff-v1',
    occurredAt: itemCreatedAt,
  })

  for (let i = 0; i < (itemSpec.handoff_events ?? []).length; i++) {
    const ev = itemSpec.handoff_events![i]!
    planScenarioHandoffEvent(b, {
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
      buildSha: ev.build_sha ?? d.appBuildSha,
      redactionVersion: ev.redaction_version ?? 'context-handoff-v1',
      occurredAt: resolveTimestamp(b.now, ev.occurred_at, ev.occurred_offset_minutes, -3 + i),
    })
  }
}

interface ScenarioHandoffEventArgs {
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
}

function planScenarioHandoffEvent(b: Builder, args: ScenarioHandoffEventArgs): void {
  q(
    b,
    `context_handoff_event:${args.eventId}`,
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
      b.companyId,
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

// ---------- Summary ----------

function summarize(doc: ScenarioDoc, companyId: string, refs: RefMaps): SeedSummary {
  return {
    company_id: companyId,
    company_slug: doc.company.slug,
    customers: mapEntries(refs.customers),
    workers: mapEntries(refs.workers),
    inventory: mapEntries(refs.inventory),
    projects: mapEntries(refs.projects),
    rentals: Array.from(refs.rentalContracts.entries()).map(([ref, contract_id]) => ({
      ref,
      contract_id,
      billing_run_id: refs.rentalBillingRuns.get(ref) ?? '',
    })),
    estimates: mapEntries(refs.estimates),
    worker_issues: mapEntries(refs.workerIssues),
    damage_charges: mapEntries(refs.damageCharges),
    rental_requests: mapEntries(refs.rentalRequests),
    qbo_sync_runs: mapEntries(refs.qboSyncRuns),
    boms: mapEntries(refs.boms),
    change_orders: mapEntries(refs.changeOrders),
    crew_schedules: mapEntries(refs.crewSchedules),
    takeoff_drafts: mapEntries(refs.takeoffDrafts),
    capture_sessions: mapEntries(refs.captureSessions),
  }
}

function mapEntries(map: Map<string, string>): Array<{ ref: string; id: string }> {
  return Array.from(map.entries()).map(([ref, id]) => ({ ref, id }))
}

// ---------- Public surface ----------

/** Validate + parse YAML text into a typed scenario doc. Throws `ZodError` on
 *  a malformed doc. */
export function parseScenario(yamlText: string): ScenarioDoc {
  const raw = parseYaml(yamlText)
  return ScenarioDoc.parse(raw)
}

/**
 * Resolve a validated doc into an ordered, side-effect-free apply plan.
 *
 * `companyId` is required because `companies.id` is DB-generated; the caller
 * upserts the company row first (see `ensureCompanyRow` in ./apply.ts), then
 * plans the rest with the resolved id. This keeps the plan fully baked + pure.
 *
 * The op order is identical to the legacy `seedScenario` sequence:
 * memberships → company defaults → customers → workers → inventory → projects →
 * rentals → estimates → worker_issues → clock_events → blueprints →
 * takeoff_conditions → takeoff_measurements → damage_charges → rental_requests →
 * qbo_sync_runs → boms → takeoff_drafts → estimate_lines → material_bills →
 * labor_entries → change_orders → crew_schedules → daily_logs →
 * capture_sessions. (`blueprints`/`takeoff_conditions` are additive sections
 * slotted before measurements so `page_id`/`condition_id` refs resolve; a doc
 * that omits them produces a byte-identical plan to before.)
 */
export function planScenario(doc: ScenarioDoc, ctx: PlanContext): ScenarioPlan {
  const b: Builder = {
    ops: [],
    refs: newRefMaps(),
    companyId: ctx.companyId,
    now: ctx.now ?? new Date(),
  }

  planMemberships(b, doc.members)
  b.ops.push({ kind: 'company_defaults', label: 'company_defaults', companyId: b.companyId })
  planCustomers(b, doc.customers)
  planWorkers(b, doc.workers)
  planInventory(b, doc.inventory)
  planProjects(b, doc.projects)
  planRentals(b, doc.rentals)
  planEstimates(b, doc.estimates)
  planWorkerIssues(b, doc.worker_issues)
  planClockEvents(b, doc.clock_events)
  // Renderable-takeoff substrate — blueprints + pages + conditions must be
  // planned before any measurement that references them (page_id / condition_id).
  planBlueprints(b, doc.blueprints)
  planTakeoffConditions(b, doc.takeoff_conditions)
  planTakeoffMeasurements(b, doc.takeoff_measurements)
  planDamageCharges(b, doc.damage_charges)
  planRentalRequests(b, doc.rental_requests)
  planQboSyncRuns(b, doc.qbo_sync_runs)
  planBoms(b, doc.boms)
  // Demo-oriented sections (steve-demo.yaml) — additive + idempotent.
  planTakeoffDraftsRich(b, doc.takeoff_drafts)
  planEstimateLines(b, doc.estimate_lines)
  planMaterialBills(b, doc.material_bills)
  planLaborEntries(b, doc.labor_entries)
  planChangeOrders(b, doc.change_orders)
  planCrewSchedules(b, doc.crew_schedules)
  planDailyLogs(b, doc.daily_logs)
  planCaptureSessions(b, doc.capture_sessions, doc.company.slug)

  return {
    companyId: b.companyId,
    ops: b.ops,
    summary: summarize(doc, b.companyId, b.refs),
  }
}
