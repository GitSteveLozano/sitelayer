// Companies — onboarding wizard endpoints (Phase 6 Batch 7).
// Wraps POST /api/companies and POST /api/companies/:id/memberships.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, request } from './client'

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

/**
 * Pull the server-suggested slug from a 409 `ApiError` body, if any.
 * Returns `null` for any other shape (network error, 4xx without a
 * `suggested_slug` field, 5xx) so callers can fall through to the
 * generic error path. Lives next to the create hook so the shape stays
 * in sync with the API contract.
 *
 * See `apps/api/src/routes/companies.ts` — the slug-collision branch
 * probes `<slug>-2`..`<slug>-10` and emits
 * `{ error: 'slug already taken', suggested_slug }` when a free
 * candidate is found.
 */
export function suggestedSlugFromError(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  if (err.status !== 409) return null
  const body = err.body
  if (!body || typeof body !== 'object') return null
  const candidate = (body as { suggested_slug?: unknown }).suggested_slug
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
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

export interface CompanySettings {
  ot_service_item_code: string | null
}

export function useCompanySettings(companyId: string | null | undefined) {
  return useQuery<CompanySettings>({
    queryKey: ['companies', companyId ?? '', 'settings'],
    enabled: Boolean(companyId),
    queryFn: () => request<CompanySettings>(`/api/companies/${encodeURIComponent(companyId!)}/settings`),
  })
}

export function usePatchCompanySettings(companyId: string) {
  const qc = useQueryClient()
  return useMutation<CompanySettings, Error, { ot_service_item_code: string | null }>({
    mutationFn: (input) =>
      request<CompanySettings>(`/api/companies/${encodeURIComponent(companyId)}/settings`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies', companyId, 'settings'] }),
  })
}

// ---- Company profile (migration 102) -------------------------------------
// Editable scalar identity fields surfaced in Owner Settings → Company.
// Read via GET /api/companies/:id/profile; saved via PATCH (admin-only).
// Every field is nullable; an unsaved field reads back `null`.
export interface CompanyProfile {
  legal_name: string | null
  license_no: string | null
  address: string | null
  phone: string | null
  website: string | null
}

export function useCompanyProfile(companyId: string | null | undefined) {
  return useQuery<CompanyProfile>({
    queryKey: ['companies', companyId ?? '', 'profile'],
    enabled: Boolean(companyId),
    queryFn: () => request<CompanyProfile>(`/api/companies/${encodeURIComponent(companyId!)}/profile`),
  })
}

export function useUpdateCompanyProfile(companyId: string) {
  const qc = useQueryClient()
  // PATCH takes a partial diff: send only the fields that changed. A field
  // set to `null` clears it; omitting it leaves it untouched.
  return useMutation<CompanyProfile, Error, Partial<CompanyProfile>>({
    mutationFn: (input) =>
      request<CompanyProfile>(`/api/companies/${encodeURIComponent(companyId)}/profile`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies', companyId, 'profile'] }),
  })
}

// ---- Working hours (migration 102) ---------------------------------------
// Standard work window + working days + holidays. GET returns the saved
// document or `null` (the UI falls back to defaults); PUT replaces the whole
// document (admin-only).
export type WorkingHoursWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
export type WorkingHoursOtRule = '8h' | '10h' | '40w'
export interface WorkingHoursHoliday {
  name: string
  date: string
}
export interface WorkingHours {
  days: Record<WorkingHoursWeekday, boolean>
  day_start: string
  day_end: string
  ot_rule: WorkingHoursOtRule
  holidays: WorkingHoursHoliday[]
}
export interface WorkingHoursResponse {
  working_hours: WorkingHours | null
}

export function useWorkingHours(companyId: string | null | undefined) {
  return useQuery<WorkingHoursResponse>({
    queryKey: ['companies', companyId ?? '', 'working-hours'],
    enabled: Boolean(companyId),
    queryFn: () =>
      request<WorkingHoursResponse>(`/api/companies/${encodeURIComponent(companyId!)}/working-hours`),
  })
}

export function useUpdateWorkingHours(companyId: string) {
  const qc = useQueryClient()
  return useMutation<WorkingHoursResponse, Error, WorkingHours>({
    mutationFn: (input) =>
      request<WorkingHoursResponse>(`/api/companies/${encodeURIComponent(companyId)}/working-hours`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies', companyId, 'working-hours'] }),
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
