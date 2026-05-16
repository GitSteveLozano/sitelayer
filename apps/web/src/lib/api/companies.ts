// Companies — onboarding wizard endpoints (Phase 6 Batch 7).
// Wraps POST /api/companies and POST /api/companies/:id/memberships.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

export interface CompanyModules {
  takeoff: boolean
  estimating: boolean
  field_labor: boolean
  rental_ops: boolean
  scaffold_design: boolean
  scaffold_bom: boolean
  scaffold_inspections: boolean
  customer_portal: boolean
  payroll_exports: boolean
}

export interface CompanyPortalSettings {
  show_estimates: boolean
  show_invoices: boolean
  show_photos: boolean
  show_inspections: boolean
}

export interface CompanyModulesResponse {
  modules: CompanyModules
  portal_settings: CompanyPortalSettings
}

export function useCompanyModules(companyId: string | null | undefined) {
  return useQuery<CompanyModulesResponse>({
    queryKey: ['companies', companyId ?? '', 'modules'],
    enabled: Boolean(companyId),
    queryFn: () => request<CompanyModulesResponse>(`/api/companies/${encodeURIComponent(companyId!)}/modules`),
  })
}

export function usePatchCompanyModules(companyId: string) {
  const qc = useQueryClient()
  return useMutation<
    CompanyModulesResponse,
    Error,
    { modules?: Partial<CompanyModules>; portal_settings?: Partial<CompanyPortalSettings> }
  >({
    mutationFn: (input) =>
      request<CompanyModulesResponse>(`/api/companies/${encodeURIComponent(companyId)}/modules`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies', companyId, 'modules'] }),
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
