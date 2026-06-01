import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLE_PERMISSIONS } from '@sitelayer/domain'
import {
  ACTION_LABELS,
  ACTION_ORDER,
  BUILTIN_ROLE_LABELS,
  buildBuiltinMatrix,
  encodeGrants,
  type ExtraPowerState,
} from './roles-display'

describe('roles-display labels', () => {
  it('has a label for every one of the 9 named actions', () => {
    for (const action of ACTION_ORDER) {
      expect(ACTION_LABELS[action]).toBeTruthy()
    }
  })

  it('has a label for all five built-in bases', () => {
    expect(Object.keys(BUILTIN_ROLE_LABELS)).toEqual(['owner', 'estimator', 'foreman', 'crew', 'bookkeeper'])
  })
})

describe('buildBuiltinMatrix', () => {
  it('mirrors the domain contract exactly for the rendered columns', () => {
    const roles = ['owner', 'estimator', 'foreman', 'crew', 'bookkeeper'] as const
    const matrix = buildBuiltinMatrix([...roles])
    // One row per action, in canonical order.
    expect(matrix.map((r) => r.action)).toEqual([...ACTION_ORDER])
    for (const row of matrix) {
      for (const role of roles) {
        const expected = (BUILTIN_ROLE_PERMISSIONS[role] as readonly string[]).includes(row.action)
        expect(row.allowed[role]).toBe(expected)
      }
    }
  })

  it('owner holds every action; crew holds only universal-safety', () => {
    const matrix = buildBuiltinMatrix(['owner', 'crew'])
    for (const row of matrix) {
      expect(row.allowed.owner).toBe(true)
    }
    const crewActions = matrix.filter((r) => r.allowed.crew).map((r) => r.action)
    expect(crewActions.sort()).toEqual(['clock_in_out', 'flag_issue', 'stop_work'])
  })

  it('foreman does NOT hold edit_pricing_book (matrix-as-designed)', () => {
    const row = buildBuiltinMatrix(['foreman']).find((r) => r.action === 'edit_pricing_book')
    expect(row?.allowed.foreman).toBe(false)
  })
})

describe('encodeGrants', () => {
  it('encodes the auth_materials dollar input as integer cents', () => {
    const state: Record<string, ExtraPowerState> = {
      auth_materials: { on: true, dollars: '1000' },
    }
    expect(encodeGrants(state)).toEqual([{ action: 'auth_materials', constraints: { max_amount_cents: 100000 } }])
  })

  it('rounds fractional dollars to whole cents', () => {
    const state: Record<string, ExtraPowerState> = {
      auth_materials: { on: true, dollars: '12.34' },
    }
    expect(encodeGrants(state)).toEqual([{ action: 'auth_materials', constraints: { max_amount_cents: 1234 } }])
  })

  it('encodes the approve_time OT input as whole hours/week', () => {
    const state: Record<string, ExtraPowerState> = {
      approve_time: { on: true, otHours: '8' },
    }
    expect(encodeGrants(state)).toEqual([{ action: 'approve_time', constraints: { max_ot_hours_per_week: 8 } }])
  })

  it('treats a blank cap as an uncapped grant (constraints null)', () => {
    const state: Record<string, ExtraPowerState> = {
      auth_materials: { on: true, dollars: '' },
      approve_time: { on: true, otHours: '' },
    }
    expect(encodeGrants(state)).toEqual([
      { action: 'auth_materials', constraints: null },
      { action: 'approve_time', constraints: null },
    ])
  })

  it('omits actions that are toggled off', () => {
    const state: Record<string, ExtraPowerState> = {
      auth_materials: { on: false, dollars: '500' },
      edit_pricing_book: { on: true },
    }
    expect(encodeGrants(state)).toEqual([{ action: 'edit_pricing_book', constraints: null }])
  })

  it('emits grants in canonical action order regardless of insertion order', () => {
    const state: Record<string, ExtraPowerState> = {
      approve_time: { on: true, otHours: '6' },
      auth_materials: { on: true, dollars: '200' },
    }
    expect(encodeGrants(state).map((g) => g.action)).toEqual(['auth_materials', 'approve_time'])
  })

  it('throws on a negative dollar cap', () => {
    expect(() => encodeGrants({ auth_materials: { on: true, dollars: '-5' } })).toThrow(/non-negative/)
  })

  it('throws on a fractional OT-hours cap', () => {
    expect(() => encodeGrants({ approve_time: { on: true, otHours: '8.5' } })).toThrow(/whole number/)
  })
})
