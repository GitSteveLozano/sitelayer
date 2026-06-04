import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'
import { queryKeys } from './keys'
import {
  fetchWorkRequest,
  type ContextWorkItem,
  type WorkItemLane,
  type WorkItemSeverity,
  type WorkItemStatus,
} from './work-requests'

export type IssueBoardScope = 'company' | 'cross-tenant'
export type IssueBoardStatus = WorkItemStatus
export type IssueBoardLane = WorkItemLane
export type IssueBoardSeverity = WorkItemSeverity
export type IssueBoardGroupBy = 'status_group' | 'lane'
export type IssueBoardColumnId = 'new' | 'triaged' | 'in_progress' | 'done' | IssueBoardLane

export interface IssueBoardFilters {
  scope?: IssueBoardScope
  groupBy?: IssueBoardGroupBy
  status?: IssueBoardStatus | null
  lane?: IssueBoardLane | null
  assigneeUserId?: string | null
  createdByUserId?: string | null
  entityType?: string | null
  entityId?: string | null
  limit?: number
  offset?: number
}

export interface IssueBoardItem {
  id: string
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

export interface IssueBoardColumn {
  id: IssueBoardColumnId
  title: string
  lane: IssueBoardLane | null
  statuses: IssueBoardStatus[]
  items: IssueBoardItem[]
}

export interface IssueBoardResponse {
  groupBy: IssueBoardGroupBy
  columns: IssueBoardColumn[]
  items: IssueBoardItem[]
  pagination: { limit: number; offset: number; hasMore: boolean }
}

export interface IssueBoardTimelineEvent {
  id: string
  eventType: string
  actorKind: string
  actorUserId: string | null
  actorRef: string | null
  message: string | null
  status: string | null
  lane: string | null
  recordedAt: string
}

export interface IssueBoardItemDetail {
  item: IssueBoardItem
  timeline: IssueBoardTimelineEvent[]
  evidenceRefs: Array<{ type: string; id: string }>
  supportPacketId: string
  captureSessionId: string | null
}

export interface MoveIssueBoardItemInput {
  status?: IssueBoardStatus
  lane?: IssueBoardLane
  assigneeUserId?: string | null
  expectedUpdatedAt: string
  message?: string | null
  idempotencyKey?: string | null
}

type RawIssueBoardResponse = {
  group_by: IssueBoardGroupBy
  columns: Array<{
    id: IssueBoardColumnId
    title: string
    lane: IssueBoardLane | null
    statuses: IssueBoardStatus[]
    work_items: ContextWorkItem[]
  }>
  work_items: ContextWorkItem[]
  pagination: { limit: number; offset: number; has_more: boolean }
}

type RawMoveIssueBoardItemResponse = {
  work_item: ContextWorkItem
}

export function normalizeIssueBoardFilters(filters: IssueBoardFilters = {}): IssueBoardFilters {
  return {
    ...(filters.scope ? { scope: filters.scope } : {}),
    ...(filters.groupBy ? { groupBy: filters.groupBy } : {}),
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

export function fetchIssueBoard(filters: IssueBoardFilters = {}): Promise<IssueBoardResponse> {
  const normalized = normalizeIssueBoardFilters(filters)
  if (normalized.scope === 'cross-tenant') {
    return Promise.reject(new Error('cross-tenant issue board is not implemented on the company-scoped API'))
  }
  const search = new URLSearchParams()
  setSearchParam(search, 'group_by', normalized.groupBy)
  setSearchParam(search, 'status', normalized.status)
  setSearchParam(search, 'lane', normalized.lane)
  setSearchParam(search, 'assignee_user_id', normalized.assigneeUserId)
  setSearchParam(search, 'created_by_user_id', normalized.createdByUserId)
  setSearchParam(search, 'entity_type', normalized.entityType)
  setSearchParam(search, 'entity_id', normalized.entityId)
  setSearchParam(search, 'limit', normalized.limit)
  setSearchParam(search, 'offset', normalized.offset)
  const query = search.toString()
  return request<RawIssueBoardResponse>(`/api/work-requests/board${query ? `?${query}` : ''}`).then(
    mapIssueBoardResponse,
  )
}

export function fetchIssueBoardItem(id: string): Promise<IssueBoardItemDetail> {
  return fetchWorkRequest(id).then((response) => ({
    item: mapIssueBoardItem(response.work_item),
    timeline: response.events.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      actorKind: event.actor_kind,
      actorUserId: event.actor_user_id,
      actorRef: event.actor_ref,
      message: readEventMessage(event.payload),
      status: readString(event.payload.status),
      lane: readString(event.payload.lane),
      recordedAt: event.recorded_at,
    })),
    evidenceRefs: response.work_request_brief.diagnostics.evidence_refs,
    supportPacketId: response.work_item.support_packet_id,
    captureSessionId: response.work_item.capture_session_id ?? null,
  }))
}

export function moveIssueBoardItem(id: string, input: MoveIssueBoardItemInput): Promise<IssueBoardItem> {
  return request<RawMoveIssueBoardItemResponse>(`/api/work-requests/${encodeURIComponent(id)}/move`, {
    method: 'POST',
    json: {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.lane !== undefined ? { lane: input.lane } : {}),
      ...(input.assigneeUserId !== undefined ? { assignee_user_id: input.assigneeUserId } : {}),
      expected_updated_at: input.expectedUpdatedAt,
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotency_key: input.idempotencyKey } : {}),
    },
  }).then((response) => mapIssueBoardItem(response.work_item))
}

export function useIssueBoard(filters: IssueBoardFilters = {}, options?: Partial<UseQueryOptions<IssueBoardResponse>>) {
  const normalized = normalizeIssueBoardFilters(filters)
  return useQuery<IssueBoardResponse>({
    queryKey: queryKeys.issueBoard.board(normalized),
    queryFn: () => fetchIssueBoard(normalized),
    ...options,
  })
}

export function useIssueBoardItem(id: string, options?: Partial<UseQueryOptions<IssueBoardItemDetail>>) {
  return useQuery<IssueBoardItemDetail>({
    queryKey: queryKeys.issueBoard.detail(id),
    queryFn: () => fetchIssueBoardItem(id),
    ...options,
  })
}

export function useMoveIssueBoardItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { id: string; input: MoveIssueBoardItemInput }) => moveIssueBoardItem(args.id, args.input),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: queryKeys.issueBoard.all() })
      qc.invalidateQueries({ queryKey: queryKeys.issueBoard.detail(item.id) })
      qc.invalidateQueries({ queryKey: queryKeys.workRequests.all() })
      qc.invalidateQueries({ queryKey: queryKeys.workRequests.detail(item.id) })
    },
  })
}

function mapIssueBoardResponse(response: RawIssueBoardResponse): IssueBoardResponse {
  return {
    groupBy: response.group_by,
    columns: response.columns.map((column) => ({
      id: column.id,
      title: column.title,
      lane: column.lane,
      statuses: column.statuses,
      items: column.work_items.map(mapIssueBoardItem),
    })),
    items: response.work_items.map(mapIssueBoardItem),
    pagination: {
      limit: response.pagination.limit,
      offset: response.pagination.offset,
      hasMore: response.pagination.has_more,
    },
  }
}

function mapIssueBoardItem(item: ContextWorkItem): IssueBoardItem {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    status: item.status,
    lane: item.lane,
    severity: item.severity,
    route: item.route,
    captureSessionId: item.capture_session_id ?? null,
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

function readEventMessage(payload: Record<string, unknown>): string | null {
  return readString(payload.message) ?? readString(payload.body)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
