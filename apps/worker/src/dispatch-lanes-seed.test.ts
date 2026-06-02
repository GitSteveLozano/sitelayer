// Migration parity test — assert that the dispatch-lane names SEEDED in the
// database schema exactly cover the lane names referenced in the worker runner
// cascade.
//
// Drift here is the most likely failure mode: someone adds a runner without
// updating the seed (lane fails-open as 'active', invisible to the admin UI), or
// adds a seed without referencing it from the worker (a dangling row operators
// see in the UI but can't actually pause). Either way, this test fires.
//
// History note: lanes were originally seeded by migration 094_dispatch_lanes.sql
// (+ later per-lane migrations like 095/135). After the migration baseline squash
// those files were folded into docker/postgres/init/000_baseline.sql, where the
// seed rows appear as pg_dump --inserts statements. This test reads the baseline
// AND scans any post-baseline migration files, so it keeps working across the
// squash and as new lanes land as forward migrations.

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const INIT_DIR = resolve(__dirname, '..', '..', '..', 'docker', 'postgres', 'init')
const BASELINE = '000_baseline.sql'

function readBaselineSeedLanes(): string[] {
  // The squashed baseline carries seed rows as one INSERT per row in pg_dump
  // form: `INSERT INTO public.dispatch_lanes VALUES ('<name>', 'active', ...)`.
  // The lane name is the first positional value.
  const path = resolve(INIT_DIR, BASELINE)
  if (!existsSync(path)) return []
  const sql = readFileSync(path, 'utf-8')
  return Array.from(sql.matchAll(/INSERT INTO (?:public\.)?dispatch_lanes VALUES \(\s*'([a-z_]+)'/gi)).map(
    (m) => m[1] as string,
  )
}

function readFollowupLaneSeeds(): string[] {
  // Lanes added AFTER the baseline land as forward-only migrations, each seeding
  // a single lane via the canonical `VALUES ('<name>', 'active', 'system:seed')`
  // shape. Scan every non-baseline migration for that pattern so a new lane-seed
  // file counts as seeded without editing this test per file. (If a future
  // squash also folds these in, they reappear in the baseline reader above.)
  const seeds: string[] = []
  for (const file of readdirSync(INIT_DIR)) {
    if (!file.endsWith('.sql')) continue
    if (file === BASELINE) continue
    const sql = readFileSync(resolve(INIT_DIR, file), 'utf-8')
    for (const m of sql.matchAll(/VALUES\s*\(\s*'([a-z_]+)'\s*,\s*'active'\s*,\s*'system:seed'\s*\)/gi)) {
      seeds.push(m[1] as string)
    }
  }
  return seeds
}

function readWorkerLaneReferences(): string[] {
  const path = resolve(__dirname, 'worker.ts')
  const ts = readFileSync(path, 'utf-8')
  // Find every runIfLaneActive(pool, logger, '<lane>', ...) call (third arg).
  const matches = Array.from(ts.matchAll(/runIfLaneActive\(\s*pool,\s*logger,\s*'([a-z_]+)'/gi)).map(
    (m) => m[1] as string,
  )
  return Array.from(new Set(matches))
}

describe('dispatch-lanes seed / worker parity', () => {
  it('every lane referenced in worker.ts is seeded (baseline + later migrations)', () => {
    const baseline = readBaselineSeedLanes()
    expect(baseline.length, 'no dispatch_lanes seed rows found in 000_baseline.sql').toBeGreaterThan(0)
    const seeded = new Set([...baseline, ...readFollowupLaneSeeds()])
    const referenced = readWorkerLaneReferences()
    const missing = referenced.filter((name) => !seeded.has(name))
    expect(missing, `worker.ts references lanes not seeded: ${missing.join(', ')}`).toEqual([])
  })

  it('seeded lane names are unique', () => {
    const seeded = [...readBaselineSeedLanes(), ...readFollowupLaneSeeds()]
    const dupes = seeded.filter((name, idx) => seeded.indexOf(name) !== idx)
    expect(dupes, `duplicate dispatch_lanes seed rows: ${dupes.join(', ')}`).toEqual([])
  })
})
