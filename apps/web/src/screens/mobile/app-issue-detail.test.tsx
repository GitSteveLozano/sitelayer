import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AppIssueDetailResponse } from '@/lib/api'

/**
 * Gap coverage for the app-issue detail card:
 *  - the analyzer write-back (metadata.capture_analysis) and readiness strip
 *    are RENDERED — the capture→analyze loop's payoff is on the card, not
 *    buried in metadata;
 *  - the triage write surface (accept / resolve / wont_do) is wired for
 *    platform-boundary callers and each verb only shows when the server's
 *    transition gate would accept it.
 * The api hooks are mocked; the screen is a thin renderer over them.
 */

const useAppIssueCapabilitiesMock = vi.fn()
const useAppIssueDetailMock = vi.fn()
const useAppIssueCostLedgerMock = vi.fn()
const useEscalateAppIssueMock = vi.fn()
const useTriageAppIssueMock = vi.fn()
const fetchSupportPacketMock = vi.fn()

vi.mock('@/lib/api', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useAppIssueCapabilities: () => useAppIssueCapabilitiesMock(),
    useAppIssueDetail: () => useAppIssueDetailMock(),
    useAppIssueCostLedger: () => useAppIssueCostLedgerMock(),
    useEscalateAppIssue: () => useEscalateAppIssueMock(),
    useTriageAppIssue: () => useTriageAppIssueMock(),
    fetchSupportPacket: (id: string) => fetchSupportPacketMock(id),
  }
})

import { MobileAppIssueDetailGate } from './app-issue-detail'

const triageMutate = vi.fn()

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function detailResponse(overrides: {
  status?: AppIssueDetailResponse['issue']['status']
  metadata?: Record<string, unknown>
}): AppIssueDetailResponse {
  return {
    issue: {
      id: 'wi-1',
      support_packet_id: 'sp-1',
      capture_session_id: 'cs-1',
      domain: 'app_issue',
      title: 'Dock wedges on stale session',
      summary: 'The capture dock cannot recover from a 409.',
      status: overrides.status ?? 'review_ready',
      lane: 'both',
      severity: 'high',
      route: '/desktop',
      entity_type: null,
      entity_id: null,
      assignee_user_id: null,
      created_by_user_id: 'user-1',
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:05:00.000Z',
      resolved_at: null,
      reversed_at: null,
      reversibility_window_seconds: 86400,
      expires_at: null,
      metadata: overrides.metadata ?? {},
    },
    support_packet: null,
    diagnostic_manifest: {
      schema: 'sitelayer.diagnostic_manifest.v1',
      generated_at: '2026-06-12T00:05:00.000Z',
      subject: { kind: 'app_issue', issue_id: 'wi-1', support_packet_id: 'sp-1', capture_session_id: 'cs-1' },
      operator_next_step: 'review_agent_output',
      needs_attention: false,
      capture_readiness: { support_packet: 'ready', capture_session: 'ready', artifact_analysis: 'ready' },
      evidence_refs: [],
      worker_health_refs: [],
      checks: [],
    },
    events: [],
    events_pagination: { limit: 200, offset: 0, total: 0, has_more: false },
  }
}

function mountDetail(detail: AppIssueDetailResponse, capabilities: string[] = ['app_issue.view', 'app_issue.triage']) {
  useAppIssueCapabilitiesMock.mockReturnValue({ isPending: false, data: capabilities })
  useAppIssueDetailMock.mockReturnValue({ data: detail, isPending: false, error: null })
  useAppIssueCostLedgerMock.mockReturnValue({
    isPending: false,
    error: null,
    data: { entries: [], total_cost_cents: 0, pull_count: 0 },
  })
  useEscalateAppIssueMock.mockReturnValue({ isPending: false, error: null, data: null, mutate: vi.fn() })
  useTriageAppIssueMock.mockReturnValue({ isPending: false, error: null, mutate: triageMutate })
  fetchSupportPacketMock.mockResolvedValue({
    support_packet: { server_context: {} },
    agent_prompt: null,
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/issues/wi-1']}>
        <Routes>
          <Route path="/issues/:issueId" element={<MobileAppIssueDetailGate />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('app-issue detail — capture analysis write-back', () => {
  it('renders the analyzer markdown and the readiness strip from work-item metadata', () => {
    mountDetail(
      detailResponse({
        metadata: {
          capture_analysis: {
            markdown: '## What happened\nThe user narrated a stuck capture dock.',
            completed_at: '2026-06-12T00:04:00.000Z',
            artifacts: [{ kind: 'analysis', ref: 'a-1' }],
          },
          capture_artifact_analysis: {
            status: 'ready',
            eligible_artifact_count: 2,
            processed_artifact_count: 2,
            pending_artifact_count: 0,
            updated_at: '2026-06-12T00:04:00.000Z',
          },
        },
      }),
    )

    expect(screen.getByTestId('capture-analysis-panel')).toBeTruthy()
    expect(screen.getByTestId('capture-analysis-markdown').textContent).toContain(
      'The user narrated a stuck capture dock.',
    )
    const readiness = screen.getByTestId('capture-analysis-readiness')
    expect(readiness.textContent).toContain('ready')
    expect(readiness.textContent).toContain('2/2 artifacts analyzed')
  })

  it('shows a pending readiness strip with no markdown while the analyzer runs', () => {
    mountDetail(
      detailResponse({
        metadata: {
          capture_artifact_analysis: {
            status: 'pending',
            eligible_artifact_count: 3,
            processed_artifact_count: 1,
            pending_artifact_count: 2,
            updated_at: '2026-06-12T00:04:00.000Z',
          },
        },
      }),
    )

    expect(screen.getByTestId('capture-analysis-readiness').textContent).toContain('1/3 artifacts analyzed')
    expect(screen.queryByTestId('capture-analysis-markdown')).toBeNull()
    expect(screen.getByText(/Analysis is still running/)).toBeTruthy()
  })

  it('omits the panel entirely when there is no analyzer metadata', () => {
    mountDetail(detailResponse({ metadata: {} }))
    expect(screen.queryByTestId('capture-analysis-panel')).toBeNull()
  })
})

describe('app-issue detail — triage write surface', () => {
  it('offers Accept on a new issue and fires the accept action', () => {
    mountDetail(detailResponse({ status: 'new' }))

    const panel = screen.getByTestId('app-issue-triage-panel')
    expect(panel).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(triageMutate).toHaveBeenCalledWith({ action: 'accept' })
  })

  it('offers Resolve / Won’t do (no Accept) on a review_ready issue', () => {
    mountDetail(detailResponse({ status: 'review_ready' }))

    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(triageMutate).toHaveBeenCalledWith({ action: 'resolve' })
    fireEvent.click(screen.getByRole('button', { name: "Won't do" }))
    expect(triageMutate).toHaveBeenCalledWith({ action: 'wont_do' })
  })

  it('maps the supervision fast-review row onto the triage verbs (approve=resolve, reject=wont_do)', () => {
    mountDetail(detailResponse({ status: 'review_ready' }))

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(triageMutate).toHaveBeenCalledWith({ action: 'resolve' })
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(triageMutate).toHaveBeenCalledWith({ action: 'wont_do' })
  })

  it('hides the triage surface on a terminal issue and for non-triagers', () => {
    mountDetail(detailResponse({ status: 'resolved' }))
    expect(screen.queryByTestId('app-issue-triage-panel')).toBeNull()
    cleanup()

    mountDetail(detailResponse({ status: 'new' }), ['app_issue.view'])
    expect(screen.queryByTestId('app-issue-triage-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
  })
})
