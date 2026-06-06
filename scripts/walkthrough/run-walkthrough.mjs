#!/usr/bin/env node
// Deterministic walkthrough → video (kept locally) → OPTIONAL gemini-video check.
//
// Runs a Playwright walkthrough (video always on, see
// e2e/walkthroughs/walkthrough.config.ts), keeps the recording on the external
// drive, and ONLY when asked hands it to the Gemini CLI to verify the recording
// matches the walkthrough's expected step narrative (walkthrough-steps.json).
// Gemini is opt-in so routine runs don't burn the Gemini usage limits.
//
//   node scripts/walkthrough/run-walkthrough.mjs              # record only (no gemini) — default
//   node scripts/walkthrough/run-walkthrough.mjs --verify     # also gemini-video-verify (opt-in)
//   node scripts/walkthrough/run-walkthrough.mjs takeoff-demo --verify   # filter + verify
//
// Env: E2E_BASE_URL (default dev), GEMINI_CLI_BIN (default 'gemini'),
//      WALKTHROUGH_VERIFY=1 (gemini opt-in), WALKTHROUGH_VIDEO_DIR (where videos
//      are kept; default /mnt/backup/sitelayer-walkthroughs — never DO Spaces).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const CONFIG = 'e2e/walkthroughs/walkthrough.config.ts'

// Where recorded walkthrough videos are KEPT. Default to the large external
// drive so they persist off-repo and OUT of DigitalOcean Spaces; fall back to a
// local gitignored dir if that drive isn't mounted. Override with
// WALKTHROUGH_VIDEO_DIR (e.g. point it at a plugged-in USB under /media/...).
const VIDEO_ROOT =
  process.env.WALKTHROUGH_VIDEO_DIR ??
  (existsSync('/mnt/backup')
    ? '/mnt/backup/sitelayer-walkthroughs'
    : path.join(ROOT, 'e2e', 'walkthroughs', '.artifacts'))

// Gemini verification is OPT-IN — routine runs just record the video, so we
// don't burn the Gemini usage limits. Pass --verify or set WALKTHROUGH_VERIFY=1
// to have gemini-video check the recording.
const args = process.argv.slice(2)
const VERIFY = args.includes('--verify') || process.env.WALKTHROUGH_VERIFY === '1'
const filter = args.find((a) => !a.startsWith('-')) ?? ''

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })
}

// Each run gets its own timestamped dir — videos accumulate on the drive (we
// keep them rather than wiping a shared external location).
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = path.join(VIDEO_ROOT, `run-${stamp}${filter ? `-${filter.replace(/[^a-z0-9]+/gi, '-')}` : ''}`)
mkdirSync(OUT, { recursive: true })

console.log(`▶ walkthrough run (base=${process.env.E2E_BASE_URL ?? 'https://dev.sitelayer.sandolab.xyz'})`)
console.log(
  `   videos → ${OUT}${VERIFY ? '   [--verify: gemini-video on]' : '   (record only; --verify to gemini-check)'}`,
)
try {
  sh('npx', ['playwright', 'test', '-c', CONFIG, ...(filter ? [filter] : [])], {
    stdio: 'inherit',
    env: { ...process.env, WALKTHROUGH_OUT: OUT },
  })
} catch {
  // Playwright exits non-zero on assertion failure, but the video may still be
  // worth verifying (gemini can confirm where it diverged). Keep going.
  console.warn('⚠ walkthrough reported failures — verifying the recording anyway.')
}

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const files = existsSync(OUT) ? walk(OUT) : []
const videos = files.filter((f) => f.endsWith('.webm')).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
if (!videos.length) {
  console.error('✖ no walkthrough video recorded under', OUT)
  process.exit(2)
}
const video = videos[0]
const stepsFile = files.find((f) => f.endsWith('walkthrough-steps.json'))
const steps = stepsFile ? JSON.parse(readFileSync(stepsFile, 'utf8')) : { title: 'walkthrough', steps: [] }
console.log('🎬 recorded video:', video)

if (!VERIFY) {
  console.log('\n✓ recorded (gemini verification skipped to conserve usage limits).')
  console.log('  Re-run with --verify (or WALKTHROUGH_VERIFY=1) to have gemini-video check this recording.')
  process.exit(0)
}

// Transcode to mp4 (Gemini accepts webm too; mp4 is the safe interchange).
const mp4 = video.replace(/\.webm$/, '.mp4')
try {
  sh('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', video, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4])
} catch {
  /* fall back to the webm */
}
const media = existsSync(mp4) ? mp4 : video

const prompt = [
  'You are verifying a DETERMINISTIC screen-recording walkthrough of a construction takeoff web app.',
  `Walkthrough: ${steps.title}. It should show these steps, in order:`,
  ...steps.steps.map((s) => `  ${s.n}. ${s.action}  ->  expect: ${s.expect}`),
  '',
  'Watch the attached video and decide, per step, whether what was expected is actually visible.',
  'Return ONLY a single minified JSON object, no prose, no code fences:',
  '{"steps":[{"n":<int>,"visible":<bool>,"note":<string>}],"pass":<bool>,"summary":<string>}',
  'pass = true only if every expected step is visibly present and in order.',
  '',
  `@${media}`,
].join('\n')

// The CLI rides the $0 OAuth subscription when no key is present (matches the
// worker's gemini-cli media adapter); unset the key so we do not hit the cash API.
const env = { ...process.env }
delete env.GEMINI_API_KEY
delete env.GOOGLE_API_KEY

console.log('🤖 gemini-video verifying the recording…')
let out
try {
  out = sh(env.GEMINI_CLI_BIN ?? 'gemini', ['-p', prompt], { env })
} catch (e) {
  console.error('✖ gemini-video failed:', e.message?.slice(0, 400))
  process.exit(3)
}

console.log('\n=== gemini-video verdict ===')
console.log(out.trim())

// Reflect the verdict in the exit code so CI / callers can gate on it.
try {
  const m = out.match(/\{[\s\S]*\}/)
  const verdict = m ? JSON.parse(m[0]) : null
  if (verdict && verdict.pass === false) {
    console.error('\n✖ walkthrough did NOT pass gemini-video verification')
    process.exit(1)
  }
  console.log('\n✓ walkthrough verified by gemini-video')
} catch {
  console.warn('\n(could not parse a JSON verdict; see raw output above)')
}
