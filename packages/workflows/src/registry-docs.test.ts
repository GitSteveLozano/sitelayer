// Doc-vs-registry consistency guard (2026-06-13 state-of-union review F6/VIS-5).
//
// Three places used to list the registered workflows by hand — CLAUDE.md (16),
// docs/DETERMINISTIC_WORKFLOWS.md (9), and registry.ts (the real 20) — and
// nothing failed when they drifted. This test pins the ONE canonical prose
// list (the "Currently registered" line in docs/DETERMINISTIC_WORKFLOWS.md) to
// the live registry, so adding a registerWorkflow() without updating the doc
// fails CI. CLAUDE.md points readers here rather than re-listing exhaustively.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import './index.js' // side-effect: every workflow module self-registers
import { listWorkflows } from './registry.js'

const DOC = resolve(import.meta.dirname, '../../../docs/DETERMINISTIC_WORKFLOWS.md')

describe('DETERMINISTIC_WORKFLOWS.md ⊇ registry', () => {
  it('the "Currently registered" line names every registered workflow', () => {
    const registered = [...new Set(listWorkflows().map((d) => d.name))].sort()
    expect(registered.length).toBeGreaterThanOrEqual(20)

    const doc = readFileSync(DOC, 'utf8')
    const line = doc.split('\n').find((l) => l.startsWith('Currently registered'))
    expect(line, 'no "Currently registered" line found in docs/DETERMINISTIC_WORKFLOWS.md').toBeTruthy()

    // Only fully `lower_snake` backtick tokens are workflow names; `registry.ts`,
    // `listWorkflows()`, paths etc. contain ./()- and don't match.
    const named = new Set([...line!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))
    const missing = registered.filter((n) => !named.has(n))
    expect(
      missing,
      `docs/DETERMINISTIC_WORKFLOWS.md "Currently registered" line is missing ` +
        `${missing.length} registered workflow(s): ${missing.join(', ')}. ` +
        `Regenerate the line from registry.ts / listWorkflows().`,
    ).toEqual([])
  })
})
