import { describe, expect, it } from 'vitest'
import {
  agentFeedDeliveryTone,
  buildFieldReadinessItems,
  buildLeaveBehindCaptureInviteInput,
  canOpenDesktopEvidence,
  desktopEvidenceTone,
  formatAgentFeedDeliveryHeadline,
  formatAgentFeedDeliverySummary,
  formatDesktopEvidenceSummary,
  resolveLatestDesktopEvidence,
} from './ops'
import type {
  OpsDiagnosticComponent,
  OpsOnsiteDiagnosticAgentFeedDelivery,
  OpsOnsiteDiagnosticDesktopEvidenceResult,
  OpsOnsiteDiagnosticSessionActionResponse,
  OpsOnsiteDiagnosticSessionRecord,
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

function desktopEvidence(
  overrides: Partial<OpsOnsiteDiagnosticDesktopEvidenceResult> = {},
): OpsOnsiteDiagnosticDesktopEvidenceResult {
  return {
    capture_session_id: 'capture-session-1',
    artifact_id: 'artifact-1',
    storage_key: 'company-1/capture-sessions/capture-session-1/clip.mp4',
    file_path: '/api/capture-sessions/capture-session-1/artifacts/artifact-1/file',
    status: 'attached',
    content_type: 'video/mp4',
    byte_size: 1_572_864,
    error: null,
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

function session(overrides: Partial<OpsOnsiteDiagnosticSessionRecord> = {}): OpsOnsiteDiagnosticSessionRecord {
  return {
    id: 'diag-session-1',
    state: 'active',
    created_at: '2026-06-12T12:00:00.000Z',
    expires_at: '2026-06-12T13:00:00.000Z',
    operator_user_id: 'user_42',
    label: 'Mobile ops',
    intent: 'capture_desktop_context',
    plan: plan(),
    audit_events: [],
    agent_feed_deliveries: [],
    ...overrides,
  }
}

function actionResponse(
  overrides: Partial<OpsOnsiteDiagnosticSessionActionResponse['accepted_action']> = {},
): OpsOnsiteDiagnosticSessionActionResponse {
  return {
    schema: 'sitelayer.ops_diagnostic_session_action.v1',
    session: session(),
    accepted_action: {
      key: 'capture_desktop_context',
      effect: 'audit_only',
      ...overrides,
    },
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

describe('MobileOps desktop evidence copy', () => {
  it('shows whether a desktop evidence clip attached', () => {
    const attached = desktopEvidence()
    expect(desktopEvidenceTone(attached)).toBe('green')
    expect(canOpenDesktopEvidence(attached)).toBe(true)
    expect(formatDesktopEvidenceSummary(attached)).toBe('Attached 1.5 MB clip. Tap to open.')

    const notConfigured = desktopEvidence({ status: 'not_configured', byte_size: null, file_path: null })
    expect(canOpenDesktopEvidence(notConfigured)).toBe(false)
    expect(desktopEvidenceTone(notConfigured)).toBe('amber')
    expect(formatDesktopEvidenceSummary(desktopEvidence({ status: 'failed', error: 'screen capture timeout' }))).toBe(
      'Attach failed: screen capture timeout',
    )
  })

  it('falls back to rehydrated session desktop evidence after refresh', () => {
    const persisted = desktopEvidence({ artifact_id: 'persisted-artifact' })
    const fresh = desktopEvidence({ artifact_id: 'fresh-artifact' })

    expect(resolveLatestDesktopEvidence(null, session({ desktop_evidence: persisted }))?.artifact_id).toBe(
      'persisted-artifact',
    )
    expect(
      resolveLatestDesktopEvidence(
        actionResponse({
          desktop_evidence: fresh,
        }),
        session({ desktop_evidence: persisted }),
      )?.artifact_id,
    ).toBe('fresh-artifact')
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

describe('MobileOps leave-behind capture invite', () => {
  it('builds a signed guest-capture invite without diagnostic control credentials', () => {
    const payload = buildLeaveBehindCaptureInviteInput({
      companySlug: 'acme',
      session: session({
        id: 'diag-session-9',
        state: 'active',
        plan: plan({ control_level: 'route' }),
      }),
    })

    expect(payload).toMatchObject({
      reviewer_ref: 'onsite-worker',
      source: 'mobile_ops_leavebehind',
      target_route: '/ops',
      expires_in_days: 7,
      allowed_capture_modes: ['text', 'audio', 'state', 'screen'],
      metadata: {
        created_from: 'mobile_ops',
        company_slug: 'acme',
        ops_diagnostic_session_id: 'diag-session-9',
        ops_diagnostic_control_level: 'route',
        ops_diagnostic_state: 'active',
      },
    })
    expect(JSON.stringify(payload)).not.toContain('control_token')
  })
})
