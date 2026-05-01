// QBO integration — connection state + entity mappings.
// Wraps /api/integrations/qbo and /api/integrations/qbo/mappings in
// apps/api/src/routes/qbo.ts and qbo-mappings.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface QboConnection {
  id: string
  provider: 'qbo'
  provider_account_id: string | null
  status: string
  sync_cursor: string | null
  last_synced_at: string | null
  webhook_secret: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface QboSyncStatus {
  pending_outbox: number
  pending_sync_events: number
  applied_last_24h: number
  failed_last_24h: number
  last_applied_at: string | null
}

export interface QboConnectionResponse {
  connection: QboConnection | null
  status: QboSyncStatus
}

export interface QboAuthUrlResponse {
  authUrl: string
}

export type QboEntityType = 'customer' | 'service_item' | 'division' | 'project' | string

export interface QboMapping {
  id: string
  provider: 'qbo'
  entity_type: QboEntityType
  local_ref: string
  external_id: string
  label: string | null
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface QboMappingListParams {
  entityType?: QboEntityType
}

export interface QboMappingListResponse {
  mappings: QboMapping[]
}

export interface QboMappingUpsertRequest {
  entity_type: QboEntityType
  local_ref: string
  external_id: string
  label?: string | null
  status?: string
  notes?: string | null
}

export interface QboMappingPatchRequest {
  entity_type?: QboEntityType
  local_ref?: string
  external_id?: string
  label?: string | null
  status?: string
  notes?: string | null
  expected_version?: number
}

const KEYS = {
  all: () => ['qbo'] as const,
  connection: () => [...KEYS.all(), 'connection'] as const,
  mappings: (params: QboMappingListParams) => [...KEYS.all(), 'mappings', params] as const,
}

export const qboQueryKeys = KEYS

export function fetchQboConnection(): Promise<QboConnectionResponse> {
  return request<QboConnectionResponse>('/api/integrations/qbo')
}

export function fetchQboAuthUrl(): Promise<QboAuthUrlResponse> {
  return request<QboAuthUrlResponse>('/api/integrations/qbo/auth')
}

export function fetchQboMappings(params: QboMappingListParams = {}): Promise<QboMappingListResponse> {
  const search = new URLSearchParams()
  if (params.entityType) search.set('entity_type', params.entityType)
  const qs = search.toString()
  return request<QboMappingListResponse>(`/api/integrations/qbo/mappings${qs ? `?${qs}` : ''}`)
}

export function useQboConnection() {
  return useQuery<QboConnectionResponse>({
    queryKey: KEYS.connection(),
    queryFn: fetchQboConnection,
    staleTime: 30_000,
  })
}

export function useQboMappings(params: QboMappingListParams = {}) {
  return useQuery<QboMappingListResponse>({
    queryKey: KEYS.mappings(params),
    queryFn: () => fetchQboMappings(params),
  })
}

export function useTriggerQboSync() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, void>({
    mutationFn: () => request('/api/integrations/qbo/sync', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function useUpsertQboMapping() {
  const qc = useQueryClient()
  return useMutation<QboMapping, Error, QboMappingUpsertRequest>({
    mutationFn: (input) => request<QboMapping>('/api/integrations/qbo/mappings', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function usePatchQboMapping(id: string) {
  const qc = useQueryClient()
  return useMutation<QboMapping, Error, QboMappingPatchRequest>({
    mutationFn: (input) =>
      request<QboMapping>(`/api/integrations/qbo/mappings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function useDeleteQboMapping() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; expected_version?: number }>({
    mutationFn: ({ id, expected_version }) =>
      request(`/api/integrations/qbo/mappings/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}
