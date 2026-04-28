import { describe, it, expect } from 'vitest'
import {
  isHumanRentalBillingEvent,
  nextRentalBillingEvents,
  transitionRentalBillingWorkflow,
} from './rental-billing.js'

describe('transitionRentalBillingWorkflow', () => {
  it('walks the deterministic approval and posting path', () => {
    const generated = { state: 'generated' as const, state_version: 1 }
    const approved = transitionRentalBillingWorkflow(generated, {
      type: 'APPROVE',
      approved_at: '2026-04-26T12:00:00.000Z',
      approved_by: 'office-user',
    })
    expect(approved).toMatchObject({
      state: 'approved',
      state_version: 2,
      approved_by: 'office-user',
    })

    const posting = transitionRentalBillingWorkflow(approved, { type: 'POST_REQUESTED' })
    expect(posting).toMatchObject({ state: 'posting', state_version: 3 })

    const posted = transitionRentalBillingWorkflow(posting, {
      type: 'POST_SUCCEEDED',
      posted_at: '2026-04-26T12:01:00.000Z',
      qbo_invoice_id: 'qbo-123',
    })
    expect(posted).toMatchObject({
      state: 'posted',
      state_version: 4,
      qbo_invoice_id: 'qbo-123',
    })
  })

  it('supports failed QBO posting retry without losing approval metadata', () => {
    const approved = {
      state: 'approved' as const,
      state_version: 2,
      approved_at: '2026-04-26T12:00:00.000Z',
      approved_by: 'office-user',
    }
    const posting = transitionRentalBillingWorkflow(approved, { type: 'POST_REQUESTED' })
    const failed = transitionRentalBillingWorkflow(posting, {
      type: 'POST_FAILED',
      failed_at: '2026-04-26T12:01:00.000Z',
      error: 'rate limited',
    })
    const retryable = transitionRentalBillingWorkflow(failed, { type: 'RETRY_POST' })
    expect(retryable).toMatchObject({
      state: 'approved',
      approved_by: 'office-user',
      error: null,
      failed_at: null,
    })
  })

  it('rejects invalid transitions', () => {
    expect(() =>
      transitionRentalBillingWorkflow({ state: 'posted', state_version: 4 }, { type: 'POST_REQUESTED' }),
    ).toThrow('not allowed')
  })
})

describe('nextRentalBillingEvents', () => {
  it('exposes APPROVE and VOID from generated', () => {
    expect(
      nextRentalBillingEvents('generated')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['APPROVE', 'VOID'])
  })
  it('exposes POST_REQUESTED and VOID from approved', () => {
    expect(
      nextRentalBillingEvents('approved')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['POST_REQUESTED', 'VOID'])
  })
  it('exposes RETRY_POST and VOID from failed', () => {
    expect(
      nextRentalBillingEvents('failed')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['RETRY_POST', 'VOID'])
  })
  it('exposes nothing from posting (worker is acting)', () => {
    expect(nextRentalBillingEvents('posting')).toEqual([])
  })
  it('exposes nothing from posted/voided terminal states', () => {
    expect(nextRentalBillingEvents('posted')).toEqual([])
    expect(nextRentalBillingEvents('voided')).toEqual([])
  })
})

describe('isHumanRentalBillingEvent', () => {
  it('accepts every human event', () => {
    expect(isHumanRentalBillingEvent('APPROVE')).toBe(true)
    expect(isHumanRentalBillingEvent('POST_REQUESTED')).toBe(true)
    expect(isHumanRentalBillingEvent('RETRY_POST')).toBe(true)
    expect(isHumanRentalBillingEvent('VOID')).toBe(true)
  })
  it('rejects worker-only events', () => {
    expect(isHumanRentalBillingEvent('POST_SUCCEEDED')).toBe(false)
    expect(isHumanRentalBillingEvent('POST_FAILED')).toBe(false)
  })
  it('rejects garbage', () => {
    expect(isHumanRentalBillingEvent('garbage')).toBe(false)
  })
})
