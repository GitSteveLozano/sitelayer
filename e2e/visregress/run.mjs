#!/usr/bin/env node
/**
 * sitelayer visual-regression gate — thin adapter over the shared `visregress` analyzer.
 *
 * The analyzer (Tier-0 ~8ms pixel gate -> Tier-1 local qwen3-vl-8b VLM judge, $0, only on a gated
 * change) is NOT vendored here; we depend on it the way we depend on @operator/projectkit — one
 * shared implementation, invoked via a stable entrypoint (VISREGRESS_HOME). Do NOT copy the engine
 * into this repo. The same analyzer backs chess/nhl/learn/sitelayer/sandolab/winwar.
 *
 * Flow: committed-baseline PNGs (e2e/visual/__baselines__/, produced by
 * `npx playwright test -c e2e/visual.config.ts`) are the reference; a fresh candidate is the matching
 * Playwright capture under e2e/visual/.artifacts (or e2e/visual/__candidates__), falling back to the
 * baseline itself (a clean no-op pair) so the gate is always runnable in CI even with no delta. This
 * script pairs them, runs the analyzer, fails CI (exit 2) on a confirmed regression, and — on a
 * confirmed regression with SIGNAL_URL set — emits a contract-conformant `visual.regression.detected`
 * ProjectEvent envelope through sitelayer's existing /api/signal relay.
 *
 * EMIT SHAPE (important): sitelayer's relay (apps/api/src/routes/signal.ts) runs
 * @operator/projectkit `validateProjectEvent` on every inner event, which REQUIRES four string
 * fields: schema_version, event_type, project_key, occurred_at. The analyzer's own --emit-url
 * envelope omits schema_version + project_key (built for the flat chess/nhl relays), so it 422s here.
 * We therefore do NOT pass --emit-url to the analyzer; we read its JSON verdict and POST our OWN
 * conformant envelope. (If projectkit's contract changes, adjust buildEnvelope below.)
 *
 * Env:
 *   VISREGRESS_HOME   dir containing visregress.py (default: ~/projects/model-bench)
 *   JUDGE             local | deepinfra | gemini   (default: local, $0)
 *   SIGNAL_URL        relay endpoint to emit to     (default: none; inert)
 *   BLOCK_GATE_PCT    gate-only floor that blocks even without a VLM (default: 0.02)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const HOME = process.env.HOME || '/home/taylorsando'
const VISREGRESS_HOME = process.env.VISREGRESS_HOME || join(HOME, 'projects/model-bench')
const BASELINES = join(ROOT, 'e2e/visual/__baselines__')
const ARTIFACTS = join(ROOT, 'e2e/visual/.artifacts')
const CANDIDATES = join(ROOT, 'e2e/visual/__candidates__')
const JUDGE = process.env.JUDGE || 'local'
const BLOCK = process.env.BLOCK_GATE_PCT || '0.02'
const PROJECT = 'sitelayer'

// The 3 highest-value screens to gate (baseline file id). candidate defaults to a fresh capture of
// the same id (under __candidates__ or .artifacts) if present, else the baseline itself (clean pair).
const SCREENS = [
  { id: 'takeoff-3d-demo' },
  { id: 'rental-billing-review' },
  { id: 'estimate-push-review' },
]

function candidateFor(id) {
  for (const dir of [CANDIDATES, ARTIFACTS]) {
    const p = join(dir, `${id}.png`)
    if (existsSync(p)) return p
  }
  return join(BASELINES, `${id}.png`) // fall back to baseline = clean pair
}

const pairs = SCREENS.map((s) => ({
  id: s.id,
  baseline: join(BASELINES, `${s.id}.png`),
  candidate: candidateFor(s.id),
})).filter((p) => existsSync(p.baseline))

if (!pairs.length) {
  console.error('[sitelayer] no baseline PNGs under', BASELINES, '\n  run: npx playwright test -c e2e/visual.config.ts')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'sitelayer-visregress-'))
const manifest = join(dir, 'pairs.json')
const resultsJson = join(dir, 'results.json')
writeFileSync(manifest, JSON.stringify(pairs, null, 2))

// Run the analyzer WITHOUT --emit-url (its envelope omits schema_version/project_key and would 422
// against this relay). Capture its stdout JSON so we can emit a conformant envelope ourselves.
const args = [
  join(VISREGRESS_HOME, 'visregress.py'),
  '--manifest', manifest,
  '--judge', JUDGE,
  '--block-gate-pct', BLOCK,
  '--project', PROJECT,
]

console.log(`[sitelayer] visregress: ${pairs.length} screens, judge=${JUDGE}, block=${BLOCK}`)
const res = spawnSync('python3', args, { cwd: VISREGRESS_HOME, encoding: 'utf8' })
process.stdout.write(res.stdout || '')
if (res.stderr) process.stderr.write(res.stderr)

// The analyzer prints the per-screen lines then a trailing JSON array; parse the JSON tail.
let verdicts = []
try {
  // The analyzer prints per-screen "[sitelayer] ..." lines, THEN the JSON array via
  // json.dumps(indent=2) — whose opening bracket sits alone on its own line ("\n[\n").
  // Match that to avoid grabbing a "[sitelayer]" log line.
  const out = res.stdout || ''
  const m = out.match(/\n\[\n[\s\S]*\n\]\s*$/)
  const jsonText = m ? m[0] : out.slice(out.indexOf('['))
  verdicts = JSON.parse(jsonText.trim())
  writeFileSync(resultsJson, JSON.stringify(verdicts, null, 2))
} catch {
  /* keep the analyzer's own exit code; just skip emit */
}

// Emit a contract-conformant envelope for any confirmed regression (inert unless SIGNAL_URL set).
if (process.env.SIGNAL_URL && verdicts.some((v) => v && v.is_regression)) {
  await emitRegressions(process.env.SIGNAL_URL, verdicts.filter((v) => v && v.is_regression))
}

process.exit(res.status ?? 1) // 0 clean, 2 regression -> CI gate

/**
 * Build the projectkit-conformant envelope sitelayer's /api/signal relay accepts. Each inner event
 * carries the four required strings (schema_version, event_type, project_key, occurred_at) +
 * optional payload object, matching validateProjectEvent in @operator/projectkit.
 */
function buildEnvelope(regressions) {
  const now = new Date().toISOString()
  return {
    schema_version: '1.0.0',
    project_key: PROJECT,
    emitted_at: now,
    producer: 'visregress',
    events: regressions.map((v) => ({
      schema_version: '1.0.0',
      event_type: 'visual.regression.detected',
      project_key: PROJECT,
      occurred_at: now,
      status: 'regression',
      payload: v,
    })),
  }
}

async function emitRegressions(url, regressions) {
  const envelope = buildEnvelope(regressions)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    const body = await r.text().catch(() => '')
    console.log(`[sitelayer] emit -> ${url} : ${r.status} ${body}`)
  } catch (e) {
    console.warn(`[sitelayer] emit failed: ${e}`)
  }
}
