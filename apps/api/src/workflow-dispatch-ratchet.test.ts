// Workflow-event dispatch adoption ratchet.
//
// Every HUMAN workflow-event dispatch anywhere in apps/api/src/ (NOT just
// routes/ — a hand-rolled dispatch in a sibling helper like qbo-sync-run.ts is
// the exact silent-drift class this guards) must go through the generic
// dispatch primitive (`dispatchWorkflowEvent` in
// apps/api/src/workflow-dispatch.ts — exemplar: `dispatchDailyLogSubmit` in
// routes/daily-logs.ts), which guarantees the lock → version-check → pure
// reduce → persist → recordWorkflowEvent → side-effects pipeline and that the
// event-log row the replay harness regression-tests is never forgotten.
//
// A small set of call sites DELIBERATELY append to workflow_event_log directly
// via `recordWorkflowEvent` because they are NOT human-event dispatches
// (row-creation seeds / genesis events / worker-emitted terminal events / a
// deprecated shim whose collapsed error handling cannot map onto DispatchResult
// without behavior change). Those are enumerated in ALLOWED_DIRECT_SITES below,
// each pinned to a stable content anchor near the call (NOT a line number —
// line numbers rot).
//
// The ratchet: add a NEW direct `recordWorkflowEvent` call (or import) anywhere
// under apps/api/src/ and this test fails. Either port the endpoint onto
// `dispatchWorkflowEvent`, or — only if the call is genuinely not a
// human-event dispatch — extend the allowlist with a justification comment.
// Stale allowlist entries fail too, so the list can only shrink or be
// consciously grown.
//
// House style: source-text scan against the REAL tree, no DB needed — same
// shape as apps/worker/src/outbox-conformance.test.ts.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// Scan ALL of apps/api/src — not just routes/. A human workflow-event dispatch
// that hand-rolls recordWorkflowEvent in a sibling helper one directory up
// (e.g. qbo-sync-run.ts, estimate-share-helpers.ts) would otherwise pass CI
// undetected — the exact silent-drift class this ratchet exists to stop.
const SRC_DIR = resolve(import.meta.dirname)

// Files that legitimately name/handle recordWorkflowEvent but are NOT bypass
// call sites: mutation-tx.ts DEFINES it; workflow-dispatch.ts is THE primitive
// every allowed path routes through. Excluded so the scan doesn't flag the
// canonical path as a violation. Paths are relative to SRC_DIR.
const EXCLUDED_FILES = new Set(['mutation-tx.ts', 'workflow-dispatch.ts'])

interface AllowedDirectSite {
  /** Source file path relative to apps/api/src/ (e.g. 'routes/schedules.ts'). */
  file: string
  /**
   * Stable content anchor that must appear within the recordWorkflowEvent
   * call's argument window — survives line-number drift, dies with the call.
   */
  anchor: string
  /** Why this site legitimately bypasses dispatchWorkflowEvent. */
  justification: string
}

// Verified against current source 2026-06-13. Each entry is a
// non-human-dispatch append the primitive cannot express.
const ALLOWED_DIRECT_SITES: AllowedDirectSite[] = [
  {
    file: 'routes/estimate-shares-admin.ts',
    anchor: "eventType: 'SEND'",
    justification:
      'POST /api/projects/:id/estimate/share — SEND is the row-creation seed: ' +
      'stateVersion 0 → freshly INSERTed sent/v1 row, explicitly not a reducer ' +
      'transition (packages/workflows/src/estimate-share.ts). No existing row ' +
      'to lock, no version check, no reduce step.',
  },
  {
    file: 'qbo-sync-run.ts',
    anchor: "eventType: 'START_SYNC'",
    justification:
      'startQboSyncRun — GENESIS append: the qbo_sync_run row is created and ' +
      'moved pending → syncing in the same tx (the route currently acts as the ' +
      'worker, running sync inline). System-initiated run plumbing, not a human ' +
      'workflow-event endpoint. The human RETRY/START_SYNC button path goes ' +
      'through dispatchWorkflowEvent in dispatchQboSyncRunHumanEvent.',
  },
  {
    file: 'qbo-sync-run.ts',
    anchor: "eventType: 'SYNC_SUCCEEDED'",
    justification:
      'completeQboSyncRunSuccess — WORKER-EMITTED terminal event (syncing → ' +
      'succeeded), analogous to rental-billing POST_SUCCEEDED. Rejected at the ' +
      'route boundary by parseQboSyncRunEventRequest, so it is never a human ' +
      'dispatch; emitted by the inline sync runner.',
  },
  {
    file: 'qbo-sync-run.ts',
    anchor: "eventType: 'SYNC_FAILED'",
    justification:
      'completeQboSyncRunFailure — WORKER-EMITTED terminal event (syncing → ' +
      'failed), analogous to rental-billing POST_FAILED. Rejected at the route ' +
      'boundary by parseQboSyncRunEventRequest; emitted by the inline sync ' +
      'runner, not a human endpoint.',
  },
  {
    file: 'routes/projects.ts',
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
    file: 'routes/schedules.ts',
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

/** Every .ts source under apps/api/src (recursive), as paths relative to
 * SRC_DIR, excluding tests, .d.ts, and the EXCLUDED_FILES canonical sites. */
function srcFiles(dir: string = SRC_DIR): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...srcFiles(abs))
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue
    const rel = relative(SRC_DIR, abs)
    if (EXCLUDED_FILES.has(rel)) continue
    out.push(rel)
  }
  return out.sort()
}

interface CallSite {
  /** Path relative to apps/api/src/ (e.g. 'routes/schedules.ts'). */
  file: string
  /** Source window from the call's opening paren — anchors match against this. */
  window: string
}

function collectDirectUsage(): { importers: string[]; calls: CallSite[] } {
  const importers: string[] = []
  const calls: CallSite[] = []
  for (const file of srcFiles()) {
    const src = stripComments(readFileSync(join(SRC_DIR, file), 'utf8'))
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

describe('workflow-dispatch adoption ratchet (apps/api/src/)', () => {
  it('extractor sanity: the scan still finds the known allowlisted sites', () => {
    const { calls } = collectDirectUsage()
    // If the scan finds none of the seeded sites, the extractor regressed —
    // a silently-green ratchet is worse than no ratchet.
    for (const site of ALLOWED_DIRECT_SITES) {
      expect(
        calls.some((c) => c.file === site.file && c.window.includes(site.anchor)),
        `extractor regression: expected to find a recordWorkflowEvent call in apps/api/src/${site.file}` +
          ` matching anchor ${JSON.stringify(site.anchor)} — if the site was ported to dispatchWorkflowEvent,` +
          ` remove its ALLOWED_DIRECT_SITES entry`,
      ).toBe(true)
    }
  })

  it('RATCHET: every direct recordWorkflowEvent call in apps/api/src/ is allowlisted', () => {
    const { calls } = collectDirectUsage()
    const unallowed = calls.filter(
      (c) => !ALLOWED_DIRECT_SITES.some((site) => site.file === c.file && c.window.includes(site.anchor)),
    )
    expect(
      unallowed,
      `direct recordWorkflowEvent call(s) not covered by ALLOWED_DIRECT_SITES:\n` +
        unallowed.map((c) => `  apps/api/src/${c.file}: ${c.window.slice(0, 160).replace(/\s+/g, ' ')}…`).join('\n') +
        FAILURE_HINT,
    ).toEqual([])
  })

  it('RATCHET: every recordWorkflowEvent importer in apps/api/src/ is an allowlisted file', () => {
    const { importers } = collectDirectUsage()
    const allowedFiles = new Set(ALLOWED_DIRECT_SITES.map((s) => s.file))
    const unallowed = importers.filter((f) => !allowedFiles.has(f))
    expect(
      unallowed,
      `source file(s) import recordWorkflowEvent but are not in ALLOWED_DIRECT_SITES:\n` +
        unallowed.map((f) => `  apps/api/src/${f}`).join('\n') +
        FAILURE_HINT,
    ).toEqual([])
  })

  it('allowlist is not stale: each entry matches exactly one current call site', () => {
    const { calls } = collectDirectUsage()
    for (const site of ALLOWED_DIRECT_SITES) {
      const matches = calls.filter((c) => c.file === site.file && c.window.includes(site.anchor))
      expect(
        matches.length,
        `ALLOWED_DIRECT_SITES entry for apps/api/src/${site.file} (anchor ${JSON.stringify(site.anchor)}) ` +
          `matched ${matches.length} call site(s) — expected exactly 1. ` +
          `If the site was ported or removed, delete the entry; if a second call ` +
          `appeared near the same anchor, give each its own entry with a distinct anchor.`,
      ).toBe(1)
    }
  })
})
