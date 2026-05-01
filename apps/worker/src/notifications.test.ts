import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '@sitelayer/logger'
import {
  drainNotifications,
  type DrainNotificationsConfig,
  type DrainNotificationsDeps,
  type NotificationDbClient,
  type PendingNotificationRow,
} from './notifications.js'
import type { ClerkResolver, EmailResolution } from './clerk-hydrate.js'
import type { EmailConfig } from './email.js'

// Test-only logger that no-ops via the real factory. Pino's silent level is
// inherited if the env says so; otherwise the logs are harmless.
const testLogger = createLogger('notifications-test', { level: 'silent' })

const baseEmailConfig: EmailConfig = { provider: 'console', from: 'noreply@test.local' }

function makeRow(overrides: Partial<PendingNotificationRow> = {}): PendingNotificationRow {
  return {
    id: 'row-1',
    company_id: 'co-1',
    recipient_clerk_user_id: 'user_clerk_1',
    recipient_email: null,
    kind: 'rental_billing.posted',
    subject: 'Hello',
    body_text: 'plain',
    body_html: null,
    attempt_count: 0,
    ...overrides,
  }
}

interface QueryCall {
  sql: string
  params: ReadonlyArray<unknown>
}

function makeFakeClient(claimedRows: PendingNotificationRow[]): {
  client: NotificationDbClient
  calls: QueryCall[]
} {
  const calls: QueryCall[] = []
  const client: NotificationDbClient = {
    async query<R>(sql: string, params?: ReadonlyArray<unknown>): Promise<{ rows: R[] }> {
      calls.push({ sql, params: params ?? [] })
      const trimmed = sql.trim()
      if (trimmed.startsWith('select id, company_id, recipient_clerk_user_id')) {
        return { rows: claimedRows as unknown as R[] }
      }
      return { rows: [] }
    },
  }
  return { client, calls }
}

function fakeResolver(resolution: EmailResolution | (() => Promise<EmailResolution>)): {
  resolver: ClerkResolver
  calls: string[]
} {
  const calls: string[] = []
  const fn = typeof resolution === 'function' ? resolution : async () => resolution
  return {
    resolver: {
      resolveEmailForClerkUser: vi.fn(async (id: string) => {
        calls.push(id)
        return fn()
      }),
      clearCache: vi.fn(),
    },
    calls,
  }
}

function buildDeps(
  client: NotificationDbClient,
  sendImpl?: ReturnType<typeof vi.fn>,
): {
  deps: DrainNotificationsDeps
  sendEmail: ReturnType<typeof vi.fn>
} {
  const sendEmail = sendImpl ?? vi.fn(async () => ({ provider: 'console' as const, ok: true as const }))
  const deps: DrainNotificationsDeps = {
    client,
    // Cast through unknown because vi.fn returns a generic mock.
    sendEmail: sendEmail as unknown as DrainNotificationsDeps['sendEmail'],
    logger: testLogger,
  }
  return { deps, sendEmail }
}

function buildConfig(
  resolver: ClerkResolver | null,
  overrides: Partial<DrainNotificationsConfig> = {},
): DrainNotificationsConfig {
  return {
    limit: 10,
    providerFailureThreshold: 3,
    maxAttempts: 5,
    emailConfig: baseEmailConfig,
    clerkResolver: resolver,
    ...overrides,
  }
}

describe('drainNotifications — Clerk hydration → send', () => {
  it('hydrates email, persists it, and sends', async () => {
    const row = makeRow({ id: 'r-hydrate', recipient_clerk_user_id: 'user_abc' })
    const { client, calls } = makeFakeClient([row])
    const { resolver } = fakeResolver({ kind: 'email', email: 'alice@example.com' })
    const { deps, sendEmail } = buildDeps(client)

    const result = await drainNotifications(deps, buildConfig(resolver))

    expect(result.processed).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.deferred).toBe(0)
    expect(result.hydrated).toBe(1)

    // Email was actually attempted with the hydrated address.
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const message = sendEmail.mock.calls[0]?.[0] as { to: string }
    expect(message.to).toBe('alice@example.com')

    // The row was patched with the hydrated email AND marked sent. Order:
    // claim → update recipient_email → send → mark sent.
    const updates = calls.filter((c) => c.sql.includes('update notifications'))
    expect(updates[0]?.sql).toContain('set recipient_email = $2')
    expect(updates[0]?.params).toEqual(['r-hydrate', 'alice@example.com'])
    expect(updates[1]?.sql).toContain("set status = 'sent'")
  })

  it('does not call Clerk when recipient_email is already populated', async () => {
    const row = makeRow({ recipient_email: 'pre@hydrated.com', recipient_clerk_user_id: null })
    const { client } = makeFakeClient([row])
    const resolver = fakeResolver({ kind: 'email', email: 'should-not-be-used@example.com' })
    const { deps, sendEmail } = buildDeps(client)

    const result = await drainNotifications(deps, buildConfig(resolver.resolver))

    expect(result.sent).toBe(1)
    expect(result.hydrated).toBe(0)
    expect(resolver.resolver.resolveEmailForClerkUser).not.toHaveBeenCalled()
    const sendCall = sendEmail.mock.calls[0]?.[0] as { to: string }
    expect(sendCall.to).toBe('pre@hydrated.com')
  })
})

describe('drainNotifications — Clerk 404 (user deleted)', () => {
  it('marks the notification failed with reason clerk_user_not_found and never sends', async () => {
    const row = makeRow({ id: 'r-deleted', attempt_count: 1 })
    const { client, calls } = makeFakeClient([row])
    const { resolver } = fakeResolver({ kind: 'not_found' })
    const { deps, sendEmail } = buildDeps(client)

    const result = await drainNotifications(deps, buildConfig(resolver))

    expect(result.processed).toBe(1)
    expect(result.sent).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.deferred).toBe(0)
    expect(sendEmail).not.toHaveBeenCalled()

    const updates = calls.filter((c) => c.sql.includes('update notifications'))
    expect(updates).toHaveLength(1)
    expect(updates[0]?.sql).toContain("set status = 'failed'")
    expect(updates[0]?.params).toEqual(['r-deleted', 2, 'clerk_user_not_found'])
  })
})

describe('drainNotifications — Clerk 429 (rate limited)', () => {
  it('leaves the notification pending, increments attempt_count, and does not send', async () => {
    const row = makeRow({ id: 'r-rl', attempt_count: 0 })
    const { client, calls } = makeFakeClient([row])
    const { resolver } = fakeResolver({ kind: 'rate_limited' })
    const { deps, sendEmail } = buildDeps(client)

    const result = await drainNotifications(deps, buildConfig(resolver))

    expect(result.processed).toBe(1)
    expect(result.deferred).toBe(1)
    expect(result.sent).toBe(0)
    expect(result.failed).toBe(0)
    expect(sendEmail).not.toHaveBeenCalled()

    const updates = calls.filter((c) => c.sql.includes('update notifications'))
    expect(updates).toHaveLength(1)
    // Stays 'pending', attempt_count incremented to 1, error reason recorded.
    expect(updates[0]?.sql).toContain("set status = 'pending'")
    const params = updates[0]?.params as unknown[]
    expect(params[0]).toBe('r-rl')
    expect(params[1]).toBe(1) // next attempt count
    expect(params[3]).toBe('clerk_rate_limited')
  })
})

describe('drainNotifications — Clerk unreachable', () => {
  it('defers when under maxAttempts and DLQs once the cap is reached', async () => {
    const rowEarly = makeRow({ id: 'r-net-1', attempt_count: 1 })
    const rowLate = makeRow({ id: 'r-net-2', attempt_count: 4 }) // next = 5 == maxAttempts
    const { client, calls } = makeFakeClient([rowEarly, rowLate])
    const { resolver } = fakeResolver({ kind: 'unreachable', error: new Error('ECONNRESET') })
    const { deps, sendEmail } = buildDeps(client)

    const result = await drainNotifications(deps, buildConfig(resolver))

    expect(result.processed).toBe(2)
    expect(result.deferred).toBe(1)
    expect(result.failed).toBe(1)
    expect(sendEmail).not.toHaveBeenCalled()

    const updates = calls.filter((c) => c.sql.includes('update notifications'))
    expect(updates).toHaveLength(2)
    expect(updates[0]?.sql).toContain("set status = 'pending'")
    expect((updates[0]?.params as unknown[])[3]).toMatch(/^clerk_unreachable/)
    expect(updates[1]?.sql).toContain("set status = 'failed'")
    expect((updates[1]?.params as unknown[])[2]).toBe('clerk_unreachable')
  })
})

describe('drainNotifications — broadcast / disabled resolver', () => {
  it('marks broadcast rows (no email, no clerk id) as sent without delivering', async () => {
    const row = makeRow({ recipient_clerk_user_id: null, recipient_email: null })
    const { client, calls } = makeFakeClient([row])
    const { deps, sendEmail } = buildDeps(client)

    const result = await drainNotifications(deps, buildConfig(null))

    expect(result.sent).toBe(1)
    expect(sendEmail).not.toHaveBeenCalled()
    const updates = calls.filter((c) => c.sql.includes('update notifications'))
    expect(updates[0]?.sql).toContain("set status = 'sent'")
  })

  it('defers (does NOT silently mark sent) when clerkResolver is null but row needs hydration', async () => {
    const row = makeRow({ recipient_clerk_user_id: 'user_x', recipient_email: null })
    const { client, calls } = makeFakeClient([row])
    const { deps, sendEmail } = buildDeps(client)

    const result = await drainNotifications(deps, buildConfig(null))

    expect(result.sent).toBe(0)
    expect(result.deferred).toBe(1)
    expect(sendEmail).not.toHaveBeenCalled()
    const updates = calls.filter((c) => c.sql.includes('update notifications'))
    expect(updates[0]?.sql).toContain("set status = 'pending'")
    expect((updates[0]?.params as unknown[])[3]).toBe('clerk_resolver_disabled')
  })
})
