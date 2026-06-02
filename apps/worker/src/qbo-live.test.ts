import { describe, expect, it } from 'vitest'
import { combineQboLive, globalKillSwitchOn, readCompanyQboLiveFlag, resolveCompanyQboLive } from './qbo-live.js'

/**
 * Per-company QBO-live gate. This is MONEY MOVEMENT: a wrong answer here
 * either silently drops a real customer's QBO sync (false-negative) or pushes
 * a fake/dry-run-only tenant to live QuickBooks (false-positive). The
 * contract under test:
 *
 *     live = globalKillSwitchOn AND companyFlagOn
 *
 * with DEFAULT dry-run for every company.
 */

// ---------------------------------------------------------------------------
// Pure AND-gate truth table. No DB, no env.
// ---------------------------------------------------------------------------
describe('combineQboLive — global kill switch AND per-company flag', () => {
  it('is live ONLY when both the global env and the company flag are on', () => {
    expect(combineQboLive(true, true)).toBe(true)
  })

  it('is dry-run when the global kill switch is off (regardless of company flag)', () => {
    expect(combineQboLive(false, true)).toBe(false)
    expect(combineQboLive(false, false)).toBe(false)
  })

  it('is dry-run when the company flag is off (regardless of global env)', () => {
    expect(combineQboLive(true, false)).toBe(false)
  })

  it('default posture (both off) is dry-run', () => {
    expect(combineQboLive(false, false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Global kill-switch reader — '1' means on; everything else (unset, '0',
// 'true', 'yes') means off. Matches the repo-wide convention.
// ---------------------------------------------------------------------------
describe('globalKillSwitchOn', () => {
  it('is on only for the exact string "1"', () => {
    expect(globalKillSwitchOn('X', { X: '1' })).toBe(true)
  })

  it('is off for unset / "0" / other truthy-looking strings', () => {
    expect(globalKillSwitchOn('X', {})).toBe(false)
    expect(globalKillSwitchOn('X', { X: '0' })).toBe(false)
    expect(globalKillSwitchOn('X', { X: 'true' })).toBe(false)
    expect(globalKillSwitchOn('X', { X: 'yes' })).toBe(false)
    expect(globalKillSwitchOn('X', { X: '' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// readCompanyQboLiveFlag against a fake pg client. Asserts the query is
// scoped to the company + provider='qbo' + not-deleted, and that the absence
// of a row (or qbo_live_enabled=false) resolves fail-safe to dry-run.
// ---------------------------------------------------------------------------
type FakeRow = { qbo_live_enabled: boolean }

function fakeClient(handler: (sql: string, params: unknown[]) => FakeRow[] | Error) {
  return {
    async query(sql: string, params: unknown[] = []) {
      const out = handler(sql, params)
      if (out instanceof Error) throw out
      return { rows: out, rowCount: out.length }
    },
  } as unknown as Parameters<typeof readCompanyQboLiveFlag>[0]
}

describe('readCompanyQboLiveFlag', () => {
  it('returns true when the company QBO connection has qbo_live_enabled=true', async () => {
    let sawSql = ''
    let sawParams: unknown[] = []
    const client = fakeClient((sql, params) => {
      sawSql = sql
      sawParams = params
      return [{ qbo_live_enabled: true }]
    })
    const result = await readCompanyQboLiveFlag(client, 'company-A')
    expect(result).toBe(true)
    // Scoped to the right company, provider, and excludes soft-deleted rows.
    expect(sawSql).toMatch(/integration_connections/i)
    expect(sawSql).toMatch(/provider\s*=\s*'qbo'/i)
    expect(sawSql).toMatch(/deleted_at\s+is\s+null/i)
    expect(sawParams).toEqual(['company-A'])
  })

  it('returns false (dry-run) when the company QBO connection has the flag off', async () => {
    const client = fakeClient(() => [{ qbo_live_enabled: false }])
    expect(await readCompanyQboLiveFlag(client, 'company-B')).toBe(false)
  })

  it('returns false (dry-run) when the company has NO QBO connection row', async () => {
    const client = fakeClient(() => [])
    expect(await readCompanyQboLiveFlag(client, 'company-new')).toBe(false)
  })

  it('tolerates the pre-migration schema (undefined_column 42703) → dry-run', async () => {
    const client = fakeClient(() => Object.assign(new Error('column does not exist'), { code: '42703' }))
    expect(await readCompanyQboLiveFlag(client, 'company-old-schema')).toBe(false)
  })

  it('propagates non-schema errors (does NOT silently go live or swallow real failures)', async () => {
    const client = fakeClient(() => Object.assign(new Error('connection reset'), { code: '08006' }))
    await expect(readCompanyQboLiveFlag(client, 'company-x')).rejects.toThrow(/connection reset/)
  })
})

// ---------------------------------------------------------------------------
// resolveCompanyQboLive — the full gate the push runners call. Proves the
// kill switch short-circuits BEFORE the DB read (so a global-off cluster
// never even looks at the per-company flag) and that both must agree.
// ---------------------------------------------------------------------------
describe('resolveCompanyQboLive — full per-company gate', () => {
  it('global env OFF → dry-run, and NEVER touches the DB (kill switch wins)', async () => {
    let queried = false
    const client = fakeClient(() => {
      queried = true
      return [{ qbo_live_enabled: true }]
    })
    const result = await resolveCompanyQboLive(client, 'company-A', 'QBO_X', { QBO_X: '0' })
    expect(result).toBe(false)
    expect(queried).toBe(false)
  })

  it('global env ON + company flag ON → live', async () => {
    const client = fakeClient(() => [{ qbo_live_enabled: true }])
    expect(await resolveCompanyQboLive(client, 'company-A', 'QBO_X', { QBO_X: '1' })).toBe(true)
  })

  it('global env ON + company flag OFF → dry-run', async () => {
    const client = fakeClient(() => [{ qbo_live_enabled: false }])
    expect(await resolveCompanyQboLive(client, 'company-B', 'QBO_X', { QBO_X: '1' })).toBe(false)
  })

  it('global env ON + no connection row → dry-run (fail-safe default)', async () => {
    const client = fakeClient(() => [])
    expect(await resolveCompanyQboLive(client, 'company-new', 'QBO_X', { QBO_X: '1' })).toBe(false)
  })
})
