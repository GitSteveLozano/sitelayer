// Unit coverage for the per-tier tracked-branch wiring in
// scripts/fleet-auto-deploy.sh. The load-bearing behavior under test is the
// PROMOTION-MODEL separation shipped in feat/demo-tracks-main:
//
//   - the `demo` tier fast-follows `main` (the promoted / stable line), NOT
//     `dev` (the agent churn line);
//   - the `dev` tier still fast-follows `dev`;
//   - the per-tier override (AUTODEPLOY_BRANCH_DEMO) still wins.
//
// These run in the deterministic gate (`npm run test`), the safety net for a
// config+docs slice. They are hermetic: a LOCAL git "remote" (file://) carries
// distinct `dev` and `main` tips, each with a STUB scripts/deploy.sh that just
// records which tier it deployed and from which branch's checkout. No network,
// no DigitalOcean, no real droplet — the live /api/version probe is pointed at
// an unresolvable host so the watcher always treats the tier as out-of-date and
// proceeds to the (stubbed) deploy, and the post-deploy smoke is disabled.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Repo root is three levels up from apps/api/src (mirrors ops-iac-scripts.test.ts).
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const WATCHER = join(REPO_ROOT, 'scripts', 'fleet-auto-deploy.sh')

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runWatcher(env: Record<string, string>): RunResult {
  const result = spawnSync('bash', [WATCHER], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// Build a throwaway local git repo with TWO branches (`dev` and `main`) at
// distinct tips. Each branch carries a stub scripts/deploy.sh + a marker file so
// the test can prove which branch's checkout a tier deployed from. Returns the
// file:// url plus each branch's tip SHA.
function makeLocalRemote(markerFile: string): {
  url: string
  devSha: string
  mainSha: string
} {
  const dir = makeTempDir('fad-remote.')
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: cleanGitEnv(),
    })

  // A stub deploy.sh that appends "<tier-arg> <BRANCH_MARK>" to the shared marker
  // file, so the test sees both WHICH tier deployed and from WHICH branch's
  // checkout (the marker differs per branch). It exits 0 so the watcher records
  // SUCCESS and (with smoke disabled) does nothing else.
  const writeDeployStub = (branchMark: string) => {
    const scriptsDir = join(dir, 'scripts')
    execFileSync('mkdir', ['-p', scriptsDir])
    writeFileSync(
      join(scriptsDir, 'deploy.sh'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `printf '%s %s\\n' "$1" "${branchMark}" >> "${markerFile}"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
  }

  git(['init', '-q', '-b', 'dev'])
  writeFileSync(join(dir, 'README.md'), '# fixture dev\n')
  writeDeployStub('FROM_DEV')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'dev tip'])
  const devSha = git(['rev-parse', 'HEAD']).trim()

  // main diverges from dev with a different marker payload.
  git(['checkout', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'README.md'), '# fixture main\n')
  writeDeployStub('FROM_MAIN')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'main tip'])
  const mainSha = git(['rev-parse', 'HEAD']).trim()

  // Leave HEAD on dev so a default clone doesn't matter (the watcher checks out
  // the resolved desired SHA explicitly).
  git(['checkout', '-q', 'dev'])

  return { url: `file://${dir}`, devSha, mainSha }
}

function watcherEnv(home: string, remoteUrl: string): Record<string, string> {
  const cacheBase = join(home, 'cache')
  return {
    HOME: home,
    AUTODEPLOY_HOME: cacheBase,
    AUTODEPLOY_REMOTE_URL: remoteUrl,
    // Per-test lock so parallel vitest workers never collide.
    AUTODEPLOY_LOCK_FILE: join(home, 'lock'),
    // Point both tiers at hosts that cannot resolve, so live_sha_for_host returns
    // empty and the watcher always treats the tier as out-of-date -> deploys.
    AUTODEPLOY_HOST_DEV: 'dev.invalid.localhost.test',
    AUTODEPLOY_HOST_DEMO: 'demo.invalid.localhost.test',
    AUTODEPLOY_CURL_MAX_TIME: '2',
    // Disable the post-deploy smoke (it would hit the network).
    AUTODEPLOY_SMOKE: '0',
  }
}

function readMarker(markerFile: string): string {
  return existsSync(markerFile) ? readFileSync(markerFile, 'utf8') : ''
}

describe('scripts/fleet-auto-deploy.sh promotion-model branch wiring', () => {
  it('demo deploys from main (promoted line) and dev deploys from dev (churn line)', () => {
    const home = makeTempDir('fad-default.')
    const markerFile = join(home, 'deployed')
    const remote = makeLocalRemote(markerFile)

    const res = runWatcher(watcherEnv(home, remote.url))

    expect(res.status).toBe(0)

    // The watcher logs the branch it resolved per tier.
    expect(res.stdout).toMatch(/DEPLOY tier=dev branch=dev/)
    expect(res.stdout).toMatch(/DEPLOY tier=demo branch=main/)

    // And — the load-bearing assertion — the demo stub ran from the MAIN checkout
    // while dev ran from the DEV checkout.
    const marker = readMarker(markerFile)
    expect(marker).toMatch(/^dev FROM_DEV$/m)
    expect(marker).toMatch(/^demo FROM_MAIN$/m)
    // demo must NOT have deployed the dev (churn) line.
    expect(marker).not.toMatch(/^demo FROM_DEV$/m)
  })

  it('honors an explicit AUTODEPLOY_BRANCH_DEMO override over the main default', () => {
    const home = makeTempDir('fad-override.')
    const markerFile = join(home, 'deployed')
    const remote = makeLocalRemote(markerFile)

    // Force demo back onto dev via the documented per-tier override.
    const res = runWatcher({
      ...watcherEnv(home, remote.url),
      AUTODEPLOY_BRANCH_DEMO: 'dev',
    })

    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/DEPLOY tier=demo branch=dev/)
    const marker = readMarker(markerFile)
    // Override wins: demo now rides the dev checkout.
    expect(marker).toMatch(/^demo FROM_DEV$/m)
    expect(marker).not.toMatch(/^demo FROM_MAIN$/m)
  })

  it('the committed default for AUTODEPLOY_BRANCH_DEMO is main (config source of truth)', () => {
    // Guard against a regression that silently drops the per-tier default back to
    // dev: assert the script literally bakes the `main` default in.
    const src = readFileSync(WATCHER, 'utf8')
    expect(src).toMatch(/AUTODEPLOY_BRANCH_DEMO="\$\{AUTODEPLOY_BRANCH_DEMO:-main\}"/)
  })
})
