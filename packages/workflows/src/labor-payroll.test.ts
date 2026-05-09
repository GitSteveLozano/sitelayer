import { describe, it, expect } from 'vitest'
import {
  isHumanLaborPayrollEvent,
  nextLaborPayrollEvents,
  parseLaborPayrollEventRequest,
  transitionLaborPayrollWorkflow,
} from './labor-payroll.js'

describe('transitionLaborPayrollWorkflow', () => {
  it('walks the deterministic approval and posting path', () => {
    const generated = { state: 'generated' as const, state_version: 1 }
    const approved = transitionLaborPayrollWorkflow(generated, {
      type: 'APPROVE',
      approved_at: '2026-04-26T12:00:00.000Z',
      approved_by: 'office-user',
    })
    expect(approved).toMatchObject({
      state: 'approved',
      state_version: 2,
      approved_by: 'office-user',
    })

    const posting = transitionLaborPayrollWorkflow(approved, { type: 'POST_REQUESTED' })
    expect(posting).toMatchObject({ state: 'posting', state_version: 3 })

    const posted = transitionLaborPayrollWorkflow(posting, {
      type: 'POST_SUCCEEDED',
      posted_at: '2026-04-26T12:01:00.000Z',
      qbo_timeactivity_ids: ['qbo-ta-1', 'qbo-ta-2', 'qbo-ta-3'],
    })
    expect(posted).toMatchObject({
      state: 'posted',
      state_version: 4,
      qbo_timeactivity_ids: ['qbo-ta-1', 'qbo-ta-2', 'qbo-ta-3'],
    })
  })

  it('supports failed QBO posting retry without losing approval metadata', () => {
    const approved = {
      state: 'approved' as const,
      state_version: 2,
      approved_at: '2026-04-26T12:00:00.000Z',
      approved_by: 'office-user',
    }
    const posting = transitionLaborPayrollWorkflow(approved, { type: 'POST_REQUESTED' })
    const failed = transitionLaborPayrollWorkflow(posting, {
      type: 'POST_FAILED',
      failed_at: '2026-04-26T12:01:00.000Z',
      error: 'rate limited',
    })
    const retryable = transitionLaborPayrollWorkflow(failed, { type: 'RETRY_POST' })
    expect(retryable).toMatchObject({
      state: 'approved',
      approved_by: 'office-user',
      error: null,
      failed_at: null,
    })
  })

  it('rejects invalid transitions', () => {
    expect(() =>
      transitionLaborPayrollWorkflow({ state: 'posted', state_version: 4 }, { type: 'POST_REQUESTED' }),
    ).toThrow('not allowed')
  })
})

describe('nextLaborPayrollEvents', () => {
  it('exposes APPROVE and VOID from generated', () => {
    expect(
      nextLaborPayrollEvents('generated')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['APPROVE', 'VOID'])
  })
  it('exposes POST_REQUESTED and VOID from approved', () => {
    expect(
      nextLaborPayrollEvents('approved')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['POST_REQUESTED', 'VOID'])
  })
  it('exposes RETRY_POST and VOID from failed', () => {
    expect(
      nextLaborPayrollEvents('failed')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['RETRY_POST', 'VOID'])
  })
  it('exposes nothing from posting (worker is acting)', () => {
    expect(nextLaborPayrollEvents('posting')).toEqual([])
  })
  it('exposes nothing from posted/voided terminal states', () => {
    expect(nextLaborPayrollEvents('posted')).toEqual([])
    expect(nextLaborPayrollEvents('voided')).toEqual([])
  })
})

describe('isHumanLaborPayrollEvent', () => {
  it('accepts every human event', () => {
    expect(isHumanLaborPayrollEvent('APPROVE')).toBe(true)
    expect(isHumanLaborPayrollEvent('POST_REQUESTED')).toBe(true)
    expect(isHumanLaborPayrollEvent('RETRY_POST')).toBe(true)
    expect(isHumanLaborPayrollEvent('VOID')).toBe(true)
  })
  it('rejects worker-only events', () => {
    expect(isHumanLaborPayrollEvent('POST_SUCCEEDED')).toBe(false)
    expect(isHumanLaborPayrollEvent('POST_FAILED')).toBe(false)
  })
  it('rejects garbage', () => {
    expect(isHumanLaborPayrollEvent('garbage')).toBe(false)
  })
})

describe('parseLaborPayrollEventRequest', () => {
  it('accepts a well-formed APPROVE request', () => {
    const result = parseLaborPayrollEventRequest({ event: 'APPROVE', state_version: 1 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ event: 'APPROVE', state_version: 1 })
    }
  })
  it('accepts state_version as a numeric string from offline-replay paths', () => {
    const result = parseLaborPayrollEventRequest({ event: 'POST_REQUESTED', state_version: '3' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.state_version).toBe(3)
    }
  })
  it('rejects worker-only POST_SUCCEEDED', () => {
    const result = parseLaborPayrollEventRequest({ event: 'POST_SUCCEEDED', state_version: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/event/)
  })
  it('rejects unknown event types', () => {
    const result = parseLaborPayrollEventRequest({ event: 'BOGUS', state_version: 1 })
    expect(result.ok).toBe(false)
  })
  it('rejects zero or negative state_version', () => {
    expect(parseLaborPayrollEventRequest({ event: 'APPROVE', state_version: 0 }).ok).toBe(false)
    expect(parseLaborPayrollEventRequest({ event: 'APPROVE', state_version: -1 }).ok).toBe(false)
  })
  it('rejects non-integer state_version', () => {
    expect(parseLaborPayrollEventRequest({ event: 'APPROVE', state_version: 1.5 }).ok).toBe(false)
  })
  it('rejects missing fields', () => {
    expect(parseLaborPayrollEventRequest({ event: 'APPROVE' }).ok).toBe(false)
    expect(parseLaborPayrollEventRequest({ state_version: 1 }).ok).toBe(false)
    expect(parseLaborPayrollEventRequest({}).ok).toBe(false)
  })
  it('handles non-object bodies safely', () => {
    expect(parseLaborPayrollEventRequest(null).ok).toBe(false)
    expect(parseLaborPayrollEventRequest(undefined).ok).toBe(false)
    expect(parseLaborPayrollEventRequest('not an object').ok).toBe(false)
    expect(parseLaborPayrollEventRequest(['array', 'is', 'not', 'object']).ok).toBe(false)
  })
})
