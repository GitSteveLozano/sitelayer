import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from './client'
import { fetchOpsDiagnosticSessions } from './ops-diagnostics'

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
})
