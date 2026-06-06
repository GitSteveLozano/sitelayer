import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { autoOnboardFirstAdmin } from './auto-onboard.js'

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
