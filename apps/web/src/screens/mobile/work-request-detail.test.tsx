import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type {
  SupportPacketAccessLogResponse,
  WorkRequestDetailResponse,
  WorkRequestHandoffPacket,
  WorkRequestQueueHealthResponse,
} from '@/lib/api'

const mocks = vi.hoisted(() => ({
  appendWorkRequestEvent: vi.fn(),
  dispatchWorkRequestToMesh: vi.fn(),
  exportWorkRequestHandoffPacket: vi.fn(),
  fetchSupportPacket: vi.fn(),
  fetchSupportPacketAccessLog: vi.fn(),
  fetchWorkRequest: vi.fn(),
  fetchWorkRequestGithubExport: vi.fn(),
  fetchWorkRequestHandoffPacket: vi.fn(),
  fetchWorkRequestQueueHealth: vi.fn(),
  retryWorkRequestMeshDispatch: vi.fn(),
  reverseWorkRequest: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    appendWorkRequestEvent: mocks.appendWorkRequestEvent,
    dispatchWorkRequestToMesh: mocks.dispatchWorkRequestToMesh,
    exportWorkRequestHandoffPacket: mocks.exportWorkRequestHandoffPacket,
    fetchSupportPacket: mocks.fetchSupportPacket,
    fetchSupportPacketAccessLog: mocks.fetchSupportPacketAccessLog,
    fetchWorkRequest: mocks.fetchWorkRequest,
    fetchWorkRequestGithubExport: mocks.fetchWorkRequestGithubExport,
    fetchWorkRequestHandoffPacket: mocks.fetchWorkRequestHandoffPacket,
    fetchWorkRequestQueueHealth: mocks.fetchWorkRequestQueueHealth,
    retryWorkRequestMeshDispatch: mocks.retryWorkRequestMeshDispatch,
    reverseWorkRequest: mocks.reverseWorkRequest,
  }
})

import { MobileWorkRequestDetail } from './work-request-detail'

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/work/00000000-0000-4000-8000-000000000001']}>
          <Routes>
            <Route path="/work/:workItemId" element={children} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return Wrapper
}

const detailResponse: WorkRequestDetailResponse = {
  work_item: {
    id: '00000000-0000-4000-8000-000000000001',
    support_packet_id: '00000000-0000-4000-8000-000000000002',
    title: 'Estimate push failed',
    summary: 'Customer could not send an estimate.',
    status: 'new',
    lane: 'triage',
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
  },
  support_packet: {
    id: '00000000-0000-4000-8000-000000000002',
    route: '/financial/estimate-pushes/ep-1',
    problem: 'Estimate push failed',
    request_id: 'req-1',
    build_sha: 'test-build',
    created_at: '2026-05-21T12:00:00.000Z',
    expires_at: '2026-05-22T12:00:00.000Z',
    redaction_version: 'support-packet-v1',
  },
  dispatch_outbox: null,
  work_request_brief: {
    schema: 'sitelayer.work_request_brief.v1',
    generated_at: '2026-05-21T12:06:00.000Z',
    work_item: {
      id: '00000000-0000-4000-8000-000000000001',
      support_packet_id: '00000000-0000-4000-8000-000000000002',
      title: 'Estimate push failed',
      summary: 'Customer could not send an estimate.',
      status: 'new',
      lane: 'triage',
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
      metadata_keys: [],
    },
    state: {
      status: 'new',
      lane: 'triage',
      severity: 'high',
      reversibility_window_seconds: 21600,
      expires_at: '2026-05-21T18:00:00.000Z',
      next_action: 'dispatch_agent',
    },
    support_packet: {
      id: '00000000-0000-4000-8000-000000000002',
      route: '/financial/estimate-pushes/ep-1',
      problem: 'Estimate push failed',
      request_id: 'req-1',
      build_sha: 'test-build',
      created_at: '2026-05-21T12:00:00.000Z',
      expires_at: '2026-05-22T12:00:00.000Z',
      redaction_version: 'support-packet-v1',
    },
    diagnostics: {
      work_item_path: '/work/00000000-0000-4000-8000-000000000001',
      support_packet_id: '00000000-0000-4000-8000-000000000002',
      request_id: 'req-1',
      build_sha: 'test-build',
      route: '/financial/estimate-pushes/ep-1',
      entity_type: 'estimate_push',
      entity_id: 'ep-1',
      dispatch_outbox_status: null,
      evidence_refs: [{ type: 'support_debug_packet', id: '00000000-0000-4000-8000-000000000002' }],
    },
    timeline: [],
    timeline_total: 0,
    timeline_truncated: false,
    agent_brief_markdown: '# Work request handoff\n\nWork item: 00000000-0000-4000-8000-000000000001',
  },
  events: [],
  events_pagination: {
    limit: 200,
    offset: 0,
    total: 0,
    has_more: false,
  },
}

const disabledHealth: WorkRequestQueueHealthResponse = {
  config: {
    mesh_dispatch_configured: false,
    callback_configured: true,
    scoped_callbacks_enabled: true,
    callback_fallback_configured: false,
  },
  work_items: {
    agent_running: 0,
    review_ready: 0,
    review_stale: 0,
    proposal_expired: 0,
  },
  dispatch_outbox: {
    pending: 0,
    processing: 0,
    failed: 0,
    dead: 0,
    oldest_pending_age_seconds: null,
  },
}

const handoffPacket: WorkRequestHandoffPacket = {
  schema: 'sitelayer.context_handoff_packet.v1',
  generated_at: '2026-05-21T12:07:00.000Z',
  audience: 'collaborator',
  redaction_version: 'context-handoff-v1',
  source: {
    system: 'sitelayer',
    company_id: 'company-1',
    work_item_id: detailResponse.work_item.id,
    support_packet_id: detailResponse.work_item.support_packet_id,
    public_path: `/work/${detailResponse.work_item.id}`,
  },
  permissions: {
    intended_use: 'human_handoff',
    raw_support_packet_included: false,
    callback_token_included: false,
    callback_available_after_dispatch: true,
  },
  state: detailResponse.work_request_brief.state,
  work_item: detailResponse.work_request_brief.work_item,
  diagnostics: detailResponse.work_request_brief.diagnostics,
  support_packet: null,
  evidence_refs: detailResponse.work_request_brief.diagnostics.evidence_refs,
  timeline: detailResponse.work_request_brief.timeline,
  timeline_total: detailResponse.work_request_brief.timeline_total,
  timeline_truncated: detailResponse.work_request_brief.timeline_truncated,
  agent_brief_markdown: detailResponse.work_request_brief.agent_brief_markdown,
  packet_sha256: 'abc123',
}

const accessLog: SupportPacketAccessLogResponse = {
  access_log: [
    {
      id: 'access-1',
      support_packet_id: '00000000-0000-4000-8000-000000000002',
      actor_user_id: 'admin-1',
      access_type: 'agent_prompt',
      route: '/work/00000000-0000-4000-8000-000000000001',
      request_id: 'req-access',
      created_at: '2026-05-21T12:10:00.000Z',
      metadata: {},
    },
  ],
}

beforeEach(() => {
  mocks.fetchWorkRequest.mockResolvedValue(detailResponse)
  mocks.fetchWorkRequestQueueHealth.mockResolvedValue(disabledHealth)
  mocks.fetchSupportPacketAccessLog.mockResolvedValue(accessLog)
  mocks.fetchWorkRequestHandoffPacket.mockResolvedValue({ handoff_packet: handoffPacket })
  mocks.exportWorkRequestHandoffPacket.mockResolvedValue({
    handoff_packet: handoffPacket,
    event: {
      id: 'event-handoff',
      company_id: 'company-1',
      work_item_id: detailResponse.work_item.id,
      event_type: 'handoff_packet.exported',
      actor_kind: 'user',
      actor_user_id: 'admin-1',
      actor_ref: null,
      source_system: 'sitelayer',
      payload: { packet_sha256: handoffPacket.packet_sha256 },
      metadata: {},
      idempotency_key: 'export-1',
      causation_event_id: null,
      correlation_id: null,
      request_id: null,
      sentry_trace: null,
      sentry_baggage: null,
      build_sha: 'test-build',
      redaction_version: 'context-handoff-v1',
      occurred_at: '2026-05-21T12:07:00.000Z',
      recorded_at: '2026-05-21T12:07:00.000Z',
    },
  })
})

afterEach(() => {
  cleanup()
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe('MobileWorkRequestDetail', () => {
  it('blocks Mesh dispatch and shows packet access history when dispatch is disabled', async () => {
    const Wrapper = makeWrapper()
    render(<MobileWorkRequestDetail companyRole="admin" />, { wrapper: Wrapper })

    expect(await screen.findByText('Estimate push failed')).toBeTruthy()
    expect(await screen.findByText('Agent dispatch unavailable')).toBeTruthy()
    expect((screen.getByText('Dispatch agent') as HTMLButtonElement).disabled).toBe(true)
    expect(await screen.findByText('Agent Prompt by admin-1')).toBeTruthy()
    expect(mocks.fetchSupportPacketAccessLog).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002')
  })

  it('renders the agent-readable handoff brief from the detail response', async () => {
    const Wrapper = makeWrapper()
    render(<MobileWorkRequestDetail companyRole="admin" />, { wrapper: Wrapper })

    expect(await screen.findByText('Agent brief')).toBeTruthy()
    expect(await screen.findByText('Dispatch Agent')).toBeTruthy()
    const markdown = await screen.findByLabelText('Agent brief markdown')
    expect(markdown).toHaveProperty('value', detailResponse.work_request_brief.agent_brief_markdown)
  })

  it('previews a collaborator-safe handoff packet from the work detail screen', async () => {
    const Wrapper = makeWrapper()
    render(<MobileWorkRequestDetail companyRole="admin" />, { wrapper: Wrapper })

    expect(await screen.findByText('Estimate push failed')).toBeTruthy()
    const previewButton = screen.getByText('Preview handoff packet') as HTMLButtonElement
    expect(previewButton.disabled).toBe(false)
    fireEvent.click(previewButton)

    await waitFor(() =>
      expect(mocks.fetchWorkRequestHandoffPacket).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000001',
        'collaborator',
      ),
    )
    const packetJson = await screen.findByLabelText('Handoff packet JSON')
    expect(packetJson).toHaveProperty('value', expect.stringContaining('"audience": "collaborator"'))
    expect(packetJson).toHaveProperty('value', expect.stringContaining('"raw_support_packet_included": false'))
    expect(await screen.findByText('abc123')).toBeTruthy()
  })

  it('renders the closed reversibility badge when expires_at is in the past', async () => {
    const Wrapper = makeWrapper()
    render(<MobileWorkRequestDetail companyRole="admin" />, { wrapper: Wrapper })

    // The seed expires_at (2026-05-21T18:00:00) is before "now" (2026-05-22)
    // so the badge should render the closed-window label.
    expect(await screen.findByText('Recall window closed')).toBeTruthy()
  })

  it('does not expose dispatch or reopen actions for a reversed work item', async () => {
    mocks.fetchWorkRequest.mockResolvedValue({
      ...detailResponse,
      work_item: {
        ...detailResponse.work_item,
        status: 'reversed',
        lane: 'done',
        reversed_at: '2026-05-21T12:30:00.000Z',
        resolved_at: '2026-05-21T12:30:00.000Z',
      },
    })
    const Wrapper = makeWrapper()
    render(<MobileWorkRequestDetail companyRole="admin" />, { wrapper: Wrapper })

    expect((await screen.findAllByText('Reversed')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Dispatch agent')).toBeNull()
    expect(screen.queryByText('Retry dispatch')).toBeNull()
    expect(screen.queryByText('Reopen')).toBeNull()
  })
})
