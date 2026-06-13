#!/usr/bin/env node
/**
 * sitelayer visual-regression gate — thin adapter over the shared `visregress` analyzer.
 *
 * The analyzer (Tier-0 ~8ms pixel gate -> Tier-1 local qwen3-vl-8b VLM judge, $0, only on a gated
 * change) is NOT vendored here; we depend on it the way we depend on @operator/projectkit — one
 * shared implementation, invoked via a stable entrypoint (VISREGRESS_HOME). Do NOT copy the engine
 * into this repo. The same analyzer backs chess/nhl/learn/sitelayer/sandolab/winwar.
 *
 * END-TO-END FLOW (this is a REAL gate, not a baseline-vs-baseline no-op):
 *   1. clean any stale candidates under e2e/visual/__candidates__
 *   2. render a FRESH candidate of each gated screen via THIS repo's Playwright
 *      (e2e/visual.config.ts + top-screens.visual.spec.ts with VISUAL_SNAP_DIR=__candidates__),
 *      pointed at E2E_BASE_URL (a running app)
 *   3. pair each committed baseline (e2e/visual/__baselines__/<id>.png) with its fresh candidate
 *   4. run the shared analyzer; exit 2 on a confirmed regression -> CI / pre-push gate fails
 *   5. on a confirmed regression with SIGNAL_URL set, the analyzer itself emits a
 *      projectkit-conformant ENVELOPE event (validateProjectEvent-shaped) to sitelayer's relay.
 *
 * Only screens that produced a fresh candidate are gated. If NO candidate rendered (no app
 * reachable) the gate fails loudly (exit 1) instead of silently passing on stale pairs.
 *
 * EMIT SHAPE: sitelayer's relay (apps/api/src/routes/signal.ts) runs @operator/projectkit
 * `validateProjectEvent`, which REQUIRES schema_version + project_key on every inner event. The
 * shared analyzer's `--emit-format envelope --project-key sitelayer` builds exactly that, so we let
 * the analyzer emit — we no longer hand-roll an envelope here.
 *
 * Env:
 *   VISREGRESS_HOME   dir containing visregress.py (default: ~/projects/model-bench)
 *   E2E_BASE_URL      running app to capture candidates from (default: dev tier)
 *   JUDGE             local | deepinfra | gemini   (default: local, $0)
 *   SIGNAL_URL        relay endpoint to emit to     (default: none; inert)
 *   BLOCK_GATE_PCT    gate-only floor that blocks even without a VLM (default: 0.02)
 *   VISREGRESS_SKIP_CAPTURE=1  reuse existing __candidates__ (CI already rendered them)
 *   VISREGRESS_REQUIRE_BASELINES=1  STRICT: a declared SCREENS id that rendered a candidate but
 *                              has NO committed baseline is a LOUD FAILURE (exit 1), not a graceful
 *                              first-run prompt. Opt-in so we can flip it ON once baselines land;
 *                              the DEFAULT stays graceful (noBaseline -> exit 0) so the gate is not
 *                              broken before baselines are committed.
 *
 * EXIT CONTRACT (machine-readable summary on its own line for the fleet watcher):
 *   visregress: ran=<n> skipped=<n> noBaseline=<n> blocked=<n>
 *     ran        screens that had BOTH a fresh candidate and a committed baseline (actually gated)
 *     skipped    no candidate rendered (app/VLM-judge genuinely unreachable / screen failed to render)
 *     noBaseline candidate rendered but no committed baseline yet (first-run capture prompt)
 *     blocked    confirmed regression(s) OR (under VISREGRESS_REQUIRE_BASELINES=1) noBaseline ids
 *   exit 0  nothing gated produced a regression (skip/noBaseline alone never fail by default)
 *   exit 2  CONFIRMED regression from the analyzer (gate fails) — UNCHANGED contract
 *   exit 1  STRICT require-baselines violation, or an internal/harness error
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const HOME = process.env.HOME || '/home/taylorsando'
const VISREGRESS_HOME = process.env.VISREGRESS_HOME || join(HOME, 'projects/model-bench')
const BASELINES = join(ROOT, 'e2e/visual/__baselines__')
const CANDIDATES = join(ROOT, 'e2e/visual/__candidates__')
const JUDGE = process.env.JUDGE || 'local'
const BLOCK = process.env.BLOCK_GATE_PCT || '0.02'
const PROJECT = 'sitelayer'
const SKIP_CAPTURE = process.env.VISREGRESS_SKIP_CAPTURE === '1'
const REQUIRE_BASELINES = process.env.VISREGRESS_REQUIRE_BASELINES === '1'

// Single machine-readable summary line for the fleet watcher. Emit EXACTLY once,
// on every exit path, so a watcher can parse the gate outcome without scraping
// human prose. `blocked` is non-zero iff the gate is failing (regression, or a
// strict require-baselines violation).
function emitSummary({ ran, skipped, noBaseline, blocked }) {
  console.log(`visregress: ran=${ran} skipped=${skipped} noBaseline=${noBaseline} blocked=${blocked}`)
}

// Default candidate-capture target = the local app (docker stack / `npm run dev`). An explicit
// E2E_BASE_URL always wins (e.g. the persistent dev tier). The visual.config.ts default is the
// remote dev tier, which is wrong for a local pre-push gate, so we set localhost here when unset.
if (!process.env.E2E_BASE_URL) process.env.E2E_BASE_URL = 'http://localhost:3000'

// The screens to gate (baseline file id). One representative route per ported
// cluster (gap #6): tonight's R1-R6 retired the legacy kit across ~60 screens,
// but the gate only covered 3. `takeoff-3d-demo` is the public, auth-free,
// byte-stable surface; the others need a seeded stack (E2E_BASE_URL + e2e
// act-as) and render a stable list/empty-state baseline:
//   - rental-billing-review / estimate-push-review : FINANCIAL cluster (R3)
//   - settings-home                                : SETTINGS  cluster (R1)
//   - projects-list                                : PROJECTS  cluster (R2)
//   - rentals-utilization                          : INVENTORY/rentals (R4)
// Each id MUST have a matching capture test in e2e/visual/top-screens.visual.spec.ts
// (that spec produces both the committed __baselines__ and the fresh __candidates__).
const SCREENS = [
  { id: 'takeoff-3d-demo' },
  { id: 'rental-billing-review' },
  { id: 'estimate-push-review' },
  { id: 'settings-home' },
  { id: 'projects-list' },
  { id: 'rentals-utilization' },
  // Additional per-cluster coverage (gaps #6/#7). One representative route each
  // for clusters the gate was blind to. These have NO committed baseline yet,
  // so they render a candidate and report "no baseline" (a first-run capture
  // prompt) rather than a failure — capture baselines in the canonical CI env
  // (re-run top-screens.visual.spec.ts against the seeded stack) to gate them.
  { id: 'foreman-field' }, // FIELD cluster (/field, foreman)
  { id: 'owner-money' }, // FINANCIAL/owner cluster (/money, owner)
  { id: 'foreman-crew' }, // CREW cluster (/crew, foreman)
  { id: 'worker-hours' }, // WORKER/crew cluster (/hours, member)
]

// 1+2. render fresh candidates via this repo's Playwright (unless CI / a test already did).
// We clean stale candidates ONLY when we are about to re-render — VISREGRESS_SKIP_CAPTURE=1
// deliberately reuses whatever is in __candidates__ (e.g. an injected break, or a CI render).
if (!SKIP_CAPTURE) {
  rmSync(CANDIDATES, { recursive: true, force: true })
  mkdirSync(CANDIDATES, { recursive: true })
  console.log(
    `[sitelayer] rendering fresh candidates -> e2e/visual/__candidates__ (E2E_BASE_URL=${process.env.E2E_BASE_URL || '(default dev)'})`,
  )
  const pw = spawnSync('npx', ['playwright', 'test', '-c', 'e2e/visual.config.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, VISUAL_SNAP_DIR: 'e2e/visual/__candidates__' },
  })
  if (pw.status !== 0) {
    // A non-zero capture run is NOT fatal on its own — some screens (the auth-gated ones) may fail
    // to render when only the public app is reachable. We gate whatever candidates DID render below.
    console.warn(`[sitelayer] candidate capture exited ${pw.status} — gating the screens that rendered.`)
  }
} else {
  console.log('[sitelayer] VISREGRESS_SKIP_CAPTURE=1 — reusing existing __candidates__')
}

// 3. pair each baseline with its FRESH candidate. Only gate ids that produced a real candidate
//    AND have a committed baseline. The two "not gated" reasons are reported distinctly:
//    - skipped:    no candidate rendered (app not reachable / screen failed to render)
//    - noBaseline: a candidate rendered but there's no committed baseline yet (a newly added
//                  cluster screen) — a first-run capture prompt, NOT a failure.
const pairs = []
const skipped = []
const noBaseline = []
for (const s of SCREENS) {
  const baseline = join(BASELINES, `${s.id}.png`)
  const candidate = join(CANDIDATES, `${s.id}.png`)
  if (!existsSync(candidate)) {
    skipped.push(s.id)
    continue
  }
  if (!existsSync(baseline)) {
    noBaseline.push(s.id)
    continue
  }
  pairs.push({ id: s.id, baseline, candidate })
}

if (skipped.length) {
  console.warn(
    `[sitelayer] no fresh candidate for: ${skipped.join(', ')} — not gated this run (app not reachable / screen failed to render).`,
  )
}
if (noBaseline.length) {
  if (REQUIRE_BASELINES) {
    console.error(
      `[sitelayer] VISREGRESS_REQUIRE_BASELINES=1 and candidate rendered but NO committed baseline ` +
        `for: ${noBaseline.join(', ')} — a declared SCREENS id MUST have a committed baseline. ` +
        `Capture it in the canonical env (run e2e/visual/top-screens.visual.spec.ts with ` +
        `VISUAL_SNAP_DIR unset) and commit __baselines__/<id>.png.`,
    )
  } else {
    console.warn(
      `[sitelayer] candidate rendered but NO committed baseline yet for: ${noBaseline.join(', ')} — ` +
        `first-run / newly added cluster screen; capture a baseline in the canonical env ` +
        `(re-run e2e/visual/top-screens.visual.spec.ts) to start gating it. NOT a failure ` +
        `(set VISREGRESS_REQUIRE_BASELINES=1 to make this loud once baselines land).`,
    )
  }
}

// STRICT opt-in: a declared id that rendered a candidate but has no committed
// baseline is a LOUD failure. This is how we *require* baselines once they land
// without breaking the gate beforehand (the default below stays graceful).
if (REQUIRE_BASELINES && noBaseline.length) {
  emitSummary({ ran: 0, skipped: skipped.length, noBaseline: noBaseline.length, blocked: noBaseline.length })
  process.exit(1)
}

if (!pairs.length) {
  if (noBaseline.length) {
    // Candidates DID render — there's just no committed baseline to gate against
    // yet. That's a first-run state (skip, exit 0), not a failure. A genuinely
    // unreachable app falls to the branch below.
    console.warn(
      '[sitelayer] candidates rendered but no committed baselines to gate against yet — ' +
        'capture baselines in the canonical env. Not gating this run (exit 0).',
    )
    emitSummary({ ran: 0, skipped: skipped.length, noBaseline: noBaseline.length, blocked: 0 })
    process.exit(0)
  }
  // No candidate rendered for ANY declared screen: the app / VLM-judge is
  // genuinely unreachable (or every screen failed to render). This is a SKIP,
  // not a confirmed regression — we have nothing to compare, so we cannot
  // assert a "FAILED" candidate. Exit 0 so an offline box doesn't red the gate;
  // the `skipped` count + the absence of any `ran` makes the no-op visible to
  // the watcher. (A candidate that rendered but mismatched is the analyzer's
  // exit-2 below, which is the real, loud regression signal.)
  console.warn(
    '[sitelayer] no fresh candidate rendered for any declared screen — app/VLM-judge not reachable ' +
      'or every screen failed to render. Nothing to gate this run (skip, exit 0).\n' +
      '  start a seeded app and set E2E_BASE_URL (e.g. http://localhost:3000) to gate.',
  )
  emitSummary({ ran: 0, skipped: skipped.length, noBaseline: noBaseline.length, blocked: 0 })
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'sitelayer-visregress-'))
const manifest = join(dir, 'pairs.json')
const resultsJson = join(dir, 'results.json')
writeFileSync(manifest, JSON.stringify(pairs, null, 2))

// 4. run the analyzer. When SIGNAL_URL is set, the analyzer emits an ENVELOPE event itself
// (--emit-format envelope --project-key sitelayer) — projectkit validateProjectEvent-conformant.
const args = [
  join(VISREGRESS_HOME, 'visregress.py'),
  '--manifest',
  manifest,
  '--judge',
  JUDGE,
  '--block-gate-pct',
  BLOCK,
  '--project',
  PROJECT,
  '--producer',
  'sitelayer-visregress',
]
if (process.env.SIGNAL_URL) {
  args.push('--emit-url', process.env.SIGNAL_URL, '--emit-format', 'envelope', '--project-key', PROJECT)
}

console.log(
  `[sitelayer] visregress: ${pairs.length} screen(s) [${pairs.map((p) => p.id).join(', ')}], judge=${JUDGE}, block=${BLOCK}`,
)
const res = spawnSync('python3', args, { cwd: VISREGRESS_HOME, encoding: 'utf8' })
process.stdout.write(res.stdout || '')
if (res.stderr) process.stderr.write(res.stderr)

// Persist the verdicts (the analyzer prints per-screen lines then a trailing JSON array).
let blockedScreens = 0
try {
  const out = res.stdout || ''
  const m = out.match(/\n\[\n[\s\S]*\n\]\s*$/)
  const jsonText = m ? m[0] : out.slice(out.indexOf('['))
  const verdicts = JSON.parse(jsonText.trim())
  writeFileSync(resultsJson, JSON.stringify(verdicts, null, 2))
  // Count the screens the analyzer marked as a confirmed regression, so the
  // summary line carries a per-screen `blocked` count rather than just a bit.
  if (Array.isArray(verdicts)) {
    blockedScreens = verdicts.filter(
      (v) => v && (v.regression === true || v.blocked === true || v.verdict === 'regression'),
    ).length
  }
} catch {
  /* keep the analyzer's own exit code; results-file is best-effort */
}

// exit 2 = confirmed regression (UNCHANGED contract). If the analyzer flagged a
// regression but we couldn't parse a per-screen count, fall back to 1 so the
// summary still signals "blocked" rather than a false all-clear.
const exitCode = res.status ?? 1
const regressed = exitCode === 2
if (regressed && blockedScreens === 0) blockedScreens = 1

emitSummary({
  ran: pairs.length,
  skipped: skipped.length,
  noBaseline: noBaseline.length,
  blocked: blockedScreens,
})

process.exit(exitCode) // 0 clean, 2 regression -> CI / pre-push gate
