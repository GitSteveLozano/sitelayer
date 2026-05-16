import { describe, it, expect } from 'vitest'
import {
  RENTAL_REQUEST_APPROVAL_ALL_STATES,
  RENTAL_REQUEST_APPROVAL_TERMINAL_STATES,
  rentalRequestApprovalWorkflow,
  isHumanRentalRequestApprovalEvent,
  nextRentalRequestApprovalEvents,
  parseRentalRequestApprovalEventRequest,
  transitionRentalRequestApprovalWorkflow,
  type RentalRequestApprovalWorkflowSnapshot,
} from './rental-request-approval.js'

describe('transitionRentalRequestApprovalWorkflow', () => {
  it('pending → approved via APPROVE', () => {
    const pending: RentalRequestApprovalWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const approved = transitionRentalRequestApprovalWorkflow(pending, {
      type: 'APPROVE',
      approved_at: '2026-05-01T09:00:00.000Z',
      approved_by: 'office-user',
    })
    expect(approved).toMatchObject({
      state: 'approved',
      state_version: 2,
      approved_at: '2026-05-01T09:00:00.000Z',
      approved_by: 'office-user',
    })
  })

  it('pending → declined via DECLINE with reason', () => {
    const pending: RentalRequestApprovalWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const declined = transitionRentalRequestApprovalWorkflow(pending, {
      type: 'DECLINE',
      declined_at: '2026-05-01T09:00:00.000Z',
      declined_by: 'office-user',
      decline_reason: 'out of stock',
    })
    expect(declined).toMatchObject({
      state: 'declined',
      state_version: 2,
      decline_reason: 'out of stock',
    })
  })

  it('rejects re-approval of approved', () => {
    expect(() =>
      transitionRentalRequestApprovalWorkflow(
        { state: 'approved', state_version: 2 },
        { type: 'APPROVE', approved_at: 'x', approved_by: 'x' },
      ),
    ).toThrow(/illegal transition/)
  })

  it('rejects approve-after-decline', () => {
    expect(() =>
      transitionRentalRequestApprovalWorkflow(
        { state: 'declined', state_version: 2 },
        { type: 'APPROVE', approved_at: 'x', approved_by: 'x' },
      ),
    ).toThrow(/illegal transition/)
  })
})

describe('rentalRequestApproval registry + helpers', () => {
  it('exposes reducer + metadata', () => {
    expect(rentalRequestApprovalWorkflow.name).toBe('rental_request_approval')
    expect(rentalRequestApprovalWorkflow.initialState).toBe('pending')
    expect(rentalRequestApprovalWorkflow.terminalStates).toEqual(RENTAL_REQUEST_APPROVAL_TERMINAL_STATES)
    expect(rentalRequestApprovalWorkflow.allStates).toEqual(RENTAL_REQUEST_APPROVAL_ALL_STATES)
    expect(rentalRequestApprovalWorkflow.sideEffectTypes).toEqual(['create_rental_from_request'])
  })

  it('nextEvents returns APPROVE+DECLINE on pending and nothing on terminals', () => {
    expect(
      nextRentalRequestApprovalEvents('pending')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['APPROVE', 'DECLINE'])
    expect(nextRentalRequestApprovalEvents('approved')).toEqual([])
    expect(nextRentalRequestApprovalEvents('declined')).toEqual([])
  })

  it('partitions human events', () => {
    expect(isHumanRentalRequestApprovalEvent('APPROVE')).toBe(true)
    expect(isHumanRentalRequestApprovalEvent('DECLINE')).toBe(true)
    expect(isHumanRentalRequestApprovalEvent('FAKE')).toBe(false)
  })

  it('parses well-formed event bodies', () => {
    expect(parseRentalRequestApprovalEventRequest({ event: 'APPROVE', state_version: 1 }).ok).toBe(true)
    expect(
      parseRentalRequestApprovalEventRequest({ event: 'DECLINE', state_version: 1, decline_reason: 'no' }).ok,
    ).toBe(true)
  })

  it('rejects malformed bodies', () => {
    expect(parseRentalRequestApprovalEventRequest({ event: 'foo', state_version: 1 }).ok).toBe(false)
    expect(parseRentalRequestApprovalEventRequest({}).ok).toBe(false)
  })
})
