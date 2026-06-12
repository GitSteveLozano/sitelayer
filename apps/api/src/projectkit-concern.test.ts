// projectkit emit-site conformance ratchet.
//
// THE RULE: every @operator/projectkit Concern / WorkRequest / Callback
// snapshot constructed anywhere in apps/api goes through the validated
// @sitelayer/projectkit-bridge builders (buildConcernSnapshot /
// buildWorkRequestSnapshot / buildCallbackSnapshot) — never a hand-rolled
// snapshot literal. The builders are the single place the published contract
// is enforced (they validate their own output via validateConcern /
// validateWorkRequest / validateCallback and throw on a violation), so a
// hand-rolled literal is exactly the class of drift that ships an invalid
// snapshot to a subscriber without ever failing a test.
//
// Same idiom as apps/worker/src/outbox-conformance.test.ts: source-text scan
// against the REAL tree (no DB), deliberately conservative — prose in
// comments is stripped, and the extractor guards its own sentinels so a scan
// regression fails loudly instead of passing silently.
//
// History: the previous incarnation of this file validated the (since-moved)
// local snapshot builders directly; that conformance now lives with the
// builders in packages/projectkit-bridge/src/index.test.ts. THIS file is the
// apps/api-side ratchet that keeps emit sites pointed at those builders.
//
// MERGE-TIME NOTE: a third hand-rolled emit site exists in
// routes/ops-diagnostics.ts on the sibling integration branch
// (agent/claude/audit-gap-fill). When that branch merges, this ratchet will
// fail on it — route it through buildConcernSnapshot like the two sites below.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const API_SRC = resolve(import.meta.dirname)

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) yield full
  }
}

/** Strip block + line comments so prose mentioning contract fields is not
 * flagged as a construction site (same conservatism as the outbox ratchet:
 * `https://...` inside string literals survives). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(\s)\/\/ .*$/gm, '$1')
}

type SourceFile = { rel: string; src: string }

function loadSources(): SourceFile[] {
  const files: SourceFile[] = []
  for (const file of walk(API_SRC)) {
    files.push({ rel: relative(API_SRC, file), src: stripComments(readFileSync(file, 'utf8')) })
  }
  return files
}

const SOURCES = loadSources()

/** The names whose VALUE import from @operator/projectkit marks a file as
 * assembling contract snapshots itself instead of using the bridge. Type-only
 * imports (`type Concern`) and the inbound-leg validators (agent-feed.ts
 * validates EXTERNAL executors' callbacks — consumption, not construction)
 * stay allowed. */
const BANNED_PROJECTKIT_VALUE_IMPORTS = ['CONTRACT_VERSION']

/** Snapshot-identity keys: an object literal that stamps `schema_version:`
 * within reach of one of these is a projectkit contract snapshot. (Workflow
 * snapshots elsewhere in apps/api also carry `schema_version` but never these
 * keys, so the pairing is the discriminator.) */
const SNAPSHOT_IDENTITY_KEYS = ['concern_ref', 'request_ref', 'project_key']
const WINDOW = 600

describe('projectkit emit-site conformance (apps/api)', () => {
  it('RATCHET: no hand-rolled Concern/WorkRequest/Callback snapshot literals (schema_version + identity key pairing)', () => {
    const violations: string[] = []
    for (const { rel, src } of SOURCES) {
      for (const m of src.matchAll(/schema_version\s*:/g)) {
        const start = Math.max(0, m.index! - WINDOW)
        const window = src.slice(start, m.index! + WINDOW)
        const paired = SNAPSHOT_IDENTITY_KEYS.filter((key) => window.includes(key))
        if (paired.length > 0) {
          violations.push(`${rel}: schema_version stamped near ${paired.join('/')} — hand-rolled snapshot literal`)
        }
      }
    }
    expect(
      violations,
      `hand-rolled projectkit snapshot construction in apps/api:\n  ${violations.join('\n  ')}\n` +
        `Fix: build the snapshot through @sitelayer/projectkit-bridge (buildConcernSnapshot / ` +
        `buildWorkRequestSnapshot / buildCallbackSnapshot) — extend the builder if a field is missing.`,
    ).toEqual([])
  })

  it('RATCHET: no value-import of the contract assembly constants from @operator/projectkit', () => {
    const violations: string[] = []
    for (const { rel, src } of SOURCES) {
      for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]@operator\/projectkit['"]/g)) {
        const names = m[1]!
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n.length > 0 && !n.startsWith('type '))
          .map((n) => n.split(/\s+as\s+/)[0]!.trim())
        for (const banned of BANNED_PROJECTKIT_VALUE_IMPORTS) {
          if (names.includes(banned)) {
            violations.push(`${rel}: value-imports ${banned} from @operator/projectkit`)
          }
        }
      }
    }
    expect(
      violations,
      `apps/api modules assembling contract snapshots directly:\n  ${violations.join('\n  ')}\n` +
        `Only packages/projectkit-bridge stamps CONTRACT_VERSION; emit sites call its builders.`,
    ).toEqual([])
  })

  it('RATCHET: no local re-implementation of the bridge builders', () => {
    const violations: string[] = []
    for (const { rel, src } of SOURCES) {
      for (const m of src.matchAll(/(?:function|const)\s+(build(?:Concern|WorkRequest|Callback)Snapshot)\b/g)) {
        violations.push(`${rel}: declares ${m[1]} locally — the bridge owns the builders`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('every build*Snapshot call site imports the builders from @sitelayer/projectkit-bridge', () => {
    for (const { rel, src } of SOURCES) {
      const calls = [...src.matchAll(/\bbuild(?:Concern|WorkRequest|Callback)Snapshot\s*\(/g)]
      if (calls.length === 0) continue
      expect(
        /from\s*['"]@sitelayer\/projectkit-bridge['"]/.test(src),
        `${rel} calls a snapshot builder but does not import @sitelayer/projectkit-bridge`,
      ).toBe(true)
    }
  })

  it('extractor sentinels: the known emit sites still route through the bridge', () => {
    // If a refactor moves/renames these seams, update the sentinel — the scan
    // finding NOTHING would otherwise mean the extractor regressed, not that
    // the codebase is clean (same guard as the outbox ratchet).
    const byRel = new Map(SOURCES.map((f) => [f.rel, f.src]))

    // Dispatch leg 1: capture finalize → addressed capture-analyzer Concern.
    const captureSessions = byRel.get('routes/capture-sessions.ts')
    expect(captureSessions, 'routes/capture-sessions.ts missing from scan').toBeDefined()
    expect(captureSessions!).toMatch(/buildConcernSnapshot\(/)

    // Dispatch leg 2: admin dispatch-to-agent → addressed audience Concern.
    const adminWorkRequests = byRel.get('routes/admin-work-requests.ts')
    expect(adminWorkRequests, 'routes/admin-work-requests.ts missing from scan').toBeDefined()
    expect(adminWorkRequests!).toMatch(/buildConcernSnapshot\(/)

    // Dispatch + return legs: work-request lifecycle (WorkRequest out, Callback back).
    const workRequests = byRel.get('routes/work-requests.ts')
    expect(workRequests, 'routes/work-requests.ts missing from scan').toBeDefined()
    expect(workRequests!).toMatch(/buildWorkRequestSnapshot\(/)
    expect(workRequests!).toMatch(/buildCallbackSnapshot\(/)
  })
})
