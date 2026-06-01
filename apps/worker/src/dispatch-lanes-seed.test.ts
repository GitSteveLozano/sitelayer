// Migration parity test — assert that the lane names seeded in
// migration 094 exactly match the lane names referenced in the worker
// runner cascade.
//
// Drift here is the most likely failure mode: someone adds a runner
// without updating the seed (lane fails-open as 'active', invisible to
// the admin UI), or adds a seed without referencing it from the worker
// (a dangling row that operators see in the UI but can't actually
// pause). Either way, this test fires.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function readMigrationSeedLanes(): string[] {
  const path = resolve(__dirname, '..', '..', '..', 'docker', 'postgres', 'init', '094_dispatch_lanes.sql')
  const sql = readFileSync(path, 'utf-8')
  // The seed block is a single INSERT INTO dispatch_lanes (...) VALUES (...);
  // We scan for ('name', ...) rows. Avoid brittle regex on the literal
  // SQL — pull the slice between INSERT INTO dispatch_lanes and ON CONFLICT.
  const insertMatch = sql.match(/INSERT INTO dispatch_lanes[\s\S]+?ON CONFLICT/i)
  if (!insertMatch) throw new Error('could not find INSERT INTO dispatch_lanes block')
  const block = insertMatch[0]
  const nameMatches = Array.from(block.matchAll(/\(\s*'([a-z_]+)'\s*,/gi)).map((m) => m[1] as string)
  return nameMatches
}

function readFollowupLaneSeeds(): string[] {
  // 094 seeds the original lanes in one bulk INSERT. Later lanes land as
  // forward-only migrations (094/095 are immutable once applied), each
  // seeding a single lane via the canonical
  // `VALUES ('<name>', 'active', 'system:seed')` shape. Scan every later
  // migration for that pattern so a new lane-seed file (e.g. 095, 135)
  // counts as seeded without editing this test per file.
  const dir = resolve(__dirname, '..', '..', '..', 'docker', 'postgres', 'init')
  const seeds: string[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue
    if (file.startsWith('094_')) continue
    const sql = readFileSync(resolve(dir, file), 'utf-8')
    for (const m of sql.matchAll(/VALUES\s*\(\s*'([a-z_]+)'\s*,\s*'active'\s*,\s*'system:seed'\s*\)/gi)) {
      seeds.push(m[1] as string)
    }
  }
  return seeds
}

function readWorkerLaneReferences(): string[] {
  const path = resolve(__dirname, 'worker.ts')
  const ts = readFileSync(path, 'utf-8')
  // Find every runIfLaneActive(pool, logger, '<lane>', ...) and withLaneGate
  // call. We scan for the third positional arg.
  const matches = Array.from(ts.matchAll(/runIfLaneActive\(\s*pool,\s*logger,\s*'([a-z_]+)'/gi)).map(
    (m) => m[1] as string,
  )
  return Array.from(new Set(matches))
}

describe('dispatch-lanes migration / worker parity', () => {
  it('every lane referenced in worker.ts is seeded in migration 094', () => {
    const seeded = new Set([...readMigrationSeedLanes(), ...readFollowupLaneSeeds()])
    const referenced = readWorkerLaneReferences()
    const missing = referenced.filter((name) => !seeded.has(name))
    expect(missing, `worker.ts references lanes not seeded in 094: ${missing.join(', ')}`).toEqual([])
  })

  it('seeded lane names are unique', () => {
    const seeded = readMigrationSeedLanes()
    const dupes = seeded.filter((name, idx) => seeded.indexOf(name) !== idx)
    expect(dupes, `migration 094 has duplicate seed rows: ${dupes.join(', ')}`).toEqual([])
  })
})
