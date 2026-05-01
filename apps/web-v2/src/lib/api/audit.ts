// Audit events — admin-only ledger of state-changing API calls.
// Wraps GET /api/audit-events in apps/api/src/routes/audit-events.ts.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface AuditEvent {
  id: string
  company_id: string
  entity_type: string
  entity_id: string | null
  actor_user_id: string | null
  action: string
  before: unknown
  after: unknown
  created_at: string
}

export interface AuditEventListParams {
  entityType?: string
  entityId?: string
  actorUserId?: string
  since?: string
  limit?: number
}

export interface AuditEventListResponse {
  events: AuditEvent[]
}

const KEYS = {
  all: () => ['audit-events'] as const,
  list: (params: AuditEventListParams) => [...KEYS.all(), 'list', params] as const,
}

export const auditEventQueryKeys = KEYS

export function fetchAuditEvents(params: AuditEventListParams = {}): Promise<AuditEventListResponse> {
  const search = new URLSearchParams()
  if (params.entityType) search.set('entity_type', params.entityType)
  if (params.entityId) search.set('entity_id', params.entityId)
  if (params.actorUserId) search.set('actor_user_id', params.actorUserId)
  if (params.since) search.set('since', params.since)
  if (params.limit) search.set('limit', String(params.limit))
  const qs = search.toString()
  return request<AuditEventListResponse>(`/api/audit-events${qs ? `?${qs}` : ''}`)
}

export function useAuditEvents(
  params: AuditEventListParams = {},
  options?: Partial<UseQueryOptions<AuditEventListResponse>>,
) {
  return useQuery<AuditEventListResponse>({
    queryKey: KEYS.list(params),
    queryFn: () => fetchAuditEvents(params),
    ...options,
  })
}
