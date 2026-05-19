import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __resetBuildShaCacheForTests, getBuildSha, resolveBuildSha } from './build-sha.js'

afterEach(() => {
  __resetBuildShaCacheForTests()
})

describe('resolveBuildSha', () => {
  it('prefers SITELAYER_BUILD_SHA over every fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sha-test-'))
    fs.writeFileSync(path.join(dir, 'BUILD_SHA'), 'from-file\n')
    try {
      const sha = resolveBuildSha({
        env: {
          SITELAYER_BUILD_SHA: 'from-sitelayer-env',
          APP_BUILD_SHA: 'from-app-env',
          SENTRY_RELEASE: 'from-sentry-env',
        },
        startDir: dir,
      })
      expect(sha).toBe('from-sitelayer-env')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to APP_BUILD_SHA when SITELAYER_BUILD_SHA is unset', () => {
    expect(
      resolveBuildSha({
        env: { APP_BUILD_SHA: 'from-app-env', SENTRY_RELEASE: 'from-sentry-env' },
        startDir: os.tmpdir(),
      }),
    ).toBe('from-app-env')
  })

  it('falls back to SENTRY_RELEASE when neither build-sha env var is set', () => {
    expect(resolveBuildSha({ env: { SENTRY_RELEASE: 'from-sentry-env' }, startDir: os.tmpdir() })).toBe(
      'from-sentry-env',
    )
  })

  it('falls back to BUILD_SHA file when env vars are unset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sha-test-'))
    fs.writeFileSync(path.join(dir, 'BUILD_SHA'), 'abc1234\n')
    try {
      expect(resolveBuildSha({ env: {}, startDir: dir })).toBe('abc1234')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('walks up parent directories to find BUILD_SHA', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sha-walk-'))
    const nested = path.join(root, 'a', 'b', 'c')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(root, 'BUILD_SHA'), 'from-ancestor')
    try {
      expect(resolveBuildSha({ env: {}, startDir: nested })).toBe('from-ancestor')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("ignores empty env values and falls through to 'dev'", () => {
    expect(
      resolveBuildSha({
        env: { SITELAYER_BUILD_SHA: '   ', APP_BUILD_SHA: '', SENTRY_RELEASE: '' },
        startDir: os.tmpdir(),
      }),
    ).toBe('dev')
  })

  it("returns 'dev' when nothing is set and no BUILD_SHA file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sha-empty-'))
    try {
      expect(resolveBuildSha({ env: {}, startDir: dir })).toBe('dev')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects custom fallback', () => {
    expect(resolveBuildSha({ env: {}, startDir: os.tmpdir(), fallback: 'custom-fallback' })).toBe(
      'custom-fallback',
    )
  })
})

describe('getBuildSha', () => {
  it('memoizes the resolved value for the process lifetime', () => {
    const a = getBuildSha()
    const b = getBuildSha()
    expect(a).toBe(b)
    // The default resolver runs against process.env / process.cwd, so we
    // can't pin the value; assert only that it's a non-empty string.
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
  })
})
