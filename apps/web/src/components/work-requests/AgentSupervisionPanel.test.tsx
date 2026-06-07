import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextHandoffEvent, ContextWorkItem } from '@/lib/api'
import {
  extractReplayAnchors,
  extractReplayTimeline,
  isAwaitingReview,
  latestAgentCallback,
} from '@/lib/agent-supervision'
import { AgentSupervisionPanel } from './AgentSupervisionPanel'

afterEach(cleanup)

function makeWorkItem(overrides: Partial<ContextWorkItem> = {}): ContextWorkItem {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    support_packet_id: '00000000-0000-4000-8000-000000000002',
    title: 'Estimate push failed',
    summary: 'Customer could not send an estimate.',
    status: 'review_ready',
    lane: 'both',
    severity: 'high',
    route: '/financial/estimate-pushes/ep-1',
    entity_type: 'estimate_push',
    entity_id: 'ep-1',
    assignee_user_id: null,
    created_by_user_id: 'creator-1',
    created_at: '2026-05-21T12:00:00.000Z',
    updated_at: '2026-05-21T12:05:00.000Z',
    resolved_at: null,
    reversed_at: null,
    reversibility_window_seconds: 21600,
    expires_at: '2026-05-21T18:00:00.000Z',
    metadata: {},
    ...overrides,
  }
}

function makeEvent(overrides: Partial<ContextHandoffEvent>): ContextHandoffEvent {
  return {
    id: 'evt-1',
    company_id: 'company-1',
    work_item_id: '00000000-0000-4000-8000-000000000001',
    event_type: 'agent.proposal_ready',
    actor_kind: 'agent',
    actor_user_id: null,
    actor_ref: 'mesh',
    source_system: 'mesh',
    payload: {},
    metadata: {},
    idempotency_key: null,
    causation_event_id: null,
    correlation_id: null,
    request_id: null,
    sentry_trace: null,
    sentry_baggage: null,
    build_sha: null,
    redaction_version: 'context-handoff-v1',
    occurred_at: '2026-05-21T12:06:00.000Z',
    recorded_at: '2026-05-21T12:06:00.000Z',
    ...overrides,
  }
}

const serverContextWithDivergence = {
  anchors: [
    {
      event_ref: 'workflow_event:estimate_push:abcd1234:3',
      workflow_name: 'estimate_push',
      entity_type: 'estimate_push',
      entity_id: 'ep-1',
      state_version: 3,
      event_type: 'POST_FAILED',
      from_state: 'posting',
      to_state: 'failed',
      applied_at: '2026-05-21T12:05:30.000Z',
      replay_ok: false,
      replay_available: true,
      first_divergence: { reason: 'illegal_transition', detail: 'posting cannot POST_FAILED', state_version: 3 },
    },
  ],
  timeline: {
    events: [
      { at: '2026-05-21T12:04:00.000Z', source: 'audit', line: 'estimate.recompute', is_error: false },
      {
        at: '2026-05-21T12:05:00.000Z',
        source: 'sync_event',
        line: 'qbo push',
        is_error: true,
        error: 'CircuitOpenError',
        request_id: 'req-9',
      },
    ],
  },
}

describe('agent-supervision pure helpers', () => {
  it('extracts replay anchors with the divergence verdict', () => {
    const anchors = extractReplayAnchors(serverContextWithDivergence)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]?.replay_ok).toBe(false)
    expect(anchors[0]?.first_divergence?.reason).toBe('illegal_transition')
    expect(anchors[0]?.to_state).toBe('failed')
  })

  it('returns [] when no server_context is present', () => {
    expect(extractReplayAnchors(null)).toEqual([])
    expect(extractReplayTimeline(undefined)).toEqual([])
  })

  it('flags the error timeline event', () => {
    const timeline = extractReplayTimeline(serverContextWithDivergence)
    expect(timeline).toHaveLength(2)
    expect(timeline[1]?.is_error).toBe(true)
    expect(timeline[1]?.error).toBe('CircuitOpenError')
  })

  it('projects the latest agent callback (newest agent event wins)', () => {
    const events = [
      makeEvent({ id: 'a', event_type: 'agent.dispatch_acknowledged', recorded_at: '2026-05-21T12:01:00.000Z' }),
      makeEvent({
        id: 'b',
        event_type: 'agent.proposal_ready',
        recorded_at: '2026-05-21T12:06:00.000Z',
        payload: {
          message: 'Patched the estimate push retry path',
          status: 'review_ready',
          projectkit_callback: { status: 'completed', artifacts: [{ kind: 'diff', label: 'estimate.ts patch' }] },
        },
      }),
    ]
    const callback = latestAgentCallback(events)
    expect(callback?.event_type).toBe('agent.proposal_ready')
    expect(callback?.message).toBe('Patched the estimate push retry path')
    expect(callback?.callback_status).toBe('completed')
    expect(callback?.artifacts[0]?.label).toBe('estimate.ts patch')
  })

  it('ignores user/system events when projecting the agent callback', () => {
    const events = [makeEvent({ event_type: 'message.added', actor_kind: 'user', actor_ref: null })]
    expect(latestAgentCallback(events)).toBeNull()
  })

  it('marks review_ready / review_stale / proposal_expired as awaiting review', () => {
    expect(isAwaitingReview('review_ready')).toBe(true)
    expect(isAwaitingReview('review_stale')).toBe(true)
    expect(isAwaitingReview('proposal_expired')).toBe(true)
    expect(isAwaitingReview('agent_running')).toBe(false)
    expect(isAwaitingReview('resolved')).toBe(false)
  })
})

describe('AgentSupervisionPanel', () => {
  it('renders the fast review row and fires Approve / Reject / Reopen', () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    const onReopen = vi.fn()
    render(
      <AgentSupervisionPanel
        workItem={makeWorkItem()}
        events={[]}
        supportPacket={null}
        serverContext={null}
        review={{ onApprove, onReject, onReopen, canReverse: false, busy: false, error: null }}
      />,
    )
    fireEvent.click(screen.getByText('Approve'))
    fireEvent.click(screen.getByText('Reject'))
    fireEvent.click(screen.getByText('Reopen'))
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onReopen).toHaveBeenCalledTimes(1)
    // Reverse is hidden when canReverse is false.
    expect(screen.queryByText('Reverse')).toBeNull()
  })

  it('requires a reason before confirming a reverse', () => {
    const onReverse = vi.fn()
    render(
      <AgentSupervisionPanel
        workItem={makeWorkItem()}
        events={[]}
        supportPacket={null}
        serverContext={null}
        review={{ onReverse, canReverse: true, busy: false, error: null }}
      />,
    )
    fireEvent.click(screen.getByText('Reverse'))
    const confirm = screen.getByText('Confirm reverse') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reverse reason'), { target: { value: 'wrong fix' } })
    expect((screen.getByText('Confirm reverse') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('Confirm reverse'))
    expect(onReverse).toHaveBeenCalledWith('wrong fix')
  })

  it('does not render the review row for an item that is not awaiting review', () => {
    render(
      <AgentSupervisionPanel
        workItem={makeWorkItem({ status: 'agent_running' })}
        events={[]}
        supportPacket={null}
        serverContext={null}
        review={{ onApprove: vi.fn(), canReverse: false, busy: false, error: null }}
      />,
    )
    expect(screen.queryByText('Approve')).toBeNull()
  })

  it('renders the replay sequence, highlights the divergence, and navigates steps', () => {
    render(
      <AgentSupervisionPanel
        workItem={makeWorkItem()}
        events={[]}
        supportPacket={null}
        serverContext={serverContextWithDivergence}
      />,
    )
    expect(screen.getByText('Deterministic replay diverged')).toBeTruthy()
    // The diverged transition chip renders the from -> to transition.
    const transitionChip = screen.getByText('posting → failed')
    fireEvent.click(transitionChip)
    expect(screen.getByText(/DIVERGED at v3: illegal_transition/)).toBeTruthy()
    // Navigate to the error timeline step.
    fireEvent.click(screen.getByTitle('sync_event: qbo push'))
    expect(screen.getByText('CircuitOpenError')).toBeTruthy()
  })

  it('hints to load the packet when no server_context is available', () => {
    render(<AgentSupervisionPanel workItem={makeWorkItem()} events={[]} supportPacket={null} serverContext={null} />)
    expect(screen.getByText(/Load the support packet to replay/)).toBeTruthy()
  })

  it('shows the agent proposed output side-by-side with the captured context', () => {
    const events = [
      makeEvent({
        event_type: 'agent.completed',
        payload: { message: 'Applied retry fix', projectkit_callback: { status: 'succeeded' } },
      }),
    ]
    render(
      <AgentSupervisionPanel
        workItem={makeWorkItem()}
        events={events}
        supportPacket={{
          id: '00000000-0000-4000-8000-000000000002',
          route: '/financial/estimate-pushes/ep-1',
          problem: 'Estimate push failed',
          request_id: 'req-1',
          build_sha: 'test-build',
          created_at: '2026-05-21T12:00:00.000Z',
          expires_at: null,
          redaction_version: 'support-packet-v1',
        }}
        serverContext={null}
        agentPrompt={'# Sitelayer Work Request\nWork item: ep-1'}
      />,
    )
    expect(screen.getByText('Agent proposed')).toBeTruthy()
    expect(screen.getByText('Captured context')).toBeTruthy()
    expect(screen.getByText('Applied retry fix')).toBeTruthy()
    expect(screen.getByText('succeeded')).toBeTruthy()
    expect(screen.getByText('Estimate push failed')).toBeTruthy()
    expect(screen.getByText('Agent prompt (full)')).toBeTruthy()
  })
})
