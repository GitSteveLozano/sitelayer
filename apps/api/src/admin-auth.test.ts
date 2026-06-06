import { describe, expect, it } from 'vitest'
import type { Identity } from './auth.js'
import {
  authorizePlatformAdmin,
  isSuperadmin,
  parseSuperadminEnvIds,
  requirePlatformAdmin,
  type AdminQueryExecutor,
} from './admin-auth.js'

const clerk = (userId: string): Identity => ({ userId, source: 'clerk' })

class FakeClient implements AdminQueryExecutor {
  queried = 0
  constructor(private readonly hits: Set<string> = new Set()) {}
  async query(_text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queried += 1
    const sub = String(values?.[0] ?? '')
    return { rows: this.hits.has(sub) ? [{ ok: 1 }] : [] }
  }
}

class ThrowingClient implements AdminQueryExecutor {
  async query(): Promise<{ rows: unknown[] }> {
    throw new Error('DB should not be queried')
  }
}

describe('parseSuperadminEnvIds', () => {
  it('returns an empty set for undefined/empty', () => {
    expect(parseSuperadminEnvIds(undefined).size).toBe(0)
    expect(parseSuperadminEnvIds('').size).toBe(0)
    expect(parseSuperadminEnvIds('   ').size).toBe(0)
  })

  it('splits on commas and whitespace, trimming blanks', () => {
    const ids = parseSuperadminEnvIds('user_a, user_b\nuser_c   user_d,')
    expect([...ids].sort()).toEqual(['user_a', 'user_b', 'user_c', 'user_d'])
  })
})

describe('isSuperadmin', () => {
  it('short-circuits on the env allowlist without querying the DB', async () => {
    const client = new ThrowingClient()
    expect(await isSuperadmin(client, 'user_env', new Set(['user_env']))).toBe(true)
  })

  it('falls through to the platform_admins table', async () => {
    const client = new FakeClient(new Set(['user_db']))
    expect(await isSuperadmin(client, 'user_db', new Set())).toBe(true)
    expect(client.queried).toBe(1)
  })

  it('is false for an unknown sub, and never queries for an empty sub', async () => {
    const client = new FakeClient(new Set(['user_db']))
    expect(await isSuperadmin(client, 'nope', new Set())).toBe(false)
    const empty = new FakeClient()
    expect(await isSuperadmin(empty, '', new Set(['']))).toBe(false)
    expect(empty.queried).toBe(0)
  })
})

describe('requirePlatformAdmin (pure)', () => {
  it('rejects non-Clerk identities with 401 (no act-as / header / internal escalation)', () => {
    for (const source of ['internal', 'header', 'default'] as const) {
      const gate = requirePlatformAdmin({ userId: 'x', source }, true)
      expect(gate).toEqual({ ok: false, status: 401, message: expect.any(String) })
    }
  })

  it('rejects a non-admin Clerk identity with 403', () => {
    expect(requirePlatformAdmin(clerk('u'), false)).toMatchObject({ ok: false, status: 403 })
  })

  it('accepts a Clerk superadmin', () => {
    expect(requirePlatformAdmin(clerk('u'), true)).toEqual({ ok: true, sub: 'u' })
  })
})

describe('authorizePlatformAdmin (async)', () => {
  it('rejects a non-Clerk caller with 401 without touching the DB', async () => {
    const client = new ThrowingClient()
    const gate = await authorizePlatformAdmin(client, { userId: 'u', source: 'header' }, new Set(['u']))
    expect(gate).toMatchObject({ ok: false, status: 401 })
  })

  it('admits a Clerk caller in the env allowlist (no query)', async () => {
    const client = new ThrowingClient()
    expect(await authorizePlatformAdmin(client, clerk('u'), new Set(['u']))).toEqual({ ok: true, sub: 'u' })
  })

  it('admits a Clerk caller present in the table', async () => {
    const client = new FakeClient(new Set(['u']))
    expect(await authorizePlatformAdmin(client, clerk('u'), new Set())).toEqual({ ok: true, sub: 'u' })
  })

  it('rejects a Clerk caller absent from both with 403', async () => {
    const client = new FakeClient()
    expect(await authorizePlatformAdmin(client, clerk('u'), new Set())).toMatchObject({ ok: false, status: 403 })
  })
})
