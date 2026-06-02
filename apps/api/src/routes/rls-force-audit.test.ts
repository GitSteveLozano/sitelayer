import { describe, expect, it } from 'vitest'

import {
  type CompanyTableRlsState,
  RLS_FORCE_AUDIT_ALLOWLIST,
  auditUnforcedCompanyTables,
  findUnforcedCompanyTables,
} from './rls-force-audit.js'

/**
 * Unit coverage for the forced-RLS gate logic. These run WITHOUT a database
 * (the deterministic unit stage), so the gate's pass/fail decision is covered
 * even when the integration stage's live-schema probe is skipped. The live
 * probe lives in rls-phase3-audit.test.ts.
 */

function row(partial: Partial<CompanyTableRlsState> & { table: string }): CompanyTableRlsState {
  return {
    enabled: true,
    forced: true,
    policyCount: 1,
    companyIdNullable: false,
    ...partial,
  }
}

describe('findUnforcedCompanyTables', () => {
  it('returns no findings when every company_id table is forced', () => {
    const rows = [row({ table: 'projects' }), row({ table: 'customers' }), row({ table: 'asset_deployments' })]
    expect(findUnforcedCompanyTables(rows)).toEqual([])
  })

  it('flags a NOT-NULL company_id table that is not forced and not allowlisted (the asset_deployments class)', () => {
    const rows = [
      row({ table: 'projects' }),
      row({ table: 'new_widget_table', forced: false, enabled: false, policyCount: 0 }),
    ]
    const findings = findUnforcedCompanyTables(rows)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.table).toBe('new_widget_table')
    expect(findings[0]?.reason).toMatch(/asset_deployments gap class/i)
  })

  it('does NOT flag an unforced table that is on the allowlist', () => {
    // mutation_outbox is ENABLE-not-FORCE by design (pg_dump owner exemption).
    const rows = [row({ table: 'mutation_outbox', forced: false, enabled: true })]
    expect(findUnforcedCompanyTables(rows)).toEqual([])
  })

  it('flags an unforced nullable-company_id table that is not allowlisted, with the nullable hint', () => {
    const rows = [row({ table: 'mystery_global', forced: false, companyIdNullable: true, policyCount: 0 })]
    const findings = findUnforcedCompanyTables(rows)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.companyIdNullable).toBe(true)
    expect(findings[0]?.reason).toMatch(/nullable/i)
  })

  it('honors a custom allowlist override', () => {
    const rows = [row({ table: 'temp_table', forced: false })]
    expect(findUnforcedCompanyTables(rows, { temp_table: 'allowed for this test' })).toEqual([])
    expect(findUnforcedCompanyTables(rows, {})).toHaveLength(1)
  })
})

describe('RLS_FORCE_AUDIT_ALLOWLIST', () => {
  it('documents every entry with a non-empty reason', () => {
    for (const [table, reason] of Object.entries(RLS_FORCE_AUDIT_ALLOWLIST)) {
      expect(reason, `allowlist entry ${table} must have a reason`).toBeTruthy()
    }
  })

  it('does NOT allowlist asset_deployments — migration 145 forces it, so the gate protects it', () => {
    expect(RLS_FORCE_AUDIT_ALLOWLIST).not.toHaveProperty('asset_deployments')
  })

  it('keeps the no-force append-only tables exempt (migration 078)', () => {
    for (const t of ['audit_events', 'mutation_outbox', 'sync_events', 'workflow_event_log']) {
      expect(RLS_FORCE_AUDIT_ALLOWLIST).toHaveProperty(t)
    }
  })
})

describe('auditUnforcedCompanyTables', () => {
  it('maps catalog rows (snake_case) and computes findings', async () => {
    const fakeRows = [
      { table: 'projects', enabled: true, forced: true, policy_count: 1, company_id_nullable: false },
      { table: 'leaky_table', enabled: false, forced: false, policy_count: 0, company_id_nullable: false },
    ]
    const { state, findings } = await auditUnforcedCompanyTables(async () => ({ rows: fakeRows }))
    expect(state).toHaveLength(2)
    expect(state.find((s) => s.table === 'projects')?.forced).toBe(true)
    expect(findings.map((f) => f.table)).toEqual(['leaky_table'])
  })
})
