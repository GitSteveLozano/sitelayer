import { describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ request }))

import { fetchAdminIssueBoard, normalizeAdminIssueBoardFilters } from './admin-issue-board'

function rawItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wi-1',
    company_id: 'co-1',
    company_slug: 'co-a',
    company_name: 'Company A',
    support_packet_id: 'sp-1',
    capture_session_id: null,
    domain: 'app_issue',
    title: 'Capture issue',
    summary: null,
    status: 'new',
    lane: 'triage',
    severity: null,
    route: null,
    entity_type: null,
    entity_id: null,
    assignee_user_id: null,
    created_by_user_id: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
    resolved_at: null,
    reversed_at: null,
    expires_at: null,
    ...overrides,
  }
}

describe('admin issue board client (cross-domain read surface)', () => {
  it('passes the optional domain filter through to the admin board query', async () => {
    request.mockResolvedValueOnce({
      group_by: 'status_group',
      columns: [],
      work_items: [],
      pagination: { limit: 200, offset: 0, has_more: false },
    })

    await fetchAdminIssueBoard({ domain: 'app_issue', groupBy: 'status_group' })

    const path = request.mock.calls[0]?.[0] as string
    expect(path).toContain('/api/admin/work-requests/board?')
    expect(path).toContain('domain=app_issue')
  })

  it('omits the domain param when unset (board stays cross-domain by default)', async () => {
    request.mockResolvedValueOnce({
      group_by: 'status_group',
      columns: [],
      work_items: [],
      pagination: { limit: 200, offset: 0, has_more: false },
    })

    await fetchAdminIssueBoard({})

    const path = request.mock.calls.at(-1)?.[0] as string
    expect(path).not.toContain('domain=')
    expect(normalizeAdminIssueBoardFilters({ domain: null })).toEqual({})
  })

  it('maps the domain onto every board item so the badge can render', async () => {
    request.mockResolvedValueOnce({
      group_by: 'status_group',
      columns: [
        {
          id: 'new',
          title: 'New',
          lane: null,
          statuses: ['new'],
          work_items: [rawItem(), rawItem({ id: 'wi-2', domain: 'field_request' })],
        },
      ],
      work_items: [rawItem(), rawItem({ id: 'wi-2', domain: 'field_request' })],
      pagination: { limit: 200, offset: 0, has_more: false },
    })

    const board = await fetchAdminIssueBoard({})

    expect(board.items.map((item) => item.domain)).toEqual(['app_issue', 'field_request'])
    expect(board.columns[0]?.items.map((item) => item.domain)).toEqual(['app_issue', 'field_request'])
  })
})
