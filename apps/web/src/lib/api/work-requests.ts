import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'
import { queryKeys } from './keys'
import { emitControlPlaneTrace } from '@/lib/control-plane-trace'

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
  | 'agent.callback_missing'
  | 'agent.failed'
  | 'agent.dispatch_expired'
  | 'agent.message_received'
  | 'agent.artifact_attached'
  | 'agent.proposal_ready'
  | 'agent.completed'
  | 'human.assigned'
  | 'human.review_requested'
  | 'human.reviewed'
  | 'external.github_export_prepared'
  | 'external.github_linked'
  | 'handoff_packet.exported'
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
  capture_session_id?: string | null
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
  capture_session_id?: string | null
  problem: string | null
  request_id: string | null
  build_sha: string | null
  created_at: string
  expires_at: string | null
  redaction_version: string
}

export interface WorkRequestBriefTimelineEntry {
  event_type: string
  actor_kind: string
  actor_user_id: string | null
  actor_ref: string | null
  source_system: string
  recorded_at: string
  message: string | null
  url: string | null
  status: string | null
  lane: string | null
  artifacts_count: number | null
  payload_keys: string[]
}

export type DiagnosticCheckStatus = 'ok' | 'pending' | 'warn' | 'error' | 'missing'

export interface WorkRequestDiagnosticManifest {
  schema: 'sitelayer.work_request_diagnostic_manifest.v1'
  generated_at: string
  work_item_id: string
  capture_session_id: string | null
  operator_next_step: string
  needs_attention: boolean
  readiness: {
    support_packet: 'ready' | 'missing'
    capture_session: 'ready' | 'not_captured'
    artifact_analysis: 'ready' | 'pending' | 'failed' | 'missing'
    dispatch: string
    callback: 'available_after_dispatch' | 'scoped_callback_ready'
  }
  source: {
    route: string | null
    request_id: string | null
    build_sha: string | null
    entity_type: string | null
    entity_id: string | null
  }
  evidence: {
    refs: Array<{ type: string; id: string }>
    timeline_total: number
    timeline_truncated: boolean
    artifact_analysis: {
      status: string | null
      eligible_artifact_count: number | null
      processed_artifact_count: number | null
      pending_artifact_count: number | null
      audio_mode: string | null
      video_mode: string | null
      updated_at: string | null
    }
  }
  checks: Array<{
    key: string
    label: string
    status: DiagnosticCheckStatus
    detail: string | null
  }>
}

export interface WorkRequestBrief {
  schema: 'sitelayer.work_request_brief.v1'
  generated_at: string
  work_item: Omit<ContextWorkItem, 'metadata'> & { metadata_keys: string[] }
  state: {
    status: WorkItemStatus
    lane: WorkItemLane
    severity: WorkItemSeverity | null
    reversibility_window_seconds: number
    expires_at: string | null
    next_action: string
  }
  support_packet: WorkRequestSupportPacketSummary | null
  diagnostics: {
    work_item_path: string
    support_packet_id: string
    request_id: string | null
    build_sha: string | null
    route: string | null
    entity_type: string | null
    entity_id: string | null
    dispatch_outbox_status: string | null
    evidence_refs: Array<{ type: string; id: string }>
  }
  diagnostic_manifest: WorkRequestDiagnosticManifest
  timeline: WorkRequestBriefTimelineEntry[]
  timeline_total: number
  timeline_truncated: boolean
  callback?: {
    path: string
    url: string | null
    token_type: 'scoped_bearer'
    expires_at: string
  }
  agent_brief_markdown: string
}

export interface WorkRequestBriefResponse {
  work_request_brief: WorkRequestBrief
}

export type WorkRequestHandoffPacketAudience = 'operator' | 'mesh' | 'collaborator' | 'github'

export interface WorkRequestHandoffPacket {
  schema: 'sitelayer.context_handoff_packet.v1'
  generated_at: string
  audience: WorkRequestHandoffPacketAudience
  redaction_version: 'context-handoff-v1'
  source: {
    system: 'sitelayer'
    company_id: string
    work_item_id: string
    support_packet_id: string
    public_path: string
  }
  permissions: {
    intended_use: string
    raw_support_packet_included: boolean
    callback_token_included: false
    callback_available_after_dispatch: boolean
  }
  state: WorkRequestBrief['state']
  work_item: WorkRequestBrief['work_item']
  diagnostics: WorkRequestBrief['diagnostics']
  diagnostic_manifest: WorkRequestBrief['diagnostic_manifest']
  support_packet: WorkRequestSupportPacketSummary | null
  evidence_refs: WorkRequestBrief['diagnostics']['evidence_refs']
  timeline: WorkRequestBrief['timeline']
  timeline_total: number
  timeline_truncated: boolean
  agent_brief_markdown: string
  callback?: WorkRequestBrief['callback']
  packet_sha256: string
}

export interface WorkRequestHandoffPacketResponse {
  handoff_packet: WorkRequestHandoffPacket
}

export interface ExportWorkRequestHandoffPacketInput {
  audience?: WorkRequestHandoffPacketAudience
  purpose?: string | null
  idempotency_key?: string | null
}

export interface ExportWorkRequestHandoffPacketResponse extends WorkRequestHandoffPacketResponse {
  event: ContextHandoffEvent
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
  request_ref?: string | null
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
  lane?: WorkItemLane | null
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
  work_request_brief: WorkRequestBrief
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
    projectkit_dispatch_configured?: boolean
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
  capture: {
    captured_work_items: number
    analysis_ready: number
    analysis_pending: number
    analysis_failed: number
    analysis_missing: number
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
  emitControlPlaneTrace('sitelayer.work_request.create.requested', {
    category: input.category ?? null,
    severity: input.severity ?? null,
    lane: input.lane ?? null,
    route_path: compactInputRoutePath(input.route),
    client_request_id: input.client_request_id ?? null,
    details_present: Boolean(input.summary?.trim()),
  })
  return request<CreateWorkRequestResponse>('/api/work-requests', {
    method: 'POST',
    json: input,
  }).then(
    (response) => {
      emitControlPlaneTrace(
        'sitelayer.work_request.create.result',
        {
          work_item_id: response.work_item.id,
          status: response.work_item.status,
          lane: response.work_item.lane,
          severity: response.work_item.severity,
          client_request_id: input.client_request_id ?? null,
          idempotent_replay: Boolean(response.idempotent_replay),
        },
        'info',
      )
      return response
    },
    (error: unknown) => {
      emitControlPlaneTrace(
        'sitelayer.work_request.create.error',
        {
          client_request_id: input.client_request_id ?? null,
          error_name: error instanceof Error ? error.name : 'unknown',
        },
        'warn',
      )
      throw error
    },
  )
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

export function fetchWorkRequestBrief(id: string): Promise<WorkRequestBriefResponse> {
  return request<WorkRequestBriefResponse>(`/api/work-requests/${encodeURIComponent(id)}/brief`)
}

export function fetchWorkRequestHandoffPacket(
  id: string,
  audience: WorkRequestHandoffPacketAudience = 'collaborator',
): Promise<WorkRequestHandoffPacketResponse> {
  const search = new URLSearchParams({ audience })
  return request<WorkRequestHandoffPacketResponse>(
    `/api/work-requests/${encodeURIComponent(id)}/handoff-packet?${search.toString()}`,
  )
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

export function dispatchWorkRequest(id: string): Promise<DispatchWorkRequestResponse> {
  return request<DispatchWorkRequestResponse>(`/api/work-requests/${encodeURIComponent(id)}/dispatch/projectkit`, {
    method: 'POST',
    json: {},
  })
}

export function retryWorkRequestDispatch(id: string): Promise<DispatchWorkRequestResponse> {
  return request<DispatchWorkRequestResponse>(
    `/api/work-requests/${encodeURIComponent(id)}/dispatch/projectkit/retry`,
    {
      method: 'POST',
      json: {},
    },
  )
}

export function dispatchWorkRequestToMesh(id: string): Promise<DispatchWorkRequestResponse> {
  return dispatchWorkRequest(id)
}

export function retryWorkRequestMeshDispatch(id: string): Promise<DispatchWorkRequestResponse> {
  return retryWorkRequestDispatch(id)
}

export function fetchWorkRequestGithubExport(id: string): Promise<WorkRequestGithubExportResponse> {
  return request<WorkRequestGithubExportResponse>(`/api/work-requests/${encodeURIComponent(id)}/github-export`, {
    method: 'POST',
    json: {},
  })
}

export function exportWorkRequestHandoffPacket(
  id: string,
  input: ExportWorkRequestHandoffPacketInput = {},
): Promise<ExportWorkRequestHandoffPacketResponse> {
  return request<ExportWorkRequestHandoffPacketResponse>(
    `/api/work-requests/${encodeURIComponent(id)}/handoff-packet`,
    {
      method: 'POST',
      json: input,
    },
  )
}

export function reverseWorkRequest(id: string, input: ReverseWorkRequestInput): Promise<ReverseWorkRequestResponse> {
  return request<ReverseWorkRequestResponse>(`/api/work-requests/${encodeURIComponent(id)}/reverse`, {
    method: 'POST',
    json: input,
  })
}

/** List work requests (field material / equipment / issue requests) for the company. */
export function useWorkRequests(
  params: ListWorkRequestsParams = {},
  options?: Partial<UseQueryOptions<ListWorkRequestsResponse>>,
) {
  return useQuery<ListWorkRequestsResponse>({
    queryKey: queryKeys.workRequests.list(params),
    queryFn: () => fetchWorkRequests(params),
    ...options,
  })
}

/**
 * Append a handoff event to a work request (approve via `resolution.accepted`,
 * decline via `work_item.status_changed` → `wont_do`, reply via
 * `message.added`). Invalidates the work-request list + detail on success.
 */
export function useAppendWorkRequestEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { id: string; input: AppendWorkRequestEventInput }) =>
      appendWorkRequestEvent(args.id, args.input),
    onSuccess: (response) => {
      qc.invalidateQueries({ queryKey: queryKeys.workRequests.all() })
      qc.invalidateQueries({ queryKey: queryKeys.workRequests.detail(response.work_item.id) })
    },
  })
}

function compactInputRoutePath(route: string | null | undefined): string | null {
  if (!route) return null
  const trimmed = route.trim()
  if (!trimmed) return null
  try {
    const base = typeof window === 'undefined' ? 'https://sitelayer.invalid' : window.location.origin
    return new URL(trimmed, base).pathname || null
  } catch {
    return trimmed.split('?')[0]?.split('#')[0]?.slice(0, 120) || null
  }
}
