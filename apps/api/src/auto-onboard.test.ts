import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { autoOnboardFirstAdmin } from './auto-onboard.js'
import { loadAuthConfig } from './auth.js'

/**
 * MULTI-TENANCY REGRESSION GUARD.
 *
 * The first-user self-onboard MUST insert the admin membership for the slug the
 * REQUEST resolved to — never a process-wide default-company constant. The
 * pre-fix server.ts passed the global `ACTIVE_COMPANY_SLUG` default
 * ('la-operations'), so a request for company B onboarded into la-operations:
 * the wrong tenant got an admin row and company B kept 404-ing. These tests
 * pin the corrected contract with a fake executor so no DB is needed.
 */
function makeExecutor() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params })
    return { rows: [], rowCount: 0 }
  })
  // pg's `query` is a heavily-overloaded type; the same `as unknown as` cast the
  // rest of the suite uses (pricing.test.ts, catalog.test.ts) bridges the narrow
  // fake to the consumer's Pick<Pool|PoolClient,'query'> param without widening
  // the production type. The assertions still run against the real `query` mock.
  return {
    executor: { query } as unknown as Pick<Pool | PoolClient, 'query'>,
    query,
    calls,
  }
}

describe('autoOnboardFirstAdmin', () => {
  it('inserts the membership for the RESOLVED request slug, not a global default', async () => {
    const { executor, calls } = makeExecutor()
    const result = await autoOnboardFirstAdmin(executor, {
      resolvedCompanySlug: 'company-b',
      userId: 'user_123',
    })
    expect(result.attempted).toBe(true)
    expect(calls).toHaveLength(1)
    // Param order is [userId, slug]; the slug MUST be the one the request asked
    // for. If this ever regresses to a default constant, this assertion fails.
    expect(calls[0]!.params).toEqual(['user_123', 'company-b'])
    expect(calls[0]!.sql).toContain('insert into company_memberships')
    expect(calls[0]!.sql).toContain('on conflict')
  })

  it('NEVER falls back to la-operations for a different tenant', async () => {
    const { executor, calls } = makeExecutor()
    await autoOnboardFirstAdmin(executor, { resolvedCompanySlug: 'acme-co', userId: 'u' })
    expect(calls[0]!.params).not.toContain('la-operations')
    expect(calls[0]!.params[1]).toBe('acme-co')
  })

  it('only claims a company that currently has zero members (idempotent guard)', async () => {
    const { executor, calls } = makeExecutor()
    await autoOnboardFirstAdmin(executor, { resolvedCompanySlug: 'company-b', userId: 'u' })
    // The not-exists guard is what makes repeat onboards / invited users safe.
    expect(calls[0]!.sql).toMatch(/not exists/i)
    expect(calls[0]!.sql).toMatch(/select 1 from company_memberships m where m\.company_id = c\.id/i)
  })

  it('trims the slug and user id and is a no-op when either is blank', async () => {
    const { executor, query, calls } = makeExecutor()
    const blankSlug = await autoOnboardFirstAdmin(executor, { resolvedCompanySlug: '   ', userId: 'u' })
    expect(blankSlug.attempted).toBe(false)
    const blankUser = await autoOnboardFirstAdmin(executor, { resolvedCompanySlug: 'company-b', userId: '' })
    expect(blankUser.attempted).toBe(false)
    expect(query).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)

    await autoOnboardFirstAdmin(executor, { resolvedCompanySlug: '  company-b  ', userId: '  u  ' })
    expect(calls[0]!.params).toEqual(['u', 'company-b'])
  })
})

/**
 * GATE BEHAVIOR (audit gap #10). The helper itself is unconditional; the
 * privilege-escalation gate lives at the server.ts call site
 * (`authConfig.allowFirstUserAdmin && !company && …`). These tests model that
 * exact call-site decision: in prod (flag unset) an attacker-supplied
 * zero-membership slug must NOT reach autoOnboardFirstAdmin at all; in dev /
 * with the flag on, the existing behavior holds.
 */
describe('auto-onboard admin-claim gate (server.ts call site)', () => {
  // Mirror of the server.ts guard: the onboard fires only when the flag is on
  // AND the company is unresolved AND the request named a slug + user.
  function gateFires(opts: {
    config: ReturnType<typeof loadAuthConfig>
    company: unknown
    isPublicPath: boolean
    requestedCompanySlug: string | null
    userId: string | null
  }): boolean {
    return Boolean(
      opts.config.allowFirstUserAdmin &&
      !opts.company &&
      !opts.isPublicPath &&
      opts.requestedCompanySlug &&
      opts.userId,
    )
  }

  const PROD_AUTH = {
    APP_TIER: 'prod',
    CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
    CLERK_ISSUER: 'https://clerk.sandolab.xyz',
    AUTH_ALLOW_HEADER_FALLBACK: '0',
  }

  it('prod + flag unset: attacker zero-membership slug does NOT trigger the admin claim', async () => {
    const config = loadAuthConfig(PROD_AUTH)
    const fired = gateFires({
      config,
      company: null, // zero-membership slug → getCompany() returned null
      isPublicPath: false,
      requestedCompanySlug: 'attacker-controlled-slug',
      userId: 'user_attacker',
    })
    expect(fired).toBe(false)

    // And if it doesn't fire, no membership insert happens.
    const { executor, query } = makeExecutor()
    if (fired) await autoOnboardFirstAdmin(executor, { resolvedCompanySlug: 'attacker-controlled-slug', userId: 'u' })
    expect(query).not.toHaveBeenCalled()
  })

  it('dev (flag defaults on): the existing first-user admin claim still fires', async () => {
    const config = loadAuthConfig({ APP_TIER: 'dev' })
    const fired = gateFires({
      config,
      company: null,
      isPublicPath: false,
      requestedCompanySlug: 'fresh-co',
      userId: 'user_1',
    })
    expect(fired).toBe(true)

    const { executor, query, calls } = makeExecutor()
    if (fired) await autoOnboardFirstAdmin(executor, { resolvedCompanySlug: 'fresh-co', userId: 'user_1' })
    expect(query).toHaveBeenCalledTimes(1)
    expect(calls[0]!.params).toEqual(['user_1', 'fresh-co'])
  })

  it('prod + explicit AUTH_ALLOW_FIRST_USER_ADMIN=1: deliberate opt-in re-enables the claim', () => {
    const config = loadAuthConfig({ ...PROD_AUTH, AUTH_ALLOW_FIRST_USER_ADMIN: '1' })
    const fired = gateFires({
      config,
      company: null,
      isPublicPath: false,
      requestedCompanySlug: 'first-onboard',
      userId: 'owner_1',
    })
    expect(fired).toBe(true)
  })
})
