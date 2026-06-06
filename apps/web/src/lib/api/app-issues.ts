// Internal APP-ISSUE surface (apps/api/src/routes/issues.ts). Read-only
// list/board/detail over the `app_issue` half of context_work_items, gated
// server-side by the PLATFORM capability `app_issue.view`. These are problems
// with the sitelayer SOFTWARE, NOT the per-company field-request work board
// (work-requests.ts). The two domains never bleed.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'
import type { SessionResponse } from './bootstrap'
import type {
  ContextHandoffEvent,
  ContextWorkItem,
  WorkItemLane,
  WorkItemStatus,
  WorkRequestSupportPacketSummary,
} from './work-requests'

export type AppIssue = ContextWorkItem & { domain: 'app_issue' }

export type AppIssueBoardGroupBy = 'lane' | 'status_group'

export interface AppIssueBoardColumn {
  id: string
  title: string
  lane: WorkItemLane | null
  statuses: WorkItemStatus[]
  work_items: AppIssue[]
}

export interface AppIssueBoardResponse {
  group_by: AppIssueBoardGroupBy
  columns: AppIssueBoardColumn[]
  issues: AppIssue[]
  pagination: { limit: number; offset: number; total: number }
}

export interface AppIssueDetailResponse {
  issue: AppIssue
  support_packet: WorkRequestSupportPacketSummary | null
  events: ContextHandoffEvent[]
  events_pagination: { limit: number; offset: number; total: number; has_more: boolean }
}

export interface AppIssueBoardParams {
  groupBy?: AppIssueBoardGroupBy
  status?: WorkItemStatus | null
  lane?: WorkItemLane | null
  limit?: number
}

const appIssueKeys = {
  board: (params: AppIssueBoardParams) => ['app-issues', 'board', params] as const,
  detail: (id: string) => ['app-issues', 'detail', id] as const,
}

function boardSearch(params: AppIssueBoardParams): string {
  const search = new URLSearchParams()
  if (params.groupBy) search.set('group_by', params.groupBy)
  if (params.status) search.set('status', params.status)
  if (params.lane) search.set('lane', params.lane)
  if (params.limit) search.set('limit', String(params.limit))
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

export function fetchAppIssueBoard(params: AppIssueBoardParams = {}): Promise<AppIssueBoardResponse> {
  return request<AppIssueBoardResponse>(`/api/issues/board${boardSearch(params)}`)
}

export function useAppIssueBoard(
  params: AppIssueBoardParams = {},
  options?: Partial<UseQueryOptions<AppIssueBoardResponse, Error>>,
) {
  return useQuery<AppIssueBoardResponse, Error>({
    queryKey: appIssueKeys.board(params),
    queryFn: () => fetchAppIssueBoard(params),
    ...options,
  })
}

/**
 * The caller's effective PLATFORM app_issue.* capabilities (off /api/session).
 * Drives whether the SPA mounts the internal /issues board entry. Empty for a
 * non-platform-admin / non-Clerk session; the API 403s regardless.
 */
export function useAppIssueCapabilities() {
  return useQuery<string[], Error>({
    queryKey: ['app-issues', 'capabilities'],
    queryFn: async () => {
      const session = await request<SessionResponse>('/api/session')
      return session.app_issue_capabilities ?? []
    },
    staleTime: 5 * 60_000,
  })
}
