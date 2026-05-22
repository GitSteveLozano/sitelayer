import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type {
  SupportPacketAccessLogResponse,
  WorkRequestDetailResponse,
  WorkRequestQueueHealthResponse,
} from '@/lib/api'

const mocks = vi.hoisted(() => ({
  appendWorkRequestEvent: vi.fn(),
  dispatchWorkRequestToMesh: vi.fn(),
  fetchSupportPacket: vi.fn(),
  fetchSupportPacketAccessLog: vi.fn(),
  fetchWorkRequest: vi.fn(),
  fetchWorkRequestGithubExport: vi.fn(),
  fetchWorkRequestQueueHealth: vi.fn(),
  retryWorkRequestMeshDispatch: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    appendWorkRequestEvent: mocks.appendWorkRequestEvent,
    dispatchWorkRequestToMesh: mocks.dispatchWorkRequestToMesh,
    fetchSupportPacket: mocks.fetchSupportPacket,
    fetchSupportPacketAccessLog: mocks.fetchSupportPacketAccessLog,
    fetchWorkRequest: mocks.fetchWorkRequest,
    fetchWorkRequestGithubExport: mocks.fetchWorkRequestGithubExport,
    fetchWorkRequestQueueHealth: mocks.fetchWorkRequestQueueHealth,
    retryWorkRequestMeshDispatch: mocks.retryWorkRequestMeshDispatch,
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

  it('renders the closed reversibility badge when expires_at is in the past', async () => {
    const Wrapper = makeWrapper()
    render(<MobileWorkRequestDetail companyRole="admin" />, { wrapper: Wrapper })

    // The seed expires_at (2026-05-21T18:00:00) is before "now" (2026-05-22)
    // so the badge should render the closed-window label.
    expect(await screen.findByText('Recall window closed')).toBeTruthy()
  })
})
