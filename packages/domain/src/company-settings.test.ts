import { describe, it, expect } from 'vitest'
import {
  getCompanySetting,
  setCompanySetting,
  deleteCompanySetting,
  listCompanySettings,
  getQboLiveEnabled,
  getNotificationFrom,
  LEGACY_COLUMN_SETTING_KEYS,
  type SettingsExecutor,
} from './company-settings.js'

/**
 * Unit coverage for the per-company settings helper (no DB). A fake executor
 * stands in for the pg client so the read/write/default-fallback/company-scoping
 * logic is exercised deterministically. The real-Postgres RLS isolation +
 * force-audit coverage lives in apps/api/src/routes/company-settings.test.ts
 * (gated on a non-BYPASSRLS role).
 */

type Row = { company_id: string; key: string; value: unknown }

/**
 * In-memory company_settings store with a pg-shaped `query`. It pattern-matches
 * the small set of statements the helper issues — enough to assert the helper's
 * behavior including the (company_id, key) scoping and the upsert semantics.
 */
function makeFakeExecutor(seed: Row[] = []): SettingsExecutor & {
  rows: Row[]
  errorOnce?: { code: string }
} {
  const store: Row[] = [...seed]
  const exec: SettingsExecutor & { rows: Row[]; errorOnce?: { code: string } } = {
    rows: store,
    async query<R extends Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []) {
      if (exec.errorOnce) {
        const e = exec.errorOnce
        delete exec.errorOnce
        throw Object.assign(new Error('injected'), e)
      }
      const sql = text.trim().toLowerCase()
      if (sql.startsWith('select value from company_settings')) {
        const [companyId, key] = params as [string, string]
        const hit = store.find((r) => r.company_id === companyId && r.key === key)
        return { rows: (hit ? [{ value: hit.value }] : []) as unknown as R[] }
      }
      if (sql.startsWith('select key, value from company_settings')) {
        const [companyId] = params as [string]
        return {
          rows: store
            .filter((r) => r.company_id === companyId)
            .sort((a, b) => a.key.localeCompare(b.key))
            .map((r) => ({ key: r.key, value: r.value })) as unknown as R[],
        }
      }
      if (sql.startsWith('insert into company_settings')) {
        const [companyId, key, valueJson] = params as [string, string, string]
        const value = JSON.parse(valueJson)
        const existing = store.find((r) => r.company_id === companyId && r.key === key)
        if (existing) existing.value = value
        else store.push({ company_id: companyId, key, value })
        return { rows: [] as unknown as R[] }
      }
      if (sql.startsWith('delete from company_settings')) {
        const [companyId, key] = params as [string, string]
        const idx = store.findIndex((r) => r.company_id === companyId && r.key === key)
        if (idx >= 0) {
          store.splice(idx, 1)
          return { rows: [{ id: 'x' }] as unknown as R[] }
        }
        return { rows: [] as unknown as R[] }
      }
      throw new Error(`fake executor: unhandled SQL: ${text}`)
    },
  }
  return exec
}

const COMPANY_A = '11111111-1111-1111-1111-111111111111'
const COMPANY_B = '22222222-2222-2222-2222-222222222222'

describe('getCompanySetting / setCompanySetting', () => {
  it('round-trips a boolean value', async () => {
    const ex = makeFakeExecutor()
    expect(await getCompanySetting(ex, COMPANY_A, 'notifications.digest_enabled', false)).toBe(false)
    await setCompanySetting(ex, COMPANY_A, 'notifications.digest_enabled', true)
    expect(await getCompanySetting(ex, COMPANY_A, 'notifications.digest_enabled', false)).toBe(true)
  })

  it('round-trips a number and a string', async () => {
    const ex = makeFakeExecutor()
    await setCompanySetting(ex, COMPANY_A, 'billing.auto_invoice_cap', 5000)
    expect(await getCompanySetting(ex, COMPANY_A, 'billing.auto_invoice_cap', 0)).toBe(5000)
    await setCompanySetting(ex, COMPANY_A, 'branding.accent', '#0a0')
    expect(await getCompanySetting(ex, COMPANY_A, 'branding.accent', '#fff')).toBe('#0a0')
  })

  it('round-trips an object value', async () => {
    const ex = makeFakeExecutor()
    await setCompanySetting(ex, COMPANY_A, 'limits', { seats: 10, projects: 50 })
    expect(await getCompanySetting<Record<string, unknown>>(ex, COMPANY_A, 'limits', {})).toEqual({
      seats: 10,
      projects: 50,
    })
  })

  it('overwrites an existing value (upsert, not duplicate)', async () => {
    const ex = makeFakeExecutor()
    await setCompanySetting(ex, COMPANY_A, 'k', 1)
    await setCompanySetting(ex, COMPANY_A, 'k', 2)
    expect(ex.rows.filter((r) => r.company_id === COMPANY_A && r.key === 'k')).toHaveLength(1)
    expect(await getCompanySetting(ex, COMPANY_A, 'k', 0)).toBe(2)
  })
})

describe('default-fallback', () => {
  it('returns the call-site default when the row is absent', async () => {
    const ex = makeFakeExecutor()
    expect(await getCompanySetting(ex, COMPANY_A, 'missing', 'fallback')).toBe('fallback')
    expect(await getCompanySetting(ex, COMPANY_A, 'missing', 42)).toBe(42)
  })

  it('falls back to the default when the stored value type mismatches the default', async () => {
    // A legacy/corrupt row stores a string where the call site expects a bool.
    const ex = makeFakeExecutor([{ company_id: COMPANY_A, key: 'flag', value: 'not-a-bool' }])
    expect(await getCompanySetting(ex, COMPANY_A, 'flag', false)).toBe(false)
    // An array default must not accept an object row and vice-versa.
    const ex2 = makeFakeExecutor([{ company_id: COMPANY_A, key: 'arr', value: { not: 'array' } }])
    expect(await getCompanySetting<unknown[]>(ex2, COMPANY_A, 'arr', [])).toEqual([])
    const ex3 = makeFakeExecutor([{ company_id: COMPANY_A, key: 'obj', value: [1, 2] }])
    expect(await getCompanySetting<Record<string, unknown>>(ex3, COMPANY_A, 'obj', {})).toEqual({})
  })

  it('returns the default (does not throw) when the table is missing (42P01)', async () => {
    const ex = makeFakeExecutor()
    ex.errorOnce = { code: '42P01' }
    expect(await getCompanySetting(ex, COMPANY_A, 'k', 'def')).toBe('def')
  })

  it('propagates a non-undefined-table DB error on read', async () => {
    const ex = makeFakeExecutor()
    ex.errorOnce = { code: '08006' } // connection failure
    await expect(getCompanySetting(ex, COMPANY_A, 'k', 'def')).rejects.toThrow()
  })
})

describe('company-scoping (A cannot read B)', () => {
  it('a setting written for company A is not visible to company B', async () => {
    const ex = makeFakeExecutor()
    await setCompanySetting(ex, COMPANY_A, 'secret', 'A-only')
    // B reads the SAME key → gets its own default, never A's value.
    expect(await getCompanySetting(ex, COMPANY_B, 'secret', 'B-default')).toBe('B-default')
    // A still sees its own.
    expect(await getCompanySetting(ex, COMPANY_A, 'secret', 'B-default')).toBe('A-only')
  })

  it('listCompanySettings returns ONLY the requesting company rows', async () => {
    const ex = makeFakeExecutor()
    await setCompanySetting(ex, COMPANY_A, 'a1', 1)
    await setCompanySetting(ex, COMPANY_A, 'a2', 2)
    await setCompanySetting(ex, COMPANY_B, 'b1', 9)
    expect(await listCompanySettings(ex, COMPANY_A)).toEqual({ a1: 1, a2: 2 })
    expect(await listCompanySettings(ex, COMPANY_B)).toEqual({ b1: 9 })
  })

  it('every helper SQL statement carries a company_id predicate', async () => {
    // Spy on the statements the helper issues and assert each filters by
    // company_id ($1) — the app-layer half of the isolation that holds even
    // where the DB role BYPASSes RLS.
    const seen: string[] = []
    const spy: SettingsExecutor = {
      async query<R extends Record<string, unknown>>(text: string) {
        seen.push(text.trim().toLowerCase())
        return { rows: [] as unknown as R[] }
      },
    }
    await getCompanySetting(spy, COMPANY_A, 'k', 0)
    await setCompanySetting(spy, COMPANY_A, 'k', 1)
    await deleteCompanySetting(spy, COMPANY_A, 'k')
    await listCompanySettings(spy, COMPANY_A)
    for (const sql of seen) {
      expect(sql, `statement must scope by company_id: ${sql}`).toMatch(/company_id/)
    }
  })
})

describe('deleteCompanySetting', () => {
  it('removes a row and reports whether it existed', async () => {
    const ex = makeFakeExecutor()
    await setCompanySetting(ex, COMPANY_A, 'k', 1)
    expect(await deleteCompanySetting(ex, COMPANY_A, 'k')).toBe(true)
    expect(await deleteCompanySetting(ex, COMPANY_A, 'k')).toBe(false)
    expect(await getCompanySetting(ex, COMPANY_A, 'k', 0)).toBe(0)
  })

  it('tolerates the missing table (returns false)', async () => {
    const ex = makeFakeExecutor()
    ex.errorOnce = { code: '42P01' }
    expect(await deleteCompanySetting(ex, COMPANY_A, 'k')).toBe(false)
  })
})

describe('read-through for the two pre-existing per-company columns', () => {
  it('getQboLiveEnabled reads integration_connections.qbo_live_enabled (fail-safe false)', async () => {
    const ex: SettingsExecutor = {
      async query<R extends Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []) {
        expect(text.toLowerCase()).toContain('integration_connections')
        expect(text.toLowerCase()).toContain('company_id = $1')
        expect(params[0]).toBe(COMPANY_A)
        return { rows: [{ qbo_live_enabled: true }] as unknown as R[] }
      },
    }
    expect(await getQboLiveEnabled(ex, COMPANY_A)).toBe(true)
  })

  it('getQboLiveEnabled returns false when there is no qbo connection row', async () => {
    const ex: SettingsExecutor = {
      async query<R extends Record<string, unknown>>() {
        return { rows: [] as unknown as R[] }
      },
    }
    expect(await getQboLiveEnabled(ex, COMPANY_A)).toBe(false)
  })

  it('getQboLiveEnabled is fail-safe false when the column predates migration 144 (42703)', async () => {
    const ex: SettingsExecutor = {
      async query<R extends Record<string, unknown>>(): Promise<{ rows: R[] }> {
        throw Object.assign(new Error('undefined_column'), { code: '42703' })
      },
    }
    expect(await getQboLiveEnabled(ex, COMPANY_A)).toBe(false)
  })

  it('getNotificationFrom reads the companies columns, null when unset', async () => {
    const ex: SettingsExecutor = {
      async query<R extends Record<string, unknown>>() {
        return {
          rows: [{ notification_from_email: 'hi@acme.com', notification_from_name: 'Acme' }] as unknown as R[],
        }
      },
    }
    expect(await getNotificationFrom(ex, COMPANY_A)).toEqual({ email: 'hi@acme.com', name: 'Acme' })
    const empty: SettingsExecutor = {
      async query<R extends Record<string, unknown>>() {
        return { rows: [{ notification_from_email: null, notification_from_name: null }] as unknown as R[] }
      },
    }
    expect(await getNotificationFrom(empty, COMPANY_A)).toEqual({ email: null, name: null })
  })

  it('exposes canonical keys for the legacy columns', () => {
    expect(LEGACY_COLUMN_SETTING_KEYS.qboLiveEnabled).toBe('integrations.qbo.live_enabled')
    expect(LEGACY_COLUMN_SETTING_KEYS.notificationFromEmail).toBe('notifications.from_email')
    expect(LEGACY_COLUMN_SETTING_KEYS.notificationFromName).toBe('notifications.from_name')
  })
})
