import { describe, expect, it } from 'vitest'
import {
  ESTIMATE_SHARE_ALL_STATES,
  ESTIMATE_SHARE_TERMINAL_STATES,
  estimateShareWorkflow,
  isHumanEstimateShareEvent,
  nextEstimateShareEvents,
  parseEstimateShareEventRequest,
  transitionEstimateShareWorkflow,
  type EstimateShareWorkflowSnapshot,
} from './estimate-share.js'

const sent: EstimateShareWorkflowSnapshot = {
  state: 'sent',
  state_version: 1,
  recipient_email: 'client@example.com',
  sent_at: '2026-05-01T09:00:00.000Z',
  view_count: 0,
}

describe('estimate-share reducer', () => {
  it('VIEW: sent → viewed, stamps viewed_at + bumps view_count', () => {
    const next = transitionEstimateShareWorkflow(sent, { type: 'VIEW', viewed_at: '2026-05-01T10:00:00.000Z' })
    expect(next.state).toBe('viewed')
    expect(next.state_version).toBe(2)
    expect(next.viewed_at).toBe('2026-05-01T10:00:00.000Z')
    expect(next.view_count).toBe(1)
  })

  it('VIEW is idempotent from viewed: preserves first viewed_at, bumps count', () => {
    const viewed = transitionEstimateShareWorkflow(sent, { type: 'VIEW', viewed_at: '2026-05-01T10:00:00.000Z' })
    const again = transitionEstimateShareWorkflow(viewed, { type: 'VIEW', viewed_at: '2026-05-02T10:00:00.000Z' })
    expect(again.state).toBe('viewed')
    expect(again.viewed_at).toBe('2026-05-01T10:00:00.000Z')
    expect(again.view_count).toBe(2)
  })

  it('ACCEPT: sent → accepted with signer + accepted_at', () => {
    const next = transitionEstimateShareWorkflow(sent, {
      type: 'ACCEPT',
      accepted_at: '2026-05-01T11:00:00.000Z',
      signer_name: 'Jane Client',
      signature_data_url: 'data:image/png;base64,xxx',
      signer_ip: '203.0.113.7',
    })
    expect(next.state).toBe('accepted')
    expect(next.signer_name).toBe('Jane Client')
    expect(next.accepted_at).toBe('2026-05-01T11:00:00.000Z')
  })

  it('ACCEPT also allowed from viewed', () => {
    const viewed = transitionEstimateShareWorkflow(sent, { type: 'VIEW', viewed_at: '2026-05-01T10:00:00.000Z' })
    const next = transitionEstimateShareWorkflow(viewed, {
      type: 'ACCEPT',
      accepted_at: '2026-05-01T11:00:00.000Z',
      signer_name: 'Jane',
    })
    expect(next.state).toBe('accepted')
  })

  it('DECLINE: sent → declined with reason', () => {
    const next = transitionEstimateShareWorkflow(sent, {
      type: 'DECLINE',
      declined_at: '2026-05-01T11:00:00.000Z',
      decline_reason: 'too expensive',
    })
    expect(next.state).toBe('declined')
    expect(next.decline_reason).toBe('too expensive')
  })

  it('EXPIRE: sent → expired (clock supplied as payload)', () => {
    const next = transitionEstimateShareWorkflow(sent, { type: 'EXPIRE', expired_at: '2026-06-01T00:00:00.000Z' })
    expect(next.state).toBe('expired')
  })

  it('REVOKE: viewed → revoked with revoked_by', () => {
    const viewed = transitionEstimateShareWorkflow(sent, { type: 'VIEW', viewed_at: '2026-05-01T10:00:00.000Z' })
    const next = transitionEstimateShareWorkflow(viewed, {
      type: 'REVOKE',
      revoked_at: '2026-05-01T12:00:00.000Z',
      revoked_by: 'estimator-1',
    })
    expect(next.state).toBe('revoked')
    expect(next.revoked_at).toBe('2026-05-01T12:00:00.000Z')
  })

  it('re-ACCEPT from a terminal state throws (mirrors portal already_accepted)', () => {
    const accepted = transitionEstimateShareWorkflow(sent, {
      type: 'ACCEPT',
      accepted_at: '2026-05-01T11:00:00.000Z',
      signer_name: 'Jane',
    })
    expect(() =>
      transitionEstimateShareWorkflow(accepted, {
        type: 'ACCEPT',
        accepted_at: '2026-05-01T12:00:00.000Z',
        signer_name: 'Jane',
      }),
    ).toThrow(/not allowed from estimate share state accepted/)
  })

  it('every terminal state rejects every event', () => {
    for (const state of ESTIMATE_SHARE_TERMINAL_STATES) {
      expect(() =>
        transitionEstimateShareWorkflow({ state, state_version: 3 }, { type: 'VIEW', viewed_at: 'x' }),
      ).toThrow()
    }
  })

  it('only REVOKE is a human event; VIEW/ACCEPT/DECLINE/EXPIRE are not', () => {
    expect(isHumanEstimateShareEvent('REVOKE')).toBe(true)
    for (const e of ['VIEW', 'ACCEPT', 'DECLINE', 'EXPIRE']) {
      expect(isHumanEstimateShareEvent(e)).toBe(false)
    }
  })

  it('nextEvents surfaces only REVOKE for live states, [] for terminal', () => {
    expect(nextEstimateShareEvents('sent').map((e) => e.type)).toEqual(['REVOKE'])
    expect(nextEstimateShareEvents('viewed').map((e) => e.type)).toEqual(['REVOKE'])
    for (const state of ESTIMATE_SHARE_TERMINAL_STATES) {
      expect(nextEstimateShareEvents(state)).toEqual([])
    }
  })

  it('is registered with the expected descriptor', () => {
    expect(estimateShareWorkflow.name).toBe('estimate_share')
    expect(estimateShareWorkflow.initialState).toBe('sent')
    expect([...estimateShareWorkflow.allStates]).toEqual([...ESTIMATE_SHARE_ALL_STATES])
    expect([...estimateShareWorkflow.sideEffectTypes]).toEqual(['send_estimate_share'])
  })

  it('event request schema accepts REVOKE, rejects client/worker events', () => {
    expect(parseEstimateShareEventRequest({ event: 'REVOKE', state_version: 2 }).ok).toBe(true)
    expect(parseEstimateShareEventRequest({ event: 'ACCEPT', state_version: 2 }).ok).toBe(false)
    expect(parseEstimateShareEventRequest({ event: 'REVOKE' }).ok).toBe(false)
  })
})
