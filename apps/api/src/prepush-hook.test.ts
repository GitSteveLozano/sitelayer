import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Unit-tests the .githooks/pre-push DECISION logic: which pushed refs trigger
 * the verification gate. We run the hook with PREPUSH_SKIP=1 so it never
 * actually invokes `npm run verify` (that is the gate itself, covered by
 * verify-local) — we only assert WHEN it decides to gate, based on the
 * "<local ref> <local sha> <remote ref> <remote sha>" lines git feeds on stdin.
 */

const HOOK = fileURLToPath(new URL('../../../.githooks/pre-push', import.meta.url))
const ZERO = '0000000000000000000000000000000000000000'
const SHA_A = '1111111111111111111111111111111111111111'
const SHA_B = '2222222222222222222222222222222222222222'

function runHook(stdin: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const result = spawnSync('bash', [HOOK, 'origin', 'https://example/repo.git'], {
    input: stdin,
    env: {
      PATH: process.env.PATH ?? '',
      // Never actually run the (expensive) gate in a unit test — we test the
      // ref-selection logic, not the gate body.
      PREPUSH_SKIP: '1',
      ...env,
    },
    encoding: 'utf8',
    timeout: 15_000,
  })
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' }
}

const refLine = (localRef: string, localSha: string, remoteRef: string, remoteSha: string) =>
  `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`

describe('.githooks/pre-push', () => {
  it('gates a push to refs/heads/dev', () => {
    const r = runHook(refLine('refs/heads/dev', SHA_A, 'refs/heads/dev', SHA_B))
    expect(r.out).toContain("push targets 'dev'")
    expect(r.out).toContain('running the standard verification gate')
    // PREPUSH_SKIP=1 short-circuits the gate but still exits 0.
    expect(r.err).toContain('PREPUSH_SKIP=1')
    expect(r.code).toBe(0)
  })

  it('gates a push to refs/heads/main', () => {
    const r = runHook(refLine('refs/heads/main', SHA_A, 'refs/heads/main', SHA_B))
    expect(r.out).toContain("push targets 'main'")
    expect(r.code).toBe(0)
  })

  it('does NOT gate a push to a feature branch', () => {
    const r = runHook(refLine('refs/heads/feat/x', SHA_A, 'refs/heads/feat/x', SHA_B))
    expect(r.out).not.toContain('verification gate')
    expect(r.err).not.toContain('PREPUSH_SKIP')
    expect(r.code).toBe(0)
  })

  it('does NOT gate a tag push', () => {
    const r = runHook(refLine('refs/tags/v1', SHA_A, 'refs/tags/v1', SHA_A))
    expect(r.out).not.toContain('verification gate')
    expect(r.code).toBe(0)
  })

  it('does NOT gate a branch DELETE to dev (all-zero local sha)', () => {
    const r = runHook(refLine('(delete)', ZERO, 'refs/heads/dev', SHA_B))
    expect(r.out).not.toContain('verification gate')
    expect(r.code).toBe(0)
  })

  it('gates when ANY of several pushed refs targets main', () => {
    const stdin =
      refLine('refs/heads/feat/x', SHA_A, 'refs/heads/feat/x', SHA_B) +
      refLine('refs/heads/main', SHA_A, 'refs/heads/main', SHA_B)
    const r = runHook(stdin)
    expect(r.out).toContain("push targets 'main'")
    expect(r.code).toBe(0)
  })

  it('honors PREPUSH_GATED_BRANCHES override (gate release/* alias)', () => {
    const r = runHook(refLine('refs/heads/release', SHA_A, 'refs/heads/release', SHA_B), {
      PREPUSH_GATED_BRANCHES: 'release',
    })
    expect(r.out).toContain("push targets 'release'")
    expect(r.code).toBe(0)
  })

  it('exits 0 on empty stdin (nothing to push)', () => {
    const r = runHook('')
    expect(r.out).not.toContain('verification gate')
    expect(r.code).toBe(0)
  })
})
