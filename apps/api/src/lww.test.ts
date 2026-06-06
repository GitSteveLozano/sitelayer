import { describe, expect, it } from 'vitest'
import { evaluateLww, parseIfUnmodifiedSince } from './lww.js'

describe('parseIfUnmodifiedSince', () => {
  it('returns null for missing header', () => {
    expect(parseIfUnmodifiedSince(undefined)).toBeNull()
    expect(parseIfUnmodifiedSince(null)).toBeNull()
    expect(parseIfUnmodifiedSince('')).toBeNull()
  })

  it('parses ISO 8601 timestamps', () => {
    const parsed = parseIfUnmodifiedSince('2026-04-24T15:00:00.000Z')
    expect(parsed).toBeInstanceOf(Date)
    expect(parsed?.toISOString()).toBe('2026-04-24T15:00:00.000Z')
  })

  it('parses RFC 7231 IMF-fixdate', () => {
    const parsed = parseIfUnmodifiedSince('Fri, 24 Apr 2026 15:00:00 GMT')
    expect(parsed?.toISOString()).toBe('2026-04-24T15:00:00.000Z')
  })

  it('returns null for garbage input', () => {
    expect(parseIfUnmodifiedSince('not a date')).toBeNull()
  })
})

describe('evaluateLww', () => {
  it('passes through when no header is supplied', () => {
    const result = evaluateLww('2026-04-24T15:00:00.000Z', undefined)
    expect(result).toEqual({ ok: true, clientReference: null })
  })

  it('rejects when server is strictly newer than the client reference', () => {
    // Simulate two writes to the same row:
    //   1. Client A reads at 15:00:00.
    //   2. Client B writes at 15:01:00 (server now at 15:01:00).
    //   3. Client A's queued offline mutation replays with
    //      If-Unmodified-Since: 15:00:00 — must 409.
    const result = evaluateLww('2026-04-24T15:01:00.000Z', '2026-04-24T15:00:00.000Z')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected non-ok result')
    expect(result.reason).toBe('server_newer')
    if (result.reason !== 'server_newer') throw new Error('expected server_newer')
    expect(result.serverUpdatedAt.toISOString()).toBe('2026-04-24T15:01:00.000Z')
    expect(result.clientReference.toISOString()).toBe('2026-04-24T15:00:00.000Z')
  })

  it('accepts when server timestamp matches the client reference exactly', () => {
    const ts = '2026-04-24T15:00:00.000Z'
    const result = evaluateLww(ts, ts)
    expect(result.ok).toBe(true)
  })

  it('accepts when server is older than the client reference (clock skew but no concurrent write)', () => {
    const result = evaluateLww('2026-04-24T14:59:00.000Z', '2026-04-24T15:00:00.000Z')
    expect(result.ok).toBe(true)
  })

  it('rejects with header_unparseable when the header is malformed', () => {
    const result = evaluateLww('2026-04-24T15:00:00.000Z', 'not-a-date')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected non-ok result')
    expect(result.reason).toBe('header_unparseable')
  })

  it('lets the write through when the server has no timestamp yet (new row)', () => {
    const result = evaluateLww(null, '2026-04-24T15:00:00.000Z')
    expect(result.ok).toBe(true)
  })
})

describe('LWW two-write simulation', () => {
  // High-level sanity: this is the scenario the spec calls out — simulate two
  // writes, assert second write with stale If-Unmodified-Since gets 409. We
  // model the server's `updated_at` as a single mutable value and walk
  // through the calls evaluateLww would receive.
  it('first write succeeds; second write with stale If-Unmodified-Since is rejected', () => {
    // Initial server state: row created at T0.
    const T0 = '2026-04-24T15:00:00.000Z'
    const T1 = '2026-04-24T15:01:00.000Z'

    // Client A reads the row at T0.
    const clientAReadsAt = T0

    // Client B writes at T1 — its If-Unmodified-Since matches the current
    // server timestamp T0, so the LWW check passes and the server bumps
    // `updated_at` to T1.
    const firstWrite = evaluateLww(T0, T0)
    expect(firstWrite.ok).toBe(true)
    const serverAfterFirstWrite = T1

    // Client A's queued offline mutation now replays with
    // If-Unmodified-Since: T0, but the server is at T1 → 409.
    const secondWrite = evaluateLww(serverAfterFirstWrite, clientAReadsAt)
    expect(secondWrite.ok).toBe(false)
    if (secondWrite.ok) throw new Error('expected 409-equivalent')
    expect(secondWrite.reason).toBe('server_newer')
  })
})
