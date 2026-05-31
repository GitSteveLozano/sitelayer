import { describe, it, expect } from 'vitest'
import {
  isHumanRentalBillingEvent,
  nextRentalBillingEvents,
  parseRentalBillingEventRequest,
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

  it('CANCEL_POST moves a wedged posting run to failed with the operator marker', () => {
    const posting = { state: 'posting' as const, state_version: 3, approved_by: 'office-user' }
    const failed = transitionRentalBillingWorkflow(posting, {
      type: 'CANCEL_POST',
      failed_at: '2026-04-29T10:05:00.000Z',
      error: 'Push canceled by office-user',
    })
    expect(failed).toMatchObject({
      state: 'failed',
      state_version: 4,
      failed_at: '2026-04-29T10:05:00.000Z',
      error: 'Push canceled by office-user',
      approved_by: 'office-user',
    })
  })

  it('CANCEL_POST is illegal from every non-posting state', () => {
    for (const state of ['generated', 'approved', 'failed', 'posted', 'voided'] as const) {
      expect(() =>
        transitionRentalBillingWorkflow(
          { state, state_version: 1 },
          { type: 'CANCEL_POST', failed_at: '2026-04-29T10:05:00.000Z', error: 'x' },
        ),
      ).toThrow('not allowed')
    }
  })

  it('CANCEL_POST → failed then RETRY_POST returns to approved (composes with existing affordances)', () => {
    const posting = { state: 'posting' as const, state_version: 3 }
    const failed = transitionRentalBillingWorkflow(posting, {
      type: 'CANCEL_POST',
      failed_at: '2026-04-29T10:05:00.000Z',
      error: 'canceled',
    })
    const retried = transitionRentalBillingWorkflow(failed, { type: 'RETRY_POST' })
    expect(retried).toMatchObject({ state: 'approved', error: null, failed_at: null })
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
  it('exposes the CANCEL_POST escape hatch from posting', () => {
    expect(nextRentalBillingEvents('posting').map((e) => e.type)).toEqual(['CANCEL_POST'])
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
    expect(isHumanRentalBillingEvent('CANCEL_POST')).toBe(true)
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

describe('parseRentalBillingEventRequest', () => {
  it('accepts a well-formed APPROVE request', () => {
    const result = parseRentalBillingEventRequest({ event: 'APPROVE', state_version: 1 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ event: 'APPROVE', state_version: 1 })
    }
  })
  it('accepts a well-formed CANCEL_POST request', () => {
    const result = parseRentalBillingEventRequest({ event: 'CANCEL_POST', state_version: 3 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ event: 'CANCEL_POST', state_version: 3 })
    }
  })
  it('accepts state_version as a numeric string from offline-replay paths', () => {
    const result = parseRentalBillingEventRequest({ event: 'POST_REQUESTED', state_version: '3' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.state_version).toBe(3)
    }
  })
  it('rejects worker-only POST_SUCCEEDED', () => {
    const result = parseRentalBillingEventRequest({ event: 'POST_SUCCEEDED', state_version: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/event/)
  })
  it('rejects unknown event types', () => {
    const result = parseRentalBillingEventRequest({ event: 'BOGUS', state_version: 1 })
    expect(result.ok).toBe(false)
  })
  it('rejects zero or negative state_version', () => {
    expect(parseRentalBillingEventRequest({ event: 'APPROVE', state_version: 0 }).ok).toBe(false)
    expect(parseRentalBillingEventRequest({ event: 'APPROVE', state_version: -1 }).ok).toBe(false)
  })
  it('rejects non-integer state_version', () => {
    expect(parseRentalBillingEventRequest({ event: 'APPROVE', state_version: 1.5 }).ok).toBe(false)
  })
  it('rejects missing fields', () => {
    expect(parseRentalBillingEventRequest({ event: 'APPROVE' }).ok).toBe(false)
    expect(parseRentalBillingEventRequest({ state_version: 1 }).ok).toBe(false)
    expect(parseRentalBillingEventRequest({}).ok).toBe(false)
  })
  it('handles non-object bodies safely', () => {
    expect(parseRentalBillingEventRequest(null).ok).toBe(false)
    expect(parseRentalBillingEventRequest(undefined).ok).toBe(false)
    expect(parseRentalBillingEventRequest('not an object').ok).toBe(false)
    expect(parseRentalBillingEventRequest(['array', 'is', 'not', 'object']).ok).toBe(false)
  })
})
