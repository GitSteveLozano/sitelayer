import { describe, expect, it } from 'vitest'
import { agentFeedDeliveryTone, formatAgentFeedDeliveryHeadline, formatAgentFeedDeliverySummary } from './ops'
import type { OpsOnsiteDiagnosticAgentFeedDelivery } from '@/lib/api'

function delivery(overrides: Partial<OpsOnsiteDiagnosticAgentFeedDelivery> = {}): OpsOnsiteDiagnosticAgentFeedDelivery {
  return {
    action_key: 'dispatch_agent_review',
    audience: 'onsite-diagnostics',
    concern_ref: 'opsdiag:session-1:dispatch_agent_review',
    status: 'pending',
    queued_at: '2026-06-12T12:00:00.000Z',
    claimed_at: null,
    completed_at: null,
    callback_status: null,
    callback_error: null,
    stale: false,
    ...overrides,
  }
}

describe('MobileOps agent-feed delivery copy', () => {
  it('shows no-callback state for stale claimed onsite actions', () => {
    const state = delivery({
      status: 'claimed',
      claimed_at: '2026-06-12T12:05:00.000Z',
      stale: true,
    })

    expect(agentFeedDeliveryTone(state)).toBe('amber')
    expect(formatAgentFeedDeliveryHeadline(state)).toBe('Agent review delivery')
    expect(formatAgentFeedDeliverySummary(state, Date.parse('2026-06-12T12:25:00.000Z'))).toBe(
      'Claimed 20m ago · no callback',
    )
  })

  it('shows terminal callback state without rendering raw executor errors', () => {
    const state = delivery({
      action_key: 'route_support_packet',
      status: 'failed',
      completed_at: '2026-06-12T12:10:00.000Z',
      callback_status: 'failed',
      callback_error: 'stack trace with private details',
    })

    expect(agentFeedDeliveryTone(state)).toBe('red')
    expect(formatAgentFeedDeliveryHeadline(state)).toBe('Support packet delivery')
    expect(formatAgentFeedDeliverySummary(state, Date.parse('2026-06-12T12:12:00.000Z'))).toBe(
      'Failed 2m ago · callback error recorded',
    )
  })
})
