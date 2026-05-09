// Estimate share-link hooks for the operator-facing send sheet.
// Wraps the authenticated /api/projects/:id/estimate/share[*] endpoints.
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export type EstimateShareSummary = {
  id: string
  recipient_email: string | null
  recipient_name: string | null
  sent_at: string
  expires_at: string
  accepted_at: string | null
  declined_at: string | null
  decline_reason: string | null
  viewed_at: string | null
  view_count: number
  status: 'pending' | 'accepted' | 'declined' | 'expired'
  share_url_path: string
}

export type EstimateShareCreateResponse = {
  id: string
  share_token: string
  share_url: string
  expires_at: string
  sent_at: string
  recipient_email: string | null
  recipient_name: string | null
}

const KEYS = {
  all: () => ['estimate-shares'] as const,
  byProject: (projectId: string) => [...KEYS.all(), 'project', projectId] as const,
}

export const estimateShareQueryKeys = KEYS

export function fetchEstimateShares(projectId: string): Promise<{ shares: EstimateShareSummary[] }> {
  return request<{ shares: EstimateShareSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/estimate/shares`)
}

export function useEstimateShares(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<{ shares: EstimateShareSummary[] }>>,
) {
  return useQuery<{ shares: EstimateShareSummary[] }>({
    queryKey: KEYS.byProject(projectId ?? ''),
    queryFn: () => fetchEstimateShares(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

export type CreateEstimateShareInput = {
  recipient_email: string
  recipient_name?: string
  expires_in_days?: number
}

export function createEstimateShare(
  projectId: string,
  input: CreateEstimateShareInput,
): Promise<EstimateShareCreateResponse> {
  return request<EstimateShareCreateResponse>(`/api/projects/${encodeURIComponent(projectId)}/estimate/share`, {
    method: 'POST',
    json: input,
  })
}

export function useCreateEstimateShare(projectId: string) {
  const qc = useQueryClient()
  return useMutation<EstimateShareCreateResponse, Error, CreateEstimateShareInput>({
    mutationFn: (input) => createEstimateShare(projectId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.byProject(projectId) })
    },
  })
}

export function revokeEstimateShare(shareId: string): Promise<{ id: string; status: 'revoked' }> {
  return request<{ id: string; status: 'revoked' }>(`/api/estimate-shares/${encodeURIComponent(shareId)}/revoke`, {
    method: 'POST',
  })
}

export function useRevokeEstimateShare(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ id: string; status: 'revoked' }, Error, string>({
    mutationFn: (shareId) => revokeEstimateShare(shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.byProject(projectId) })
    },
  })
}
