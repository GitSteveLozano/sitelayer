#!/usr/bin/env -S npx tsx
/**
 * Replay a workflow entity's event log against the registered reducer
 * and report any divergence between persisted snapshots and reducer
 * output. For ops use against live customer data.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/replay-workflow.ts \
 *     <workflow-name> <entity-id>
 *
 * Examples:
 *   npx tsx scripts/replay-workflow.ts rental_billing_run \
 *     11111111-1111-1111-1111-111111111111
 *   npx tsx scripts/replay-workflow.ts estimate_push \
 *     22222222-2222-2222-2222-222222222222
 *
 * The script:
 *   1. Loads workflow_event_log rows for the entity, ordered by
 *      state_version asc.
 *   2. Looks up the registered reducer by workflow_name.
 *   3. Feeds the events through applyEventLog().
 *   4. Compares the final reducer output against the live entity row
 *      (rental_billing_runs / estimate_pushes).
 *   5. Prints a diff if they disagree.
 *
 * Exit codes:
 *   0  no divergence detected
 *   1  bad arguments / config
 *   2  divergence detected (replay output differs from persisted state)
 */

import { Pool } from 'pg'
import { applyEventLog, getWorkflow, listWorkflows, type WorkflowEventLogEntry } from '@sitelayer/workflows'
// Side-effect import: pulling the whole package runs every workflow
// module's top-level registerWorkflow(), so getWorkflow() / listWorkflows()
// see ALL registered reducers — not just the handful named below. This is
// what lets the ops replay tool reach every workflow, and what makes the
// registry⊇ENTITY_TABLE conformance check (printConformanceWarnings) able
// to detect a workflow that ships without a replay mapping.
import '@sitelayer/workflows'

/**
 * Per-workflow entity-table mapping for the live-row comparison.
 *
 * `column` (snapshot field name → reducer output key) is compared against
 * `dbColumn` (the actual persisted column). Most workflows persist
 * 1:1, but several alias the column (e.g. labor_payroll_runs stores the
 * reducer's `approved_by` as `approved_by_user_id`, and project_lifecycle
 * stores everything under `lifecycle_*` on the shared `projects` table).
 * The replay diff reads `finalSnapshot[column]` and the live row value
 * SELECTed `as <column>` from `dbColumn`, so the comparison stays keyed on
 * the snapshot field regardless of the storage column name.
 *
 * `state`/`state_version` are the two universal fields: `state` maps to the
 * reducer's `state` (the persisted status/state column), `state_version`
 * to the row's version counter. Both may be aliased (project_lifecycle).
 */
interface ColumnMap {
  /** Reducer snapshot field name (key in finalSnapshot). */
  column: string
  /** Persisted DB column (SELECTed `as column`). Defaults to `column`. */
  dbColumn?: string
}

interface EntityMapping {
  table: string
  /** Persisted status/state column (compared against finalSnapshot.state). */
  stateColumn: string
  /** Persisted version column (compared against finalSnapshot.state_version). */
  stateVersionColumn: string
  /** Additional transition columns mirroring the reducer's snapshot fields. */
  columns: ColumnMap[]
}

const ENTITY_TABLE: Record<string, EntityMapping> = {
  rental_billing_run: {
    table: 'rental_billing_runs',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'approved_at' },
      { column: 'approved_by' },
      { column: 'posted_at' },
      { column: 'failed_at' },
      { column: 'error' },
      { column: 'qbo_invoice_id' },
    ],
  },
  estimate_push: {
    table: 'estimate_pushes',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'reviewed_at' },
      { column: 'reviewed_by' },
      { column: 'approved_at' },
      { column: 'approved_by' },
      { column: 'posted_at' },
      { column: 'failed_at' },
      { column: 'error' },
      { column: 'qbo_estimate_id' },
    ],
  },
  crew_schedule: {
    table: 'crew_schedules',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [{ column: 'confirmed_at' }, { column: 'confirmed_by' }],
  },
  project_closeout: {
    table: 'projects',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [{ column: 'closed_at' }, { column: 'closed_by' }],
  },
  labor_payroll_run: {
    table: 'labor_payroll_runs',
    stateColumn: 'state',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'approved_at' },
      { column: 'approved_by', dbColumn: 'approved_by_user_id' },
      { column: 'posted_at' },
      { column: 'failed_at' },
      { column: 'error', dbColumn: 'error_message' },
    ],
  },
  project_lifecycle: {
    // Same table as project_closeout, distinct lifecycle_* column set.
    // Migration 106 (workflow-scoped unique event-log key) lets both write
    // event-log rows against the same projects.id.
    table: 'projects',
    stateColumn: 'lifecycle_state',
    stateVersionColumn: 'lifecycle_state_version',
    columns: [
      { column: 'sent_at', dbColumn: 'lifecycle_sent_at' },
      { column: 'accepted_at', dbColumn: 'lifecycle_accepted_at' },
      { column: 'declined_at', dbColumn: 'lifecycle_declined_at' },
      { column: 'decline_reason', dbColumn: 'lifecycle_decline_reason' },
      { column: 'started_at', dbColumn: 'lifecycle_started_at' },
      { column: 'completed_at', dbColumn: 'lifecycle_completed_at' },
      { column: 'archived_at', dbColumn: 'lifecycle_archived_at' },
    ],
  },
  field_event: {
    table: 'worker_issues',
    stateColumn: 'state',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'resolved_at' },
      { column: 'resolved_by_user_id', dbColumn: 'resolved_by_clerk_user_id' },
      { column: 'resolved_action' },
      { column: 'resolution_message' },
      { column: 'escalated_to_estimator_at' },
      { column: 'escalation_reason' },
      { column: 'dismissed_at' },
      { column: 'dismissed_by_user_id', dbColumn: 'dismissed_by_clerk_user_id' },
      { column: 'reopened_at' },
    ],
  },
  rental: {
    table: 'rentals',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [{ column: 'returned_at' }, { column: 'returned_by' }, { column: 'closed_at' }, { column: 'closed_by' }],
  },
  daily_log: {
    table: 'daily_logs',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [{ column: 'submitted_at' }],
  },
  notification: {
    table: 'notifications',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [{ column: 'error' }],
  },
  shipment: {
    table: 'shipments',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'shipped_at' },
      { column: 'delivered_at' },
      { column: 'confirmed_by' },
      { column: 'driver' },
      { column: 'ticket_number' },
    ],
  },
  damage_charge_settlement: {
    table: 'damage_charges',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'invoiced_at' },
      { column: 'invoiced_by' },
      { column: 'waived_at' },
      { column: 'waived_by' },
      { column: 'waive_reason' },
    ],
  },
  rental_request_approval: {
    table: 'rental_requests',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'approved_at' },
      { column: 'approved_by' },
      { column: 'declined_at' },
      { column: 'declined_by' },
      { column: 'decline_reason' },
    ],
  },
  qbo_sync_run: {
    table: 'qbo_sync_runs',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'started_at' },
      { column: 'succeeded_at' },
      { column: 'failed_at' },
      { column: 'retried_at' },
      { column: 'error' },
    ],
  },
  scaffold_ops_approval: {
    table: 'boms',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'approved_at' },
      { column: 'approved_by' },
      { column: 'superseded_at' },
      { column: 'superseded_by', dbColumn: 'superseded_by_user' },
      { column: 'superseded_by_bom_id', dbColumn: 'superseded_by' },
    ],
  },
  change_order: {
    table: 'change_orders',
    stateColumn: 'status',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'sent_at' },
      { column: 'accepted_at' },
      { column: 'rejected_at' },
      { column: 'voided_at' },
      { column: 'reject_reason' },
      { column: 'approved_by' },
    ],
  },
  time_review_run: {
    table: 'time_review_runs',
    stateColumn: 'state',
    stateVersionColumn: 'state_version',
    columns: [
      { column: 'reviewer_user_id' },
      { column: 'approved_at' },
      { column: 'rejected_at' },
      { column: 'rejection_reason' },
      { column: 'reopened_at' },
    ],
  },
}

/**
 * Advisory registry⊇ENTITY_TABLE conformance check. Prints a warning to
 * stderr (does NOT change the exit code) when a registered workflow has no
 * replay mapping here, so a workflow added without a mapping is visible
 * instead of being silently un-swept. Kept advisory because some workflows
 * (e.g. ones still being wired) legitimately have no live entity table yet.
 */
function printConformanceWarnings(): void {
  const registered = new Set(listWorkflows().map((d) => d.name))
  const mapped = new Set(Object.keys(ENTITY_TABLE))
  const unmapped = [...registered].filter((n) => !mapped.has(n)).sort()
  const orphaned = [...mapped].filter((n) => !registered.has(n)).sort()
  if (unmapped.length > 0) {
    console.error(
      `[warn] ${unmapped.length} registered workflow(s) have no replay ENTITY_TABLE mapping (un-swept): ${unmapped.join(', ')}`,
    )
  }
  if (orphaned.length > 0) {
    console.error(
      `[warn] ${orphaned.length} ENTITY_TABLE entr(ies) reference an unregistered workflow: ${orphaned.join(', ')}`,
    )
  }
}

async function main(): Promise<void> {
  printConformanceWarnings()
  const [, , workflowName, entityId] = process.argv
  if (!workflowName || !entityId) {
    console.error('usage: replay-workflow.ts <workflow-name> <entity-id>')
    process.exit(1)
  }
  const def = getWorkflow(workflowName)
  if (!def) {
    console.error(`no workflow registered as "${workflowName}"`)
    console.error(`known workflows: ${Object.keys(ENTITY_TABLE).join(', ')}`)
    process.exit(1)
  }
  const entityMeta = ENTITY_TABLE[workflowName]
  if (!entityMeta) {
    console.error(`workflow "${workflowName}" is registered but no entity table mapping is configured`)
    process.exit(1)
  }
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }

  // Managed Postgres (DO) uses a self-signed cert chain. The api and
  // worker pools handle this by stripping `sslmode` from the URL and
  // passing `ssl: { rejectUnauthorized: false }`. Mirror that here so
  // ops runs against managed PG don't fail with SELF_SIGNED_CERT_IN_CHAIN.
  // Set DATABASE_SSL_REJECT_UNAUTHORIZED=true to enforce strict verification.
  const sslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true'
  const poolConfig = (() => {
    try {
      const url = new URL(databaseUrl)
      const sslMode = url.searchParams.get('sslmode')
      if (!sslRejectUnauthorized && sslMode && sslMode !== 'disable') {
        url.searchParams.delete('sslmode')
        return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } }
      }
    } catch {
      // fall through
    }
    return { connectionString: databaseUrl }
  })()
  const pool = new Pool(poolConfig)
  try {
    const eventResult = await pool.query<{
      workflow_name: string
      schema_version: number
      entity_id: string
      state_version: number
      event_type: string
      event_payload: Record<string, unknown>
      snapshot_after: Record<string, unknown>
      applied_at: string
      actor_user_id: string | null
    }>(
      `select workflow_name, schema_version, entity_id, state_version,
              event_type, event_payload, snapshot_after, applied_at, actor_user_id
       from workflow_event_log
       where workflow_name = $1 and entity_id = $2
       order by state_version asc`,
      [workflowName, entityId],
    )

    if (eventResult.rows.length === 0) {
      console.error(`no workflow_event_log rows for ${workflowName} ${entityId}`)
      process.exit(1)
    }

    const log: WorkflowEventLogEntry[] = eventResult.rows.map((r) => ({
      workflow_name: r.workflow_name,
      schema_version: r.schema_version,
      entity_id: r.entity_id,
      state_version: r.state_version,
      event_payload: r.event_payload as { type: string; [k: string]: unknown },
      snapshot_after: r.snapshot_after as { state: string; state_version: number; [k: string]: unknown },
    }))

    const initial = {
      state: def.initialState,
      state_version: log[0]!.state_version,
    }
    const result = applyEventLog(initial, log)

    console.log(`workflow:    ${workflowName}`)
    console.log(`entity:      ${entityId}`)
    console.log(`events:      ${log.length}`)
    console.log(`first event: ${log[0]!.event_payload.type} @ state_version=${log[0]!.state_version}`)
    console.log(
      `last event:  ${log[log.length - 1]!.event_payload.type} @ state_version=${log[log.length - 1]!.state_version}`,
    )

    if (!result.ok) {
      console.error('\n[FAIL] event-log replay diverged:')
      for (const issue of result.issues) {
        console.error(`  state_version=${issue.state_version} event=${issue.event_type} reason=${issue.reason}`)
        if (issue.detail) console.error(`    ${issue.detail}`)
      }
      process.exit(2)
    }

    // Compare to live row. SELECT each persisted column `as` its snapshot
    // field name so the diff stays keyed on the reducer's field regardless
    // of the storage column name (e.g. lifecycle_state as state).
    const selectExprs = [
      `${entityMeta.stateColumn} as state`,
      `${entityMeta.stateVersionColumn} as state_version`,
      ...entityMeta.columns.map((c) => `${c.dbColumn ?? c.column} as ${c.column}`),
    ]
    const liveResult = await pool.query<Record<string, unknown>>(
      `select ${selectExprs.join(', ')} from ${entityMeta.table}
       where id = $1 limit 1`,
      [entityId],
    )
    const live = liveResult.rows[0]
    if (!live) {
      console.error(`\n[FAIL] no live row in ${entityMeta.table} for id=${entityId}`)
      process.exit(2)
    }

    const final = result.finalSnapshot as Record<string, unknown> | null
    if (!final) {
      console.error('\n[FAIL] applyEventLog returned no finalSnapshot')
      process.exit(2)
    }

    const compareKeys = ['state', 'state_version', ...entityMeta.columns.map((c) => c.column)]
    const divergences: Array<{ column: string; replay: unknown; live: unknown }> = []
    for (const key of compareKeys) {
      const replayValue = final[key]
      const liveValue = live[key]
      if (!shallowEqual(replayValue, liveValue)) {
        divergences.push({ column: key, replay: replayValue, live: liveValue })
      }
    }

    if (divergences.length > 0) {
      console.error('\n[FAIL] reducer output disagrees with persisted row:')
      for (const d of divergences) {
        console.error(`  ${d.column}:`)
        console.error(`    replay: ${JSON.stringify(d.replay)}`)
        console.error(`    live:   ${JSON.stringify(d.live)}`)
      }
      process.exit(2)
    }

    console.log('\n[OK] replay matches persisted state.')
  } finally {
    await pool.end()
  }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  // Date comparison must happen BEFORE the typeof check: pg returns
  // timestamptz as a Date object, while the reducer (and event_payload)
  // emits an ISO string. Compare via toISOString in either direction.
  if (a instanceof Date) return a.toISOString() === b
  if (b instanceof Date) return a === (b as Date).toISOString()
  if (typeof a !== typeof b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
