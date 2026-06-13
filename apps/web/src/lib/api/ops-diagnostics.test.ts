import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from './client'
import { fetchOpsDiagnosticSessionActionStatus, fetchOpsDiagnosticSessions } from './ops-diagnostics'

vi.mock('./client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

const apiGetMock = vi.mocked(apiGet)

describe('ops diagnostics API client', () => {
  beforeEach(() => {
    apiGetMock.mockReset()
  })

  it('fetches onsite diagnostic sessions through the company-scoped route', async () => {
    apiGetMock.mockResolvedValueOnce({
      schema: 'sitelayer.ops_diagnostic_sessions.v1',
      sessions: [],
    })

    await expect(fetchOpsDiagnosticSessions('acme')).resolves.toMatchObject({ sessions: [] })

    expect(apiGetMock).toHaveBeenCalledWith('/api/ops/diagnostics/sessions', 'acme')
  })

  it('fetches compact onsite action status by client action id', async () => {
    apiGetMock.mockResolvedValueOnce({
      schema: 'sitelayer.ops_diagnostic_session_action_status.v1',
      action_status: {
        session_id: 'session-1',
        action_event_id: 'event-1',
        action_key: 'dispatch_agent_review',
        client_action_id: 'tap 1',
        requested_at: '2026-06-12T12:00:00.000Z',
        state: 'retrying',
        summary: 'Action accepted; worker delivery is still pending or retrying.',
        accepted_action: { key: 'dispatch_agent_review', effect: 'audit_only' },
      },
    })

    await expect(
      fetchOpsDiagnosticSessionActionStatus(
        'session-1',
        { action_key: 'dispatch_agent_review', client_action_id: 'tap 1' },
        'acme',
      ),
    ).resolves.toMatchObject({ action_status: { state: 'retrying' } })

    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/ops/diagnostics/sessions/session-1/actions/status?action_key=dispatch_agent_review&client_action_id=tap+1',
      'acme',
    )
  })
})
