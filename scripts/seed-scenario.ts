#!/usr/bin/env -S npx tsx
/**
 * YAML-driven fixture builder (thin CLI).
 *
 * Reads a single scenario YAML — a tenant plus its projects, members,
 * inventory, rentals, and deterministic-workflow event sequences — and stamps
 * the DB in one idempotent transaction.
 *
 * The doc→DB engine now lives in `@sitelayer/scenario` (schema + planner +
 * applier). This file is only the CLI shell: it loads tier config, refuses to
 * run against prod, opens a pooled connection, and wraps `applyScenario` in a
 * single BEGIN/COMMIT. The scenario contract is the Zod `ScenarioDoc` schema in
 * `packages/scenario/src/schema.ts`; working examples live in `scenarios/*.yaml`
 * (e.g. `mid-flight-rental.yaml`, `steve-demo.yaml`).
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     npx tsx scripts/seed-scenario.ts scenarios/mid-flight-rental.yaml
 *
 * Behaviour:
 *   - Refuses to run when APP_TIER=prod (scenarios are a dev/demo concept).
 *   - All inserts use ON CONFLICT DO NOTHING + ref-hashed UUIDs, so re-running
 *     the same YAML produces the same final state.
 *   - Workflow event sequences are walked through `applyEventSequence` from
 *     `@sitelayer/workflows`, so `workflow_event_log` rows match what
 *     `scripts/replay-workflow.ts` verifies in production.
 *   - Prints a JSON summary `{company_id, projects, ...}` so CI / shell can
 *     grep for the materialized ids.
 *
 * Exit codes:
 *   0  success (idempotent)
 *   1  bad arguments / config / scenario parse failure
 *   2  DB error during seeding
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { applyScenario, parseScenario, type SeedSummary } from '@sitelayer/scenario'
import { loadAppConfig, TierConfigError, type AppTier } from '../apps/api/src/tier.js'
import { seedCompanyDefaults } from '../apps/api/src/onboarding.js'

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

// ---------- Main ----------

export async function seedScenario(scenarioPath: string): Promise<SeedSummary> {
  const config = loadAppConfig()
  if (config.tier === 'prod') {
    throw new TierConfigError('seed-scenario refuses to run when APP_TIER=prod')
  }

  const doc = parseScenario(readFileSync(scenarioPath, 'utf-8'))

  const pool = new Pool(getPoolConfig(config.databaseUrl, config.tier))
  try {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const summary = await applyScenario(client, doc, { seedCompanyDefaults })
      await client.query('commit')
      return summary
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
      // Zod validation failure = a malformed scenario doc (parse failure).
      if (err instanceof Error && err.name === 'ZodError') {
        process.stderr.write(`[seed-scenario] invalid scenario: ${err.message}\n`)
        process.exit(1)
      }
      process.stderr.write(
        `[seed-scenario] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      )
      process.exit(2)
    })
}
