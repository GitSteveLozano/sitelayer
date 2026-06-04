import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export type FeedbackInviteCaptureMode = 'text' | 'audio' | 'screen' | 'trace' | 'state'

export interface FeedbackInvite {
  id: string
  company_id: string
  reviewer_ref: string
  source: string
  target_route: string | null
  allowed_capture_modes: FeedbackInviteCaptureMode[]
  expires_at: string
  revoked_at: string | null
  created_by_user_id: string
  created_at: string
  last_used_at: string | null
  metadata: Record<string, unknown>
}

export interface CreateFeedbackInviteRequest {
  reviewer_ref?: string
  source?: string
  target_route?: string
  allowed_capture_modes?: FeedbackInviteCaptureMode[]
  expires_in_days?: number
  metadata?: Record<string, unknown>
}

export interface CreateFeedbackInviteResponse {
  invite: FeedbackInvite
  token: string
  invite_url: string
}

export interface ListFeedbackInvitesResponse {
  invites: FeedbackInvite[]
  pagination: { limit: number; offset: number; has_more: boolean }
}

const feedbackInvitesKey = (companyId: string) => ['companies', companyId, 'feedback-invites'] as const

export function useCompanyFeedbackInvites(companyId: string | null | undefined) {
  return useQuery<ListFeedbackInvitesResponse>({
    queryKey: feedbackInvitesKey(companyId ?? ''),
    enabled: Boolean(companyId),
    queryFn: () =>
      request<ListFeedbackInvitesResponse>(`/api/companies/${encodeURIComponent(companyId!)}/feedback-invites`),
  })
}

export function useCreateFeedbackInvite(companyId: string) {
  const qc = useQueryClient()
  return useMutation<CreateFeedbackInviteResponse, Error, CreateFeedbackInviteRequest>({
    mutationFn: (input) =>
      request<CreateFeedbackInviteResponse>(`/api/companies/${encodeURIComponent(companyId)}/feedback-invites`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: feedbackInvitesKey(companyId) }),
  })
}

export function useRevokeFeedbackInvite(companyId: string) {
  const qc = useQueryClient()
  return useMutation<{ invite: FeedbackInvite }, Error, { inviteId: string }>({
    mutationFn: ({ inviteId }) =>
      request<{ invite: FeedbackInvite }>(
        `/api/companies/${encodeURIComponent(companyId)}/feedback-invites/${encodeURIComponent(inviteId)}/revoke`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: feedbackInvitesKey(companyId) }),
  })
}
