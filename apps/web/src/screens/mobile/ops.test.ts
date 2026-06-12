import { describe, expect, it } from 'vitest'
import {
  agentFeedDeliveryTone,
  buildFieldReadinessItems,
  formatAgentFeedDeliveryHeadline,
  formatAgentFeedDeliverySummary,
} from './ops'
import type {
  OpsDiagnosticComponent,
  OpsOnsiteDiagnosticAgentFeedDelivery,
  OpsOnsiteDiagnosticSessionPlan,
} from '@/lib/api'

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

function component(overrides: Partial<OpsDiagnosticComponent> = {}): OpsDiagnosticComponent {
  return {
    key: 'component',
    label: 'Component',
    status: 'ok',
    detail: 'Ready.',
    latency_ms: null,
    facts: {},
    ...overrides,
  }
}

function plan(overrides: Partial<OpsOnsiteDiagnosticSessionPlan> = {}): OpsOnsiteDiagnosticSessionPlan {
  return {
    status: 'ready',
    control_level: 'route',
    recommended_entry: 'dispatch_agent_review',
    can_capture_desktop: true,
    can_route_work: true,
    can_dispatch_agent_review: true,
    blockers: [],
    actions: [],
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

describe('MobileOps field readiness checklist', () => {
  it('marks the onsite route ready when capture and agent lanes are green', () => {
    const rows = buildFieldReadinessItems({
      online: true,
      hasDiagnosticControl: false,
      displayedDiagnosticSession: null,
      screenCapture: component({
        key: 'screen_capture',
        label: 'Screen Capture',
        facts: { recording: true },
      }),
      captureRouter: component({
        key: 'capture_router',
        label: 'Capture Router',
        facts: { sinks: 'agent,linear' },
      }),
      agentFeed: component({
        key: 'agent_feed',
        label: 'Agent Feed',
        facts: { audience_has_token: true },
      }),
      onsiteSession: plan(),
    })

    expect(rows.find((row) => row.key === 'phone-link')?.tone).toBe('green')
    expect(rows.find((row) => row.key === 'desktop-video')?.supporting).toBe('Recording confirmed.')
    expect(rows.find((row) => row.key === 'capture-route')?.supporting).toBe('2 sinks active.')
    expect(rows.find((row) => row.key === 'agent-lane')?.supporting).toBe('Agent review ready.')
  })

  it('keeps agent feed readiness separate from a blocked route', () => {
    const rows = buildFieldReadinessItems({
      online: false,
      hasDiagnosticControl: false,
      displayedDiagnosticSession: null,
      screenCapture: component({
        key: 'screen_capture',
        label: 'Screen Capture',
        status: 'degraded',
        detail: 'Screen recording is not confirmed.',
        facts: { recording: false },
      }),
      captureRouter: component({
        key: 'capture_router',
        label: 'Capture Router',
        status: 'degraded',
        detail: 'Capture router has no active sink.',
        facts: { sinks: null },
      }),
      agentFeed: component({
        key: 'agent_feed',
        label: 'Agent Feed',
        status: 'ok',
        facts: { audience_has_token: true },
      }),
      onsiteSession: plan({
        status: 'limited',
        control_level: 'observe',
        can_capture_desktop: false,
        can_route_work: false,
        can_dispatch_agent_review: false,
        blockers: ['Capture router has no active sink.'],
      }),
    })

    expect(rows.find((row) => row.key === 'phone-link')?.tone).toBe('amber')
    expect(rows.find((row) => row.key === 'desktop-video')?.tone).toBe('amber')
    expect(rows.find((row) => row.key === 'capture-route')?.supporting).toBe('Capture router has no active sink.')
    expect(rows.find((row) => row.key === 'agent-lane')?.tone).toBe('amber')
    expect(rows.find((row) => row.key === 'agent-lane')?.supporting).toBe('Agent feed ready; route still blocked.')
  })
})
