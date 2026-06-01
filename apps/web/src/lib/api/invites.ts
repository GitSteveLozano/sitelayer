// Teammate invites — wraps the invite API:
//   POST   /api/companies/:id/invites          (admin create)
//   GET    /api/companies/:id/invites          (admin list)
//   POST   /api/companies/:id/invites/:id/revoke (admin revoke)
//   GET    /api/invites/:token                 (public view — no auth)
//   POST   /api/invites/:token/accept          (authenticated accept)
//
// See apps/api/src/routes/invites.ts. The accept binds the authenticated
// Clerk user (or dev act-as id) into company_memberships under the invite's
// company — the email→member conversion that closes the pilot blocker.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

export interface CompanyInvite {
  id: string
  company_id: string
  email: string
  role: string
  status: InviteStatus
  invited_by: string
  accepted_by: string | null
  accepted_at: string | null
  expires_at: string
  created_at: string
}

/** Public, token-scoped view — intentionally omits token/invited_by/accepted_by. */
export interface PublicInviteView {
  company_name: string
  email: string
  role: string
  status: InviteStatus
  expires_at: string
}

export interface CreateInviteRequest {
  email: string
  role?: string
  expires_in_days?: number
}

export interface CreateInviteResponse {
  invite: CompanyInvite
  already_pending?: boolean
}

export interface ListInvitesResponse {
  invites: CompanyInvite[]
}

export interface InviteViewResponse {
  invite: PublicInviteView
}

export interface AcceptInviteResponse {
  membership: { id: string; company_id: string; clerk_user_id: string; role: string; created_at: string }
  company: { id: string; slug: string; name: string }
  already_accepted?: boolean
}

const invitesKey = (companyId: string) => ['companies', companyId, 'invites'] as const

export function useCompanyInvites(companyId: string | null | undefined) {
  return useQuery<ListInvitesResponse>({
    queryKey: invitesKey(companyId ?? ''),
    enabled: Boolean(companyId),
    queryFn: () => request<ListInvitesResponse>(`/api/companies/${encodeURIComponent(companyId!)}/invites`),
  })
}

export function useCreateInvite(companyId: string) {
  const qc = useQueryClient()
  return useMutation<CreateInviteResponse, Error, CreateInviteRequest>({
    mutationFn: (input) =>
      request<CreateInviteResponse>(`/api/companies/${encodeURIComponent(companyId)}/invites`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: invitesKey(companyId) }),
  })
}

export function useRevokeInvite(companyId: string) {
  const qc = useQueryClient()
  return useMutation<{ invite: CompanyInvite }, Error, { inviteId: string }>({
    mutationFn: ({ inviteId }) =>
      request<{ invite: CompanyInvite }>(
        `/api/companies/${encodeURIComponent(companyId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: invitesKey(companyId) }),
  })
}

export function useInviteView(token: string | null | undefined) {
  return useQuery<InviteViewResponse>({
    queryKey: ['invites', token ?? ''],
    enabled: Boolean(token),
    queryFn: () => request<InviteViewResponse>(`/api/invites/${encodeURIComponent(token!)}`),
    retry: false,
  })
}

export function useAcceptInvite(token: string) {
  return useMutation<AcceptInviteResponse, Error, void>({
    mutationFn: () =>
      request<AcceptInviteResponse>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' }),
  })
}
