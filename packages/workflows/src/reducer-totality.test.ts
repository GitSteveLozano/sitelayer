// Reducer totality ratchet (2026-06-13 correctness-architecture PR1).
//
// Every workflow reducer must be TOTAL over its event union: an event type
// that isn't a member of the union must be REJECTED (throw), never silently
// misrouted into a catch-all branch that mutates state. Before this ratchet,
// 11 of 20 reducers ended with an unguarded final branch (`// VOID` / `// CLOSE`
// / `// REOPEN` with no `if (event.type === …)` guard), so adding a new event
// type to the union would compile and silently route the new event into the old
// last branch — the "undefined behavior we aren't seeing" class.
//
// The fix is the exhaustiveness tail (`const exhaustive: never = event; throw`)
// or a `default:` case with the same. `tsc` is the PRIMARY enforcement: with the
// tail in place, adding an event-union member without a branch is a compile
// error. This test is the runtime backstop and the anti-regression ratchet:
//
//   1. STATIC  — every source module that registers a workflow contains a
//                `: never` totality assignment. Catches "someone deleted the
//                tail" even if the union didn't grow.
//   2. BEHAVIORAL — every registered reducer throws on an unknown event type
//                from every one of its states. Catches a re-introduced unguarded
//                catch-all (which would silently accept a bogus event from any
//                state its allow-list covers) regardless of the source text.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import './index.js' // side-effect: every workflow module self-registers
import { listWorkflows } from './registry.js'

const SRC_DIR = import.meta.dirname

describe('reducer totality ratchet', () => {
  it('every module that registers a workflow has a `: never` totality guard', () => {
    const sources = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    const offenders: string[] = []
    for (const file of sources) {
      const text = readFileSync(resolve(SRC_DIR, file), 'utf8')
      // A reducer module CALLS registerWorkflow<…>; registry.ts DEFINES it.
      if (!text.includes('registerWorkflow<')) continue // not a reducer module
      if (text.includes('function registerWorkflow')) continue // the registry itself
      if (!/:\s*never\s*=/.test(text)) offenders.push(file)
    }
    expect(
      offenders,
      `These reducer modules register a workflow but lack a \`: never\` exhaustiveness ` +
        `tail (see change-order.ts for the canonical pattern): ${offenders.join(', ')}. ` +
        `Wrap the final branch in an explicit \`if (event.type === …)\` / \`case\` and add ` +
        `\`const exhaustive: never = event; throw …\` so a future event-union member can't ` +
        `silently misroute into the old catch-all.`,
    ).toEqual([])
  })

  it('every registered reducer throws on an unknown event from every state', () => {
    const UNKNOWN = { type: '__totality_probe_unknown_event__' }
    const survivors: string[] = []
    for (const def of listWorkflows()) {
      for (const state of def.allStates) {
        const snapshot = { state, state_version: 1 }
        let threw = false
        try {
          // Cast through unknown: the probe event is deliberately not a member
          // of the workflow's event union — that's the whole point.
          def.reduce(snapshot as never, UNKNOWN as never)
        } catch {
          threw = true
        }
        if (!threw) survivors.push(`${def.name}@${def.schemaVersion} from "${state}"`)
      }
    }
    expect(
      survivors,
      `These (workflow, state) pairs accepted an unknown event type instead of throwing — ` +
        `a sign the reducer has an unguarded catch-all final branch that would silently ` +
        `misroute a new event-union member: ${survivors.join('; ')}.`,
    ).toEqual([])
  })

  it('sanity: the probe actually exercises every registered workflow', () => {
    // Guards against the behavioral test passing vacuously (e.g. an empty
    // registry import). 20 workflows registered as of 2026-06-13.
    expect(new Set(listWorkflows().map((d) => d.name)).size).toBeGreaterThanOrEqual(20)
  })
})
