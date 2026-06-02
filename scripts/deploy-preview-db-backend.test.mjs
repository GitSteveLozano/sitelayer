// Tests the PREVIEW_DB_BACKEND abstraction in scripts/deploy-preview.sh.
//
// These are hermetic: the script is run with stub `docker`/`rsync`/`curl`/`git`
// binaries on PATH (so no real Docker, network, or managed cluster is touched),
// a fake shared env, and a pre-seeded migrations marker so the migration step is
// skipped. We then assert on the rendered per-stack `.env` — the single artifact
// that decides whether a stack talks to the managed cluster or a local Postgres
// container. Run with: node --test scripts/deploy-preview-db-backend.test.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname
const script = join(repoRoot, 'scripts', 'deploy-preview.sh')

// A stub bin dir with fakes for every external command deploy-preview.sh shells
// out to. `docker` succeeds for `config`/`up`/`compose ps`/`inspect`; `curl`
// reports the health check passes so the script exits 0; `git` returns a fixed
// SHA so the migrations marker we pre-seed matches and the migration step is
// skipped entirely (no psql / no DB).
function makeStubBin(dir) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })

  const write = (name, body) => {
    const p = join(bin, name)
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(p, 0o755)
  }

  // docker: handle the few subcommands the script inspects, succeed otherwise.
  write(
    'docker',
    `
case "$1" in
  inspect) echo healthy ;;
  compose)
    shift
    # find the trailing subcommand
    for a in "$@"; do last="$a"; done
    case " $* " in
      *" ps "*) echo "stub-container-id" ;;
      *) exit 0 ;;
    esac
    ;;
  logs) exit 0 ;;
  *) exit 0 ;;
esac
exit 0
`,
  )
  // rsync: the script uses it to stage source; just succeed.
  write('rsync', 'exit 0')
  // curl: health check — always "up" so the deploy loop exits 0 immediately.
  write('curl', 'exit 0')
  // git: fixed SHA so the pre-seeded marker matches => migrations skipped.
  write(
    'git',
    `
case "$*" in
  *"rev-parse --short HEAD"*) echo deadbeef ;;
  *"rev-parse HEAD"*) echo deadbeefdeadbeefdeadbeefdeadbeefdeadbeef ;;
  *) exit 0 ;;
esac
exit 0
`,
  )
  // gh: no open-PR list (skip reap path deterministically).
  write('gh', 'exit 1')
  return bin
}

function runDeploy({ tier, backend, slug = 'pr-77' }) {
  const dir = mkdtempSync(join(tmpdir(), 'sitelayer-dbsplit.'))
  const previewRoot = join(dir, 'previews')
  mkdirSync(previewRoot, { recursive: true })

  const sharedEnv = join(dir, '.env.shared')
  // A "managed" DATABASE_URL in the shared env — the local backend must OVERRIDE
  // this; the managed backend must KEEP it.
  writeFileSync(
    sharedEnv,
    [
      'DATABASE_URL=postgres://managed_app:secret@managed-cluster:25060/sitelayer_preview?sslmode=require',
      'VITE_CLERK_PUBLISHABLE_KEY=pk_test_stub',
      '',
    ].join('\n'),
  )

  // Pre-seed the migrations marker so the migration step is skipped (the fixed
  // git SHA from the stub matches). slug → target dir mapping mirrors the script.
  const normalizedSlug = slug.toLowerCase()
  const targetDir = join(previewRoot, normalizedSlug)
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, '.migrations-applied-sha'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')

  const bin = makeStubBin(dir)
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    PREVIEW_ROOT: previewRoot,
    PREVIEW_SHARED_ENV: sharedEnv,
    PREVIEW_SOURCE_DIR: repoRoot,
    PREVIEW_SLUG: slug,
    PREVIEW_TIER: tier,
    PREVIEW_DEPLOY_SKIP_REAP: '1',
    PREVIEW_MODE: 'dev',
  }
  if (backend !== undefined) env.PREVIEW_DB_BACKEND = backend

  const result = spawnSync('bash', [script], { cwd: repoRoot, env, encoding: 'utf8' })
  const envPath = join(targetDir, '.env')
  let renderedEnv = ''
  try {
    renderedEnv = readFileSync(envPath, 'utf8')
  } catch {
    /* left empty if the script never wrote it */
  }
  rmSync(dir, { recursive: true, force: true })
  return { result, renderedEnv }
}

function envValue(body, key) {
  const lines = body.split('\n').filter((l) => l.startsWith(`${key}=`))
  if (lines.length === 0) return undefined
  return lines[lines.length - 1].slice(key.length + 1)
}

test('preview tier defaults to the local backend (ephemeral per-stack Postgres)', () => {
  const { result, renderedEnv } = runDeploy({ tier: 'preview', backend: undefined, slug: 'pr-77' })
  assert.equal(result.status, 0, `script failed: ${result.stderr}`)
  assert.equal(envValue(renderedEnv, 'PREVIEW_DB_BACKEND'), 'local')
  assert.equal(envValue(renderedEnv, 'DATABASE_URL'), 'postgres://sitelayer:sitelayer@preview-db:5432/sitelayer')
  // Local backend uses `public` — no per-slug schema / search_path lines.
  assert.equal(envValue(renderedEnv, 'PREVIEW_DB_SCHEMA'), undefined)
  assert.equal(envValue(renderedEnv, 'PGOPTIONS'), undefined)
})

test('preview tier honors an explicit managed backend (byte-compatible fallback)', () => {
  const { result, renderedEnv } = runDeploy({ tier: 'preview', backend: 'managed', slug: 'pr-77' })
  assert.equal(result.status, 0, `script failed: ${result.stderr}`)
  assert.equal(envValue(renderedEnv, 'PREVIEW_DB_BACKEND'), 'managed')
  // Managed keeps the shared cluster URL and the per-slug schema isolation.
  assert.match(envValue(renderedEnv, 'DATABASE_URL') ?? '', /managed-cluster/)
  assert.equal(envValue(renderedEnv, 'PREVIEW_DB_SCHEMA'), 'sitelayer_pr_77')
  assert.equal(envValue(renderedEnv, 'PGOPTIONS'), '-c search_path=sitelayer_pr_77,public')
})

test('dev tier defaults to managed (no auto-cutover)', () => {
  const { result, renderedEnv } = runDeploy({ tier: 'dev', backend: undefined, slug: 'dev' })
  assert.equal(result.status, 0, `script failed: ${result.stderr}`)
  assert.equal(envValue(renderedEnv, 'PREVIEW_DB_BACKEND'), 'managed')
  // Managed dev keeps the shared cluster URL and uses public (no per-slug schema).
  assert.match(envValue(renderedEnv, 'DATABASE_URL') ?? '', /managed-cluster/)
  assert.equal(envValue(renderedEnv, 'PREVIEW_DB_SCHEMA'), undefined)
})

test('dev tier opts in to the local backend when the flag is flipped', () => {
  const { result, renderedEnv } = runDeploy({ tier: 'dev', backend: 'local', slug: 'dev' })
  assert.equal(result.status, 0, `script failed: ${result.stderr}`)
  assert.equal(envValue(renderedEnv, 'PREVIEW_DB_BACKEND'), 'local')
  assert.equal(envValue(renderedEnv, 'DATABASE_URL'), 'postgres://sitelayer:sitelayer@preview-db:5432/sitelayer')
})

test('demo tier defaults to managed', () => {
  const { result, renderedEnv } = runDeploy({ tier: 'demo', backend: undefined, slug: 'demo' })
  assert.equal(result.status, 0, `script failed: ${result.stderr}`)
  assert.equal(envValue(renderedEnv, 'PREVIEW_DB_BACKEND'), 'managed')
  assert.match(envValue(renderedEnv, 'DATABASE_URL') ?? '', /managed-cluster/)
})

test('an invalid backend is rejected loudly', () => {
  const { result } = runDeploy({ tier: 'preview', backend: 'sqlite', slug: 'pr-77' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /PREVIEW_DB_BACKEND must be 'managed' or 'local'/)
})
