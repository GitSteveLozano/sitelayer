import { request } from './client'

export type WorkItemStatus =
  | 'new'
  | 'triaged'
  | 'agent_running'
  | 'human_assigned'
  | 'review_ready'
  | 'review_stale'
  | 'proposal_expired'
  | 'resolved'
  | 'reopened'
  | 'wont_do'
  | 'reversed'

export type WorkItemLane = 'triage' | 'human' | 'agent' | 'both' | 'done'
export type WorkItemSeverity = 'low' | 'normal' | 'high' | 'urgent'

export type HandoffEventType =
  | 'work_item.created'
  | 'work_item.updated'
  | 'work_item.status_changed'
  | 'message.added'
  | 'support_packet.linked'
  | 'agent.dispatch_requested'
  | 'agent.dispatch_acknowledged'
  | 'agent.dispatch_retried'
  | 'agent.dispatch_cancel_requested'
  | 'agent.message_received'
  | 'agent.artifact_attached'
  | 'agent.proposal_ready'
  | 'agent.completed'
  | 'human.assigned'
  | 'human.review_requested'
  | 'human.reviewed'
  | 'external.github_export_prepared'
  | 'external.github_linked'
  | 'resolution.accepted'
  | 'resolution.reopened'
  | 'work_item.reversed'

export interface ContextWorkItem {
  id: string
  support_packet_id: string
  title: string
  summary: string | null
  status: WorkItemStatus
  lane: WorkItemLane
  severity: WorkItemSeverity | null
  route: string | null
  entity_type: string | null
  entity_id: string | null
  assignee_user_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
  reversed_at: string | null
  reversibility_window_seconds: number
  expires_at: string | null
  metadata: Record<string, unknown>
}

export interface ReverseWorkRequestInput {
  reason: string
}

export interface ReverseWorkRequestResponse {
  work_item: ContextWorkItem
  event: ContextHandoffEvent | null
  mesh_cancel: { ok: boolean; status?: number | null; error?: string | null } | null
  idempotent_replay?: boolean
}

export interface ContextHandoffEvent {
  id: string
  company_id: string
  work_item_id: string
  event_type: HandoffEventType
  actor_kind: 'user' | 'agent' | 'system' | 'external'
  actor_user_id: string | null
  actor_ref: string | null
  source_system: string
  payload: Record<string, unknown>
  metadata: Record<string, unknown>
  idempotency_key: string | null
  causation_event_id: string | null
  correlation_id: string | null
  request_id: string | null
  sentry_trace: string | null
  sentry_baggage: string | null
  build_sha: string | null
  redaction_version: string
  occurred_at: string
  recorded_at: string
}

export interface WorkRequestSupportPacketSummary {
  id: string
  route: string | null
  problem: string | null
  request_id: string | null
  build_sha: string | null
  created_at: string
  expires_at: string | null
  redaction_version: string
}

export interface DispatchOutboxSummary {
  id: string
  mutation_type: 'dispatch_mesh_work_request'
  idempotency_key: string
  status: string
  attempt_count: number
  next_attempt_at: string | null
  applied_at: string | null
  error: string | null
}

export interface CreateWorkRequestInput {
  title: string
  summary?: string | null
  severity?: WorkItemSeverity | null
  lane?: WorkItemLane | null
  category?: string | null
  route?: string | null
  client?: unknown
  client_request_id?: string | null
}

export interface CreateWorkRequestResponse {
  work_item: ContextWorkItem
  support_packet: {
    id: string
    expires_at: string | null
  }
  event: ContextHandoffEvent | null
  idempotent_replay?: boolean
}

export interface ListWorkRequestsParams {
  status?: WorkItemStatus | null
  entity_type?: string | null
  entity_id?: string | null
  created_by_user_id?: string | null
  assignee_user_id?: string | null
  limit?: number
  offset?: number
}

export interface ListWorkRequestsResponse {
  work_items: ContextWorkItem[]
  pagination: {
    limit: number
    offset: number
    has_more: boolean
  }
}

export interface WorkRequestDetailResponse {
  work_item: ContextWorkItem
  support_packet: WorkRequestSupportPacketSummary | null
  dispatch_outbox: DispatchOutboxSummary | null
  events: ContextHandoffEvent[]
  events_pagination: {
    limit: number
    offset: number
    total: number
    has_more: boolean
  }
}

export interface WorkRequestQueueHealthResponse {
  config: {
    mesh_dispatch_configured: boolean
    callback_configured: boolean
    scoped_callbacks_enabled: boolean
    callback_fallback_configured: boolean
  }
  work_items: {
    agent_running: number
    review_ready: number
    review_stale: number
    proposal_expired: number
  }
  dispatch_outbox: {
    pending: number
    processing: number
    failed: number
    dead: number
    oldest_pending_age_seconds: number | null
  }
}

export interface AppendWorkRequestEventInput {
  event_type: HandoffEventType
  message?: string | null
  body?: string | null
  url?: string | null
  status?: WorkItemStatus | null
  lane?: WorkItemLane | null
  assignee_user_id?: string | null
  metadata?: Record<string, unknown>
  idempotency_key?: string | null
}

export interface AppendWorkRequestEventResponse {
  work_item: ContextWorkItem
  event: ContextHandoffEvent
}

export interface DispatchWorkRequestResponse {
  work_item: ContextWorkItem
  event: ContextHandoffEvent | null
  outbox: DispatchOutboxSummary
  dispatch_queued: boolean
}

export interface WorkRequestGithubExportResponse {
  title: string
  body: string
  labels: string[]
  event?: ContextHandoffEvent
}

export function createWorkRequest(input: CreateWorkRequestInput): Promise<CreateWorkRequestResponse> {
  return request<CreateWorkRequestResponse>('/api/work-requests', {
    method: 'POST',
    json: input,
  })
}

export function fetchWorkRequests(params: ListWorkRequestsParams = {}): Promise<ListWorkRequestsResponse> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return request<ListWorkRequestsResponse>(`/api/work-requests${query ? `?${query}` : ''}`)
}

export function fetchWorkRequest(id: string): Promise<WorkRequestDetailResponse> {
  return request<WorkRequestDetailResponse>(`/api/work-requests/${encodeURIComponent(id)}`)
}

export function fetchWorkRequestQueueHealth(): Promise<WorkRequestQueueHealthResponse> {
  return request<WorkRequestQueueHealthResponse>('/api/work-requests/queue-health')
}

export function appendWorkRequestEvent(
  id: string,
  input: AppendWorkRequestEventInput,
): Promise<AppendWorkRequestEventResponse> {
  return request<AppendWorkRequestEventResponse>(`/api/work-requests/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    json: input,
  })
}

export function dispatchWorkRequestToMesh(id: string): Promise<DispatchWorkRequestResponse> {
  return request<DispatchWorkRequestResponse>(`/api/work-requests/${encodeURIComponent(id)}/dispatch/mesh`, {
    method: 'POST',
    json: {},
  })
}

export function retryWorkRequestMeshDispatch(id: string): Promise<DispatchWorkRequestResponse> {
  return request<DispatchWorkRequestResponse>(`/api/work-requests/${encodeURIComponent(id)}/dispatch/mesh/retry`, {
    method: 'POST',
    json: {},
  })
}

export function fetchWorkRequestGithubExport(id: string): Promise<WorkRequestGithubExportResponse> {
  return request<WorkRequestGithubExportResponse>(`/api/work-requests/${encodeURIComponent(id)}/github-export`, {
    method: 'POST',
    json: {},
  })
}

export function reverseWorkRequest(id: string, input: ReverseWorkRequestInput): Promise<ReverseWorkRequestResponse> {
  return request<ReverseWorkRequestResponse>(`/api/work-requests/${encodeURIComponent(id)}/reverse`, {
    method: 'POST',
    json: input,
  })
}
