// Workflow-event dispatch adoption ratchet.
//
// Every HUMAN workflow-event endpoint in apps/api/src/routes/ must go through
// the generic dispatch primitive (`dispatchWorkflowEvent` in
// apps/api/src/workflow-dispatch.ts — exemplar: `dispatchDailyLogSubmit` in
// routes/daily-logs.ts), which guarantees the lock → version-check → pure
// reduce → persist → recordWorkflowEvent → side-effects pipeline and that the
// event-log row the replay harness regression-tests is never forgotten.
//
// A small set of route call sites DELIBERATELY append to workflow_event_log
// directly via `recordWorkflowEvent` because they are NOT human-event
// dispatches (row-creation seeds / genesis events / a deprecated shim whose
// collapsed error handling cannot map onto DispatchResult without behavior
// change). Those are enumerated in ALLOWED_DIRECT_SITES below, each pinned to
// a stable content anchor near the call (NOT a line number — line numbers
// rot).
//
// The ratchet: add a NEW direct `recordWorkflowEvent` call (or import) in a
// route file and this test fails. Either port the endpoint onto
// `dispatchWorkflowEvent`, or — only if the call is genuinely not a
// human-event dispatch — extend the allowlist with a justification comment.
// Stale allowlist entries fail too, so the list can only shrink or be
// consciously grown.
//
// House style: source-text scan against the REAL tree, no DB needed — same
// shape as apps/worker/src/outbox-conformance.test.ts.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROUTES_DIR = resolve(import.meta.dirname, 'routes')

interface AllowedDirectSite {
  /** Route file (basename within apps/api/src/routes/). */
  file: string
  /**
   * Stable content anchor that must appear within the recordWorkflowEvent
   * call's argument window — survives line-number drift, dies with the call.
   */
  anchor: string
  /** Why this site legitimately bypasses dispatchWorkflowEvent. */
  justification: string
}

// Verified against current source 2026-06-12. Each entry is a
// non-human-dispatch append the primitive cannot express.
const ALLOWED_DIRECT_SITES: AllowedDirectSite[] = [
  {
    file: 'estimate-shares-admin.ts',
    anchor: "eventType: 'SEND'",
    justification:
      'POST /api/projects/:id/estimate/share — SEND is the row-creation seed: ' +
      'stateVersion 0 → freshly INSERTed sent/v1 row, explicitly not a reducer ' +
      'transition (packages/workflows/src/estimate-share.ts). No existing row ' +
      'to lock, no version check, no reduce step.',
  },
  {
    file: 'projects.ts',
    anchor: "eventType: 'CLOSEOUT'",
    justification:
      'DEPRECATED legacy shim POST /api/projects/:id/closeout (retained one ' +
      'release for unmigrated offline-queue replays / old SPA builds): ' +
      'reducer-bypassing idempotent early-success when already completed, ' +
      'row-`version` (not state_version) gating with not-found/conflict/' +
      'illegal-transition all collapsed to null → checkVersion/404 fallback. ' +
      'Control flow cannot map onto DispatchResult without behavior change.',
  },
  {
    file: 'schedules.ts',
    anchor: "eventType: 'CREATE'",
    justification:
      'POST /api/schedules — genesis CREATE append inside the create tx: a ' +
      'creation-time event-log row on a fresh INSERT (no lock/version-check/' +
      'UPDATE pipeline), logged at state_version 0 per the genesis convention. ' +
      'Forcing the primitive would add a fake load/persist cycle.',
  },
]

const FAILURE_HINT =
  `\nHuman workflow-event endpoints must use dispatchWorkflowEvent ` +
  `(apps/api/src/workflow-dispatch.ts — exemplar: dispatchDailyLogSubmit in ` +
  `apps/api/src/routes/daily-logs.ts), which always appends the ` +
  `workflow_event_log row the replay harness regression-tests. If this call ` +
  `is genuinely NOT a human-event dispatch (row-creation seed / genesis ` +
  `append / replay sweep), add an ALLOWED_DIRECT_SITES entry in ` +
  `apps/api/src/workflow-dispatch-ratchet.test.ts with a stable content ` +
  `anchor and a justification comment.`

/** Strip block comments and // line comments so prose mentioning
 * recordWorkflowEvent is not counted as a call site. Conservative: only
 * full-line and whitespace-preceded trailing // comments are removed, so
 * `https://...` inside string literals survives. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(\s)\/\/ .*$/gm, '$1')
}

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .sort()
}

interface CallSite {
  file: string
  /** Source window from the call's opening paren — anchors match against this. */
  window: string
}

function collectDirectUsage(): { importers: string[]; calls: CallSite[] } {
  const importers: string[] = []
  const calls: CallSite[] = []
  for (const file of routeFiles()) {
    const src = stripComments(readFileSync(join(ROUTES_DIR, file), 'utf8'))
    if (/import\s*(?:type\s*)?\{[^}]*\brecordWorkflowEvent\b[^}]*\}/.test(src)) {
      importers.push(file)
    }
    for (const m of src.matchAll(/recordWorkflowEvent\s*\(/g)) {
      // Generous fixed window — the anchor lives inside the call's argument
      // object, well within 1200 chars of the opening paren.
      calls.push({ file, window: src.slice(m.index!, m.index! + 1200) })
    }
  }
  return { importers, calls }
}

describe('workflow-dispatch adoption ratchet (routes/)', () => {
  it('extractor sanity: the scan still finds the known allowlisted sites', () => {
    const { calls } = collectDirectUsage()
    // If the scan finds none of the seeded sites, the extractor regressed —
    // a silently-green ratchet is worse than no ratchet.
    for (const site of ALLOWED_DIRECT_SITES) {
      expect(
        calls.some((c) => c.file === site.file),
        `extractor regression: expected to find a recordWorkflowEvent call in routes/${site.file}` +
          ` — if the site was ported to dispatchWorkflowEvent, remove its ALLOWED_DIRECT_SITES entry`,
      ).toBe(true)
    }
  })

  it('RATCHET: every direct recordWorkflowEvent call in routes/ is allowlisted', () => {
    const { calls } = collectDirectUsage()
    const unallowed = calls.filter(
      (c) => !ALLOWED_DIRECT_SITES.some((site) => site.file === c.file && c.window.includes(site.anchor)),
    )
    expect(
      unallowed,
      `direct recordWorkflowEvent call(s) in routes/ not covered by ALLOWED_DIRECT_SITES:\n` +
        unallowed.map((c) => `  routes/${c.file}: ${c.window.slice(0, 160).replace(/\s+/g, ' ')}…`).join('\n') +
        FAILURE_HINT,
    ).toEqual([])
  })

  it('RATCHET: every recordWorkflowEvent importer in routes/ is an allowlisted file', () => {
    const { importers } = collectDirectUsage()
    const allowedFiles = new Set(ALLOWED_DIRECT_SITES.map((s) => s.file))
    const unallowed = importers.filter((f) => !allowedFiles.has(f))
    expect(
      unallowed,
      `route file(s) import recordWorkflowEvent but are not in ALLOWED_DIRECT_SITES:\n` +
        unallowed.map((f) => `  routes/${f}`).join('\n') +
        FAILURE_HINT,
    ).toEqual([])
  })

  it('allowlist is not stale: each entry matches exactly one current call site', () => {
    const { calls } = collectDirectUsage()
    for (const site of ALLOWED_DIRECT_SITES) {
      const matches = calls.filter((c) => c.file === site.file && c.window.includes(site.anchor))
      expect(
        matches.length,
        `ALLOWED_DIRECT_SITES entry for routes/${site.file} (anchor ${JSON.stringify(site.anchor)}) ` +
          `matched ${matches.length} call site(s) — expected exactly 1. ` +
          `If the site was ported or removed, delete the entry; if a second call ` +
          `appeared near the same anchor, give each its own entry with a distinct anchor.`,
      ).toBe(1)
    }
  })
})
