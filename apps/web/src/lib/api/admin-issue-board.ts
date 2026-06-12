import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'
import { queryKeys } from './keys'
import {
  type IssueBoardColumnId,
  type IssueBoardGroupBy,
  type IssueBoardLane,
  type IssueBoardSeverity,
  type IssueBoardStatus,
} from './issue-board'

/**
 * The two permanently-separate work-item domains. The admin board is the one
 * deliberately cross-domain READ surface, so items carry their domain and the
 * filter narrows opt-in — the domains themselves never bleed.
 */
export type AdminIssueBoardDomain = 'app_issue' | 'field_request'

export interface AdminIssueBoardFilters {
  companyId?: string | null
  companySlug?: string | null
  groupBy?: IssueBoardGroupBy
  domain?: AdminIssueBoardDomain | null
  status?: IssueBoardStatus | null
  lane?: IssueBoardLane | null
  assigneeUserId?: string | null
  createdByUserId?: string | null
  entityType?: string | null
  entityId?: string | null
  limit?: number
  offset?: number
}

export interface AdminIssueBoardItem {
  id: string
  companyId: string
  companySlug: string
  companyName: string
  supportPacketId: string
  domain: AdminIssueBoardDomain
  title: string
  summary: string | null
  status: IssueBoardStatus
  lane: IssueBoardLane
  severity: IssueBoardSeverity | null
  route: string | null
  captureSessionId: string | null
  entityType: string | null
  entityId: string | null
  assigneeUserId: string | null
  createdByUserId: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  reversedAt: string | null
  expiresAt: string | null
}

export interface AdminIssueBoardColumn {
  id: IssueBoardColumnId
  title: string
  lane: IssueBoardLane | null
  statuses: IssueBoardStatus[]
  items: AdminIssueBoardItem[]
}

export interface AdminIssueBoardResponse {
  groupBy: IssueBoardGroupBy
  columns: AdminIssueBoardColumn[]
  items: AdminIssueBoardItem[]
  pagination: { limit: number; offset: number; hasMore: boolean }
}

type RawAdminIssueBoardResponse = {
  group_by: IssueBoardGroupBy
  columns: Array<{
    id: IssueBoardColumnId
    title: string
    lane: IssueBoardLane | null
    statuses: IssueBoardStatus[]
    work_items: RawAdminIssueBoardItem[]
  }>
  work_items: RawAdminIssueBoardItem[]
  pagination: { limit: number; offset: number; has_more: boolean }
}

type RawAdminIssueBoardItem = {
  id: string
  company_id: string
  company_slug: string
  company_name: string
  support_packet_id: string
  capture_session_id: string | null
  domain: AdminIssueBoardDomain
  title: string
  summary: string | null
  status: IssueBoardStatus
  lane: IssueBoardLane
  severity: IssueBoardSeverity | null
  route: string | null
  entity_type: string | null
  entity_id: string | null
  assignee_user_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
  reversed_at: string | null
  expires_at: string | null
}

export function normalizeAdminIssueBoardFilters(filters: AdminIssueBoardFilters = {}): AdminIssueBoardFilters {
  return {
    ...(filters.companyId ? { companyId: filters.companyId } : {}),
    ...(filters.companySlug ? { companySlug: filters.companySlug } : {}),
    ...(filters.groupBy ? { groupBy: filters.groupBy } : {}),
    ...(filters.domain ? { domain: filters.domain } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.lane ? { lane: filters.lane } : {}),
    ...(filters.assigneeUserId ? { assigneeUserId: filters.assigneeUserId } : {}),
    ...(filters.createdByUserId ? { createdByUserId: filters.createdByUserId } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
    ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
  }
}

export function fetchAdminIssueBoard(filters: AdminIssueBoardFilters = {}): Promise<AdminIssueBoardResponse> {
  const normalized = normalizeAdminIssueBoardFilters(filters)
  const search = new URLSearchParams()
  setSearchParam(search, 'company_id', normalized.companyId)
  setSearchParam(search, 'company_slug', normalized.companySlug)
  setSearchParam(search, 'group_by', normalized.groupBy)
  setSearchParam(search, 'domain', normalized.domain)
  setSearchParam(search, 'status', normalized.status)
  setSearchParam(search, 'lane', normalized.lane)
  setSearchParam(search, 'assignee_user_id', normalized.assigneeUserId)
  setSearchParam(search, 'created_by_user_id', normalized.createdByUserId)
  setSearchParam(search, 'entity_type', normalized.entityType)
  setSearchParam(search, 'entity_id', normalized.entityId)
  setSearchParam(search, 'limit', normalized.limit)
  setSearchParam(search, 'offset', normalized.offset)
  const query = search.toString()
  return request<RawAdminIssueBoardResponse>(`/api/admin/work-requests/board${query ? `?${query}` : ''}`).then(
    mapAdminIssueBoardResponse,
  )
}

export function useAdminIssueBoard(
  filters: AdminIssueBoardFilters = {},
  options?: Partial<UseQueryOptions<AdminIssueBoardResponse>>,
) {
  const normalized = normalizeAdminIssueBoardFilters(filters)
  return useQuery<AdminIssueBoardResponse>({
    queryKey: queryKeys.adminIssueBoard.board(normalized),
    queryFn: () => fetchAdminIssueBoard(normalized),
    ...options,
  })
}

function mapAdminIssueBoardResponse(response: RawAdminIssueBoardResponse): AdminIssueBoardResponse {
  return {
    groupBy: response.group_by,
    columns: response.columns.map((column) => ({
      id: column.id,
      title: column.title,
      lane: column.lane,
      statuses: column.statuses,
      items: column.work_items.map(mapAdminIssueBoardItem),
    })),
    items: response.work_items.map(mapAdminIssueBoardItem),
    pagination: {
      limit: response.pagination.limit,
      offset: response.pagination.offset,
      hasMore: response.pagination.has_more,
    },
  }
}

function mapAdminIssueBoardItem(item: RawAdminIssueBoardItem): AdminIssueBoardItem {
  return {
    id: item.id,
    companyId: item.company_id,
    companySlug: item.company_slug,
    companyName: item.company_name,
    supportPacketId: item.support_packet_id,
    captureSessionId: item.capture_session_id,
    domain: item.domain,
    title: item.title,
    summary: item.summary,
    status: item.status,
    lane: item.lane,
    severity: item.severity,
    route: item.route,
    entityType: item.entity_type,
    entityId: item.entity_id,
    assigneeUserId: item.assignee_user_id,
    createdByUserId: item.created_by_user_id,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    resolvedAt: item.resolved_at,
    reversedAt: item.reversed_at,
    expiresAt: item.expires_at,
  }
}

function setSearchParam(search: URLSearchParams, key: string, value: string | number | null | undefined) {
  if (value === undefined || value === null || value === '') return
  search.set(key, String(value))
}
