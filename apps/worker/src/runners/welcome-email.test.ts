import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import type { User } from '@clerk/backend'
import { createLogger } from '@sitelayer/logger'
import { createWelcomeEmailRunner, renderWelcomeEmail } from './welcome-email.js'

// Unit tests for the welcome-email runner.
//
// The runner is a thin wrapper around `drainAgentMutations`. Each test
// stubs out the pg surface (the only SQL shapes the drainer issues are
// `begin`, `commit`, `update mutation_outbox … returning id, payload`,
// and the per-row `update mutation_outbox set status = 'applied' …` ack)
// plus the injected `getUser` / `sendEmail`.

const testLogger = createLogger('welcome-email-runner-test', { level: 'silent' })

type FakeRow = QueryResultRow

interface FakeCall {
  sql: string
  params: ReadonlyArray<unknown>
}

type Responder = (sql: string, params: ReadonlyArray<unknown>) => Partial<QueryResult<FakeRow>> | Error | undefined

function buildResponse(r: Partial<QueryResult<FakeRow>>): QueryResult<FakeRow> {
  return {
    rows: r.rows ?? [],
    rowCount: r.rowCount ?? r.rows?.length ?? 0,
    command: r.command ?? '',
    oid: r.oid ?? 0,
    fields: r.fields ?? [],
  }
}

function makePool(responder: Responder): { pool: Pool; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  function makeClient(): PoolClient {
    const client: Partial<PoolClient> = {
      query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
        calls.push({ sql, params: params ?? [] })
        const r = responder(sql, params ?? [])
        if (r instanceof Error) throw r
        return buildResponse(r ?? {})
      }) as unknown as PoolClient['query'],
      release: vi.fn() as unknown as PoolClient['release'],
    }
    return client as PoolClient
  }
  const pool: Partial<Pool> = {
    query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ sql, params: params ?? [] })
      const r = responder(sql, params ?? [])
      if (r instanceof Error) throw r
      return buildResponse(r ?? {})
    }) as unknown as Pool['query'],
    connect: vi.fn(async () => makeClient()) as unknown as Pool['connect'],
  }
  return { pool: pool as Pool, calls }
}

function makeUser(overrides: Partial<User> = {}): User {
  const base = {
    id: 'user_owner',
    primaryEmailAddressId: 'em_1',
    emailAddresses: [{ id: 'em_1', emailAddress: 'owner@example.com' }],
    firstName: 'Alex',
  }
  return { ...base, ...overrides } as unknown as User
}

describe('renderWelcomeEmail', () => {
  it('uses the supplied first name and company name', () => {
    const out = renderWelcomeEmail({ firstName: 'Alex', companyName: 'Welcome Co' })
    expect(out.subject).toBe('Welcome to Sitelayer')
    expect(out.text).toMatch(/Hi Alex,/)
    expect(out.text).toMatch(/account Welcome Co is ready/)
    expect(out.html).toMatch(/<strong>Welcome Co<\/strong>/)
  })

  it('falls back to "there" / "your company" when names are missing', () => {
    const out = renderWelcomeEmail({ firstName: null, companyName: '' })
    expect(out.text).toMatch(/Hi there,/)
    expect(out.text).toMatch(/account your company is ready/)
  })

  it('does not embed the user email in the body (PII hygiene)', () => {
    const out = renderWelcomeEmail({ firstName: 'Alex', companyName: 'Welcome Co' })
    expect(out.text).not.toMatch(/@/)
    expect(out.html).not.toMatch(/@/)
  })

  it('escapes HTML in user-supplied names', () => {
    const out = renderWelcomeEmail({ firstName: '<script>', companyName: '<b>boom</b>' })
    expect(out.html).not.toContain('<script>')
    expect(out.html).toContain('&lt;script&gt;')
    expect(out.html).toContain('&lt;b&gt;boom&lt;/b&gt;')
  })
})

describe('createWelcomeEmailRunner', () => {
  const originalClerkSecret = process.env.CLERK_SECRET_KEY

  beforeEach(() => {
    delete process.env.CLERK_SECRET_KEY
  })

  afterEach(() => {
    if (originalClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY
    else process.env.CLERK_SECRET_KEY = originalClerkSecret
  })

  it('returns a zero summary and does not touch the pool when no rows are claimed', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox')) return { rows: [] }
      return { rows: [] }
    }
    const { pool } = makePool(responder)
    const sendEmail = vi.fn(async () => ({ ok: true as const, provider: 'console' as const }))
    const getUser = vi.fn(async () => makeUser())
    const runner = createWelcomeEmailRunner({ pool, logger: testLogger, getUser, sendEmail })

    const summary = await runner('co-1')
    expect(summary).toEqual({ processed: 0, insightsCreated: 0, failed: 0 })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(getUser).not.toHaveBeenCalled()
  })

  it('hydrates the recipient via Clerk, sends a welcome email, and marks the outbox row applied', async () => {
    const claimedRow = {
      id: 'outbox-welcome-1',
      payload: {
        user_id: 'user_owner',
        company_id: 'co-1',
        company_name: 'Welcome Co',
      },
    }
    let claimCalls = 0
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes('returning id, payload')) {
        claimCalls += 1
        // First call claims one row; any subsequent claim returns empty
        // to keep the drain bounded.
        return claimCalls === 1 ? { rows: [claimedRow] } : { rows: [] }
      }
      if (sql.includes("status = 'applied'")) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [] }
    }
    const { pool, calls } = makePool(responder)
    const sendEmail = vi.fn(async () => ({
      ok: true as const,
      provider: 'resend' as const,
      messageId: 'msg-1',
    }))
    const getUser = vi.fn(async () => makeUser())
    const runner = createWelcomeEmailRunner({ pool, logger: testLogger, getUser, sendEmail })

    const summary = await runner('co-1')
    expect(summary.processed).toBe(1)
    expect(summary.failed).toBe(0)

    expect(getUser).toHaveBeenCalledWith('user_owner')
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const call = sendEmail.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }]
    const message = call[0]
    expect(message.to).toBe('owner@example.com')
    expect(message.subject).toBe('Welcome to Sitelayer')
    expect(message.text).toMatch(/Hi Alex,/)
    expect(message.text).toMatch(/Welcome Co/)

    const appliedAck = calls.find(
      (c) => c.sql.includes('update mutation_outbox') && c.sql.includes("status = 'applied'"),
    )
    expect(appliedAck).toBeDefined()
    expect(appliedAck!.params).toContain('outbox-welcome-1')
  })

  it('fails the row (does not call sendEmail) when the Clerk user has no email', async () => {
    const claimedRow = {
      id: 'outbox-welcome-2',
      payload: { user_id: 'user_owner', company_id: 'co-1', company_name: 'Welcome Co' },
    }
    let claimCalls = 0
    let appliedSeen = false
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes('returning id, payload')) {
        claimCalls += 1
        return claimCalls === 1 ? { rows: [claimedRow] } : { rows: [] }
      }
      if (sql.includes("status = 'applied'")) {
        appliedSeen = true
        return { rows: [] }
      }
      return { rows: [] }
    }
    const { pool } = makePool(responder)
    const sendEmail = vi.fn(async () => ({ ok: true as const, provider: 'console' as const }))
    const getUser = vi.fn(async () => makeUser({ primaryEmailAddressId: null, emailAddresses: [] } as Partial<User>))
    const runner = createWelcomeEmailRunner({ pool, logger: testLogger, getUser, sendEmail })

    const summary = await runner('co-1')
    expect(summary.processed).toBe(1)
    expect(summary.failed).toBe(1)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(appliedSeen).toBe(false)
  })

  it('returns idle summary when CLERK_SECRET_KEY is unset and no getUser is injected', async () => {
    // No CLERK_SECRET_KEY, no injected getUser → runner soft-disables
    // and skips the claim entirely so rows aren't burned through their
    // attempt cap while the worker is misconfigured.
    const responder: Responder = () => ({ rows: [] })
    const { pool, calls } = makePool(responder)
    const sendEmail = vi.fn(async () => ({ ok: true as const, provider: 'console' as const }))
    const runner = createWelcomeEmailRunner({ pool, logger: testLogger, sendEmail })

    const summary = await runner('co-1')
    expect(summary).toEqual({ processed: 0, insightsCreated: 0, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
