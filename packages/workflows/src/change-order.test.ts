import { describe, expect, it } from 'vitest'
import {
  isHumanChangeOrderEvent,
  nextChangeOrderEvents,
  parseChangeOrderEventRequest,
  transitionChangeOrderWorkflow,
  type ChangeOrderWorkflowSnapshot,
} from './change-order.js'

const at = '2026-05-28T12:00:00.000Z'
const draft = (): ChangeOrderWorkflowSnapshot => ({ state: 'draft', state_version: 1 })

describe('change_order workflow', () => {
  it('SEND draft → sent and stamps sent_at + bumps version', () => {
    const next = transitionChangeOrderWorkflow(draft(), { type: 'SEND', occurred_at: at })
    expect(next.state).toBe('sent')
    expect(next.state_version).toBe(2)
    expect(next.sent_at).toBe(at)
  })

  it('ACCEPT sent → accepted records approver', () => {
    const sent = transitionChangeOrderWorkflow(draft(), { type: 'SEND', occurred_at: at })
    const accepted = transitionChangeOrderWorkflow(sent, { type: 'ACCEPT', occurred_at: at, actor_user_id: 'u_1' })
    expect(accepted.state).toBe('accepted')
    expect(accepted.accepted_at).toBe(at)
    expect(accepted.approved_by).toBe('u_1')
  })

  it('REJECT sent → rejected captures reason', () => {
    const sent = transitionChangeOrderWorkflow(draft(), { type: 'SEND', occurred_at: at })
    const rejected = transitionChangeOrderWorkflow(sent, { type: 'REJECT', occurred_at: at, reason: 'over budget' })
    expect(rejected.state).toBe('rejected')
    expect(rejected.reject_reason).toBe('over budget')
  })

  it('VOID is allowed from draft and sent', () => {
    expect(transitionChangeOrderWorkflow(draft(), { type: 'VOID', occurred_at: at }).state).toBe('voided')
    const sent = transitionChangeOrderWorkflow(draft(), { type: 'SEND', occurred_at: at })
    expect(transitionChangeOrderWorkflow(sent, { type: 'VOID', occurred_at: at }).state).toBe('voided')
  })

  it('rejects illegal transitions (ACCEPT from draft, SEND from accepted)', () => {
    expect(() => transitionChangeOrderWorkflow(draft(), { type: 'ACCEPT', occurred_at: at })).toThrow(/illegal transition/)
    const accepted = transitionChangeOrderWorkflow(
      transitionChangeOrderWorkflow(draft(), { type: 'SEND', occurred_at: at }),
      { type: 'ACCEPT', occurred_at: at },
    )
    expect(() => transitionChangeOrderWorkflow(accepted, { type: 'SEND', occurred_at: at })).toThrow(/illegal transition/)
  })

  it('nextEvents reflects the state', () => {
    expect(nextChangeOrderEvents('draft').map((e) => e.type)).toEqual(['SEND', 'VOID'])
    expect(nextChangeOrderEvents('sent').map((e) => e.type)).toEqual(['ACCEPT', 'REJECT', 'VOID'])
    expect(nextChangeOrderEvents('accepted')).toEqual([])
  })

  it('all CO events are human events', () => {
    for (const e of ['SEND', 'ACCEPT', 'REJECT', 'VOID']) expect(isHumanChangeOrderEvent(e)).toBe(true)
    expect(isHumanChangeOrderEvent('NOPE')).toBe(false)
  })

  it('parses a valid event request and coerces string state_version', () => {
    const ok = parseChangeOrderEventRequest({ event: 'SEND', state_version: '3' })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.state_version).toBe(3)
    const bad = parseChangeOrderEventRequest({ event: 'NOPE', state_version: 1 })
    expect(bad.ok).toBe(false)
  })
})
