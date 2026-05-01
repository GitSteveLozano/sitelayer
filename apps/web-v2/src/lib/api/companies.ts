// Companies — onboarding wizard endpoints (Phase 6 Batch 7).
// Wraps POST /api/companies and POST /api/companies/:id/memberships.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface Company {
  id: string
  slug: string
  name: string
  created_at: string
}

export interface CreateCompanyRequest {
  slug: string
  name: string
  seed_defaults?: boolean
}

export interface CreateCompanyResponse {
  company: Company
  role: string
}

export interface CreateMembershipRequest {
  clerk_user_id: string
  role?: string
}

export function useCreateCompany() {
  const qc = useQueryClient()
  return useMutation<CreateCompanyResponse, Error, CreateCompanyRequest>({
    mutationFn: (input) => request<CreateCompanyResponse>('/api/companies', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  })
}

export function useInviteMember(companyId: string) {
  const qc = useQueryClient()
  return useMutation<unknown, Error, CreateMembershipRequest>({
    mutationFn: (input) =>
      request(`/api/companies/${encodeURIComponent(companyId)}/memberships`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  })
}
