#!/usr/bin/env -S npx tsx
/**
 * Capture a live workflow entity's event log into a self-verified, replayable
 * regression fixture — "a real bug becomes a permanent replayable regression"
 * (correctness-architecture PR3).
 *
 * Reads `workflow_event_log` for one (workflow_name, entity_id), replays the
 * captured events through the registered reducer, and asserts the replay
 * reproduces the terminal state. Prints the verification verdict and a frozen
 * YAML fixture you can check in and re-run with no DB.
 *
 * The pure capture/verify logic lives in `@sitelayer/workflows`
 * (`captureScenarioFromLog` / `captureScenarioToYaml`) and is unit-tested
 * without a database (packages/workflows/src/capture-scenario.test.ts). This
 * script is the thin DB wrapper, mirroring scripts/replay-workflow.ts.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/capture-to-scenario.ts \
 *     <workflow-name> <entity-id> [--out scenarios/captured-<name>.yaml]
 *
 * Example:
 *   DATABASE_URL=... npx tsx scripts/capture-to-scenario.ts rental_billing_run \
 *     11111111-1111-1111-1111-111111111111 --out /tmp/rbr.captured.yaml
 *
 * Exit codes:
 *   0  captured + verified reproducible
 *   1  bad arguments / config / no log rows
 *   2  captured but NOT reproducible (replay diverged or terminal mismatch)
 *
 * NOTE (deferred, by design): this captures the WORKFLOW EVENT SEQUENCE only —
 * enough to self-verify and re-drive the reducer to the exact terminal. It does
 * NOT walk FK dependencies (company/project/customer) or anonymize PII out of
 * payloads. That dependency-walk + anonymizer is the deferred piece; for full
 * throwaway-DB seeding, nest the emitted events under the right scenario entity
 * collection and run scripts/seed-scenario.ts. Treat captured payloads as the
 * same untrusted, possibly-PII-bearing blobs the source rows are.
 */

import { writeFileSync } from 'node:fs'
import { Pool } from 'pg'
import {
  captureScenarioFromLog,
  captureScenarioToYaml,
  getWorkflow,
  type WorkflowEventLogEntry,
} from '@sitelayer/workflows'
// Side-effect import: registers every workflow so getWorkflow() / the replay
// inside captureScenarioFromLog() see ALL reducers, not just a named subset.
import '@sitelayer/workflows'

function poolConfigFor(databaseUrl: string) {
  // Mirror api/worker/replay-workflow: DO managed PG uses a self-signed chain.
  const sslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true'
  try {
    const url = new URL(databaseUrl)
    const sslMode = url.searchParams.get('sslmode')
    if (!sslRejectUnauthorized && sslMode && sslMode !== 'disable') {
      url.searchParams.delete('sslmode')
      return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } }
    }
  } catch {
    // fall through to plain connection string
  }
  return { connectionString: databaseUrl }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined
  const positional = args.filter((a, i) => a !== '--out' && i !== outIdx + 1)
  const [workflowName, entityId] = positional

  if (!workflowName || !entityId) {
    console.error('usage: capture-to-scenario.ts <workflow-name> <entity-id> [--out <file>]')
    process.exit(1)
  }
  if (outIdx >= 0 && !outPath) {
    console.error('--out requires a file path')
    process.exit(1)
  }
  if (!getWorkflow(workflowName)) {
    console.error(`no workflow registered as "${workflowName}"`)
    process.exit(1)
  }
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }

  const pool = new Pool(poolConfigFor(databaseUrl))
  try {
    const eventResult = await pool.query<{
      workflow_name: string
      schema_version: number
      entity_id: string
      state_version: number
      event_type: string
      event_payload: Record<string, unknown>
      snapshot_after: Record<string, unknown>
    }>(
      `select workflow_name, schema_version, entity_id, state_version,
              event_type, event_payload, snapshot_after
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

    const captured = captureScenarioFromLog(log)
    const yaml = captureScenarioToYaml(captured)

    console.error(`workflow:    ${captured.workflow}`)
    console.error(`entity:      ${captured.entityId}`)
    console.error(`events:      ${captured.events.length}`)
    console.error(`terminal:    replayed=${captured.replayedState} logged=${captured.loggedState}`)
    console.error(
      `verified:    ${captured.verification.ok ? 'OK — reproducible' : 'NOT REPRODUCIBLE'} ` +
        `(replayClean=${captured.verification.replayClean}, terminalMatches=${captured.verification.terminalMatches})`,
    )
    for (const issue of captured.verification.issues) console.error(`  ! ${issue}`)

    if (outPath) {
      writeFileSync(outPath, yaml)
      console.error(`wrote fixture: ${outPath}`)
    } else {
      // Fixture to stdout so it can be redirected; diagnostics went to stderr.
      process.stdout.write(yaml)
    }

    process.exit(captured.verification.ok ? 0 : 2)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
