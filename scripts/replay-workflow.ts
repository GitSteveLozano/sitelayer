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
import {
  applyEventLog,
  getWorkflow,
  type WorkflowEventLogEntry,
  // Importing workflow modules ensures their registerWorkflow() side
  // effects run so getWorkflow() can find them.
  rentalBillingWorkflow as _rentalBillingWorkflow,
  estimatePushWorkflow as _estimatePushWorkflow,
} from '@sitelayer/workflows'

void _rentalBillingWorkflow
void _estimatePushWorkflow

const ENTITY_TABLE: Record<string, { table: string; columns: string[] }> = {
  rental_billing_run: {
    table: 'rental_billing_runs',
    columns: [
      'status',
      'state_version',
      'approved_at',
      'approved_by',
      'posted_at',
      'failed_at',
      'error',
      'qbo_invoice_id',
    ],
  },
  estimate_push: {
    table: 'estimate_pushes',
    columns: [
      'status',
      'state_version',
      'reviewed_at',
      'reviewed_by',
      'approved_at',
      'approved_by',
      'posted_at',
      'failed_at',
      'error',
      'qbo_estimate_id',
    ],
  },
}

async function main(): Promise<void> {
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

    // Compare to live row.
    const liveResult = await pool.query<Record<string, unknown>>(
      `select ${entityMeta.columns.join(', ')} from ${entityMeta.table}
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

    const divergences: Array<{ column: string; replay: unknown; live: unknown }> = []
    for (const col of entityMeta.columns) {
      const replayValue = col === 'status' ? final.state : final[col]
      const liveValue = live[col]
      if (!shallowEqual(replayValue, liveValue)) {
        divergences.push({ column: col, replay: replayValue, live: liveValue })
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
