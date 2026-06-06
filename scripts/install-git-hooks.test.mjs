// Hermetic coverage for scripts/install-git-hooks.sh — the GATE-RELIABILITY
// fix. Builds a throwaway git repo (and a linked worktree) in a temp dir, copies
// the real install script + a stub .githooks/pre-push, and proves the pre-push
// gate fires RELIABLY even when core.hooksPath drifts back to the default.
//
// No DB / Docker / network — just git in a tmp dir. Runs under
// `node --test scripts/*.test.mjs` (npm run test:scripts), part of the unit
// stage of scripts/verify-local.sh.

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const installScript = join(scriptDir, 'install-git-hooks.sh')

// A stub versioned hook that does NOT run the real (slow) verify: it just prints
// a sentinel and exits per a controllable env var, so we can prove the chain
// REACHES the versioned hook under each config without paying for npm run verify.
const STUB_PRE_PUSH = `#!/usr/bin/env bash
set -euo pipefail
echo "STUB_VERSIONED_HOOK_RAN target=\${PREPUSH_GATED_BRANCHES:-dev main}"
exit "\${STUB_EXIT:-0}"
`

function git(cwd, args, env = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}`)
  }
  return res.stdout
}

// Build a self-contained repo with the install script + a stub versioned hook.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sitelayer-githooks.'))
  const env = {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  git(dir, ['init', '-q', '-b', 'main'], env)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, '.githooks'), { recursive: true })
  cpSync(installScript, join(dir, 'scripts', 'install-git-hooks.sh'))
  writeFileSync(join(dir, '.githooks', 'pre-push'), STUB_PRE_PUSH)
  chmodSync(join(dir, '.githooks', 'pre-push'), 0o755)
  writeFileSync(join(dir, 'README'), 'x')
  git(dir, ['add', '-A'], env)
  git(dir, ['commit', '-q', '-m', 'init'], env)
  return { dir, env }
}

function runInstall(dir, args = [], env = {}) {
  return spawnSync('bash', ['scripts/install-git-hooks.sh', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

// Resolve the hook git WOULD run for the given worktree, then run it exactly as
// git does: ref lines on stdin, "<remote-name> <remote-url>" as argv.
function runResolvedPrePush(dir, stdin, env = {}) {
  const hookPath = git(dir, ['rev-parse', '--git-path', 'hooks']).trim()
  const abs = hookPath.startsWith('/') ? hookPath : join(dir, hookPath)
  const hookFile = join(abs, 'pre-push')
  return spawnSync('bash', [hookFile, 'origin', 'git@example.com:x/y.git'], {
    cwd: dir,
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function defaultHooksDir(dir) {
  let common = git(dir, ['rev-parse', '--git-common-dir']).trim()
  if (!common.startsWith('/')) common = join(dir, common)
  return join(common, 'hooks')
}

const DEV_PUSH = 'refs/heads/dev aaaa refs/heads/dev bbbb\n'

test('install sets core.hooksPath and writes the drift backstop shim', () => {
  const { dir } = makeRepo()
  try {
    const res = runInstall(dir)
    assert.equal(res.status, 0, res.stderr)
    assert.equal(git(dir, ['config', '--local', '--get', 'core.hooksPath']).trim(), '.githooks')
    const shim = join(defaultHooksDir(dir), 'pre-push')
    assert.ok(existsSync(shim), 'backstop shim should exist in the default hooks dir')
    assert.match(readFileSync(shim, 'utf8'), /sitelayer-githooks-backstop-shim/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('install is idempotent (re-run is a clean no-op)', () => {
  const { dir } = makeRepo()
  try {
    assert.equal(runInstall(dir).status, 0)
    const second = runInstall(dir)
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /already = \.githooks/)
    assert.match(second.stdout, /shim already current/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--check passes when the primary core.hooksPath is set', () => {
  const { dir } = makeRepo()
  try {
    runInstall(dir)
    const res = runInstall(dir, ['--check'])
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /INSTALLED \(primary core\.hooksPath \+ drift backstop\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--check FAILS LOUD before install (no silent skip)', () => {
  const { dir } = makeRepo()
  try {
    const res = runInstall(dir, ['--check'])
    assert.equal(res.status, 1, 'check must exit non-zero when no gate would fire')
    assert.match(res.stderr, /NOT firing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GATE-RELIABILITY: gate still fires after core.hooksPath drifts to default', () => {
  const { dir } = makeRepo()
  try {
    runInstall(dir)
    // Simulate the observed drift: a worktree op / tool resets core.hooksPath
    // back to the default shared hooks dir.
    git(dir, ['config', '--local', 'core.hooksPath', defaultHooksDir(dir)])

    // --check must report the gate STILL fires (via the backstop), exit 0.
    const check = runInstall(dir, ['--check'])
    assert.equal(check.status, 0, check.stderr)
    assert.match(check.stdout, /INSTALLED via drift backstop/)

    // And the hook git actually resolves must reach the versioned hook.
    const hook = runResolvedPrePush(dir, DEV_PUSH)
    assert.equal(hook.status, 0, hook.stderr)
    assert.match(hook.stderr, /DEFAULT \(drift\)/)
    assert.match(hook.stdout, /STUB_VERSIONED_HOOK_RAN/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('primary path (no drift) runs the versioned hook directly', () => {
  const { dir } = makeRepo()
  try {
    runInstall(dir)
    const hook = runResolvedPrePush(dir, DEV_PUSH)
    assert.equal(hook.status, 0, hook.stderr)
    assert.match(hook.stdout, /STUB_VERSIONED_HOOK_RAN/)
    // No drift banner when core.hooksPath is the primary .githooks.
    assert.doesNotMatch(hook.stderr, /DEFAULT \(drift\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backstop shim fails LOUD (refuses push) if the versioned hook is gone', () => {
  const { dir } = makeRepo()
  try {
    runInstall(dir)
    git(dir, ['config', '--local', 'core.hooksPath', defaultHooksDir(dir)])
    // Remove the versioned hook to simulate a broken checkout.
    rmSync(join(dir, '.githooks', 'pre-push'), { force: true })
    const hook = runResolvedPrePush(dir, DEV_PUSH)
    assert.equal(hook.status, 1, 'shim must refuse the push when it cannot find the versioned hook')
    assert.match(hook.stderr, /UNGATED SHA/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the gate is reliable across LINKED WORKTREES (shared hooks dir)', () => {
  const { dir, env } = makeRepo()
  const wtParent = mkdtempSync(join(tmpdir(), 'sitelayer-githooks-wt.'))
  const wt = join(wtParent, 'feature')
  try {
    runInstall(dir)
    // Add a linked worktree on a fresh branch; it shares $GIT_COMMON_DIR/hooks
    // + the shared config. (Can't reuse 'main' — already checked out here.)
    git(dir, ['worktree', 'add', '-q', '-b', 'feature', wt, 'main'], env)

    // The worktree sees the same primary config and the same backstop shim.
    assert.equal(git(wt, ['config', '--get', 'core.hooksPath']).trim(), '.githooks')
    assert.equal(defaultHooksDir(wt), defaultHooksDir(dir))
    assert.ok(existsSync(join(defaultHooksDir(wt), 'pre-push')))

    // Drift hits ALL worktrees at once (shared config). The backstop in the
    // shared hooks dir still fires from the worktree.
    git(dir, ['config', '--local', 'core.hooksPath', defaultHooksDir(dir)])
    const hook = runResolvedPrePush(wt, DEV_PUSH)
    assert.equal(hook.status, 0, hook.stderr)
    assert.match(hook.stdout, /STUB_VERSIONED_HOOK_RAN/)
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir })
    rmSync(wtParent, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--uninstall removes the primary config and our backstop shim', () => {
  const { dir } = makeRepo()
  try {
    runInstall(dir)
    const shim = join(defaultHooksDir(dir), 'pre-push')
    assert.ok(existsSync(shim))
    const res = runInstall(dir, ['--uninstall'])
    assert.equal(res.status, 0, res.stderr)
    // `git config --get` exits non-zero when the key is unset — assert that.
    const after = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.notEqual(after.status, 0, 'core.hooksPath should be unset after uninstall')
    assert.ok(!existsSync(shim), 'backstop shim should be removed on uninstall')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--uninstall does NOT delete a foreign pre-push hook', () => {
  const { dir } = makeRepo()
  try {
    runInstall(dir)
    const shim = join(defaultHooksDir(dir), 'pre-push')
    // Replace our shim with a hand-written hook lacking our marker.
    writeFileSync(shim, '#!/usr/bin/env bash\necho not-ours\n')
    const res = runInstall(dir, ['--uninstall'])
    assert.equal(res.status, 0, res.stderr)
    assert.ok(existsSync(shim), 'foreign hook must be left untouched')
    assert.match(readFileSync(shim, 'utf8'), /not-ours/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('install leaves a foreign pre-push hook in place (does not clobber)', () => {
  const { dir } = makeRepo()
  try {
    const shimDir = defaultHooksDir(dir)
    mkdirSync(shimDir, { recursive: true })
    const shim = join(shimDir, 'pre-push')
    writeFileSync(shim, '#!/usr/bin/env bash\necho not-ours\n')
    const res = runInstall(dir)
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stderr, /NOT our backstop shim/)
    assert.match(readFileSync(shim, 'utf8'), /not-ours/)
    // Primary core.hooksPath is still the active gate in that case.
    assert.equal(git(dir, ['config', '--local', '--get', 'core.hooksPath']).trim(), '.githooks')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
