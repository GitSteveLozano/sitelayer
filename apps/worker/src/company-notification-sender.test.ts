import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  formatSenderFromHeader,
  resolveCompanyNotificationSender,
  resolveSender,
} from './company-notification-sender.js'

const ENV_FROM = 'noreply@sitelayer.sandolab.xyz'

// pg's `query` is a heavily-overloaded type; a narrow vitest fake doesn't satisfy
// it directly. The same `as unknown as` cast the rest of the suite uses bridges
// the fake to the consumer's Pick<Pool|PoolClient,'query'> param without widening
// the production type. Behavior + assertions run against the real mock.
function asExecutor(query: ReturnType<typeof vi.fn>): Pick<Pool | PoolClient, 'query'> {
  return { query } as unknown as Pick<Pool | PoolClient, 'query'>
}

describe('resolveSender (pure fallback truth table)', () => {
  it('falls back to the env sender when the company has no override (the default for every existing row)', () => {
    expect(resolveSender(null, ENV_FROM)).toEqual({ email: ENV_FROM, name: null, perCompany: false })
    expect(resolveSender({ notification_from_email: null, notification_from_name: null }, ENV_FROM)).toEqual({
      email: ENV_FROM,
      name: null,
      perCompany: false,
    })
  })

  it('uses the per-company email + name when set', () => {
    expect(
      resolveSender(
        { notification_from_email: 'noreply@acme.com', notification_from_name: 'Acme Construction' },
        ENV_FROM,
      ),
    ).toEqual({ email: 'noreply@acme.com', name: 'Acme Construction', perCompany: true })
  })

  it('treats a blank/whitespace override email as "cleared" and reverts to env', () => {
    expect(resolveSender({ notification_from_email: '   ', notification_from_name: 'Acme' }, ENV_FROM)).toEqual({
      email: ENV_FROM,
      name: null,
      perCompany: false,
    })
  })

  it('keeps the per-company email even when the name is blank', () => {
    expect(resolveSender({ notification_from_email: 'a@b.com', notification_from_name: '  ' }, ENV_FROM)).toEqual({
      email: 'a@b.com',
      name: null,
      perCompany: true,
    })
  })
})

describe('formatSenderFromHeader', () => {
  it('renders bare address without a name', () => {
    expect(formatSenderFromHeader({ email: 'a@b.com', name: null })).toBe('a@b.com')
    expect(formatSenderFromHeader({ email: 'a@b.com', name: '  ' })).toBe('a@b.com')
  })

  it('quotes the display name', () => {
    expect(formatSenderFromHeader({ email: 'a@b.com', name: 'Acme Construction' })).toBe(
      '"Acme Construction" <a@b.com>',
    )
  })

  it('escapes embedded quotes/backslashes (RFC 5322)', () => {
    expect(formatSenderFromHeader({ email: 'a@b.com', name: 'Bob "the" Builder' })).toBe(
      '"Bob \\"the\\" Builder" <a@b.com>',
    )
  })
})

describe('resolveCompanyNotificationSender (DB read)', () => {
  it('reads the per-company row and scopes the query by company id', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [{ notification_from_email: 'noreply@acme.com', notification_from_name: 'Acme' }],
    }))
    const sender = await resolveCompanyNotificationSender(asExecutor(query), 'company-a', ENV_FROM)
    expect(sender).toEqual({ email: 'noreply@acme.com', name: 'Acme', perCompany: true })
    expect(query).toHaveBeenCalledTimes(1)
    const [, params] = query.mock.calls[0]!
    expect(params).toEqual(['company-a'])
  })

  it('falls back to env when the company has no row', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [] as Array<{ notification_from_email: string | null; notification_from_name: string | null }>,
    }))
    const sender = await resolveCompanyNotificationSender(asExecutor(query), 'unknown', ENV_FROM)
    expect(sender).toEqual({ email: ENV_FROM, name: null, perCompany: false })
  })

  it('tolerates the pre-migration-150 schema (undefined_column 42703) and falls back to env', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => {
      throw Object.assign(new Error('column "notification_from_email" does not exist'), { code: '42703' })
    })
    const sender = await resolveCompanyNotificationSender(asExecutor(query), 'company-a', ENV_FROM)
    expect(sender).toEqual({ email: ENV_FROM, name: null, perCompany: false })
  })

  it('propagates non-column errors (does not swallow real DB failures)', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => {
      throw Object.assign(new Error('connection terminated'), { code: '57P01' })
    })
    await expect(resolveCompanyNotificationSender(asExecutor(query), 'company-a', ENV_FROM)).rejects.toThrow(
      'connection terminated',
    )
  })
})
