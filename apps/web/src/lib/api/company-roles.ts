// Custom-role management — wraps the RBAC-A overhaul API:
//   GET    /api/companies/:id/roles                  (admin: builtins matrix + custom roles)
//   POST   /api/companies/:id/roles                  (admin: create custom role + grants)
//   PATCH  /api/companies/:id/roles/:roleId          (admin: rename / replace grants)
//   DELETE /api/companies/:id/roles/:roleId          (admin: soft-delete + unlink members)
//   POST   /api/companies/:id/memberships/:mId/role  (admin: assign custom/builtin role)
//
// See apps/api/src/routes/company-roles.ts and packages/domain/src/permissions.ts.
// Built-in roles are the immutable system contract in @sitelayer/domain — the
// GET surfaces their action matrix read-only; only CUSTOM roles (migration 136:
// custom_roles + custom_role_grants) are editable here. A custom role inherits
// one of the five built-in bases and additively grants extra named actions, each
// optionally carrying an integer constraint (auth_materials → max_amount_cents,
// the live $-cap; approve_time → max_ot_hours_per_week, stored but INERT in v1).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BuiltinRole, PermissionAction } from '@sitelayer/domain'
import { request } from './client'

/** A single grant on a custom role: an action plus optional integer caps. */
export interface CustomRoleGrant {
  action: PermissionAction
  /** e.g. { max_amount_cents: 100000 }. null/absent = uncapped. */
  constraints: Record<string, number> | null
}

/** A per-company custom role (custom_roles row + its grants). */
export interface CustomRole {
  id: string
  name: string
  inherit_from: BuiltinRole
  created_at: string
  created_by: string | null
  grants: CustomRoleGrant[]
}

/** One built-in role row from the read-only matrix view. */
export interface BuiltinRoleView {
  role: BuiltinRole
  actions: PermissionAction[]
}

/** GET /api/companies/:id/roles response. */
export interface CompanyRolesResponse {
  builtins: BuiltinRoleView[]
  custom: CustomRole[]
}

export interface CreateCustomRoleRequest {
  name: string
  inherit_from: BuiltinRole
  grants?: CustomRoleGrant[]
}

export interface PatchCustomRoleRequest {
  name?: string
  grants?: CustomRoleGrant[]
}

export interface AssignMembershipRoleRequest {
  /** Assign a custom role (string) or clear it back to the raw company role (null). */
  custom_role_id?: string | null
  /** Or reset the member to a built-in base (clears any custom link). */
  builtin_role?: BuiltinRole
}

export interface AssignMembershipRoleResponse {
  membership: { id: string; clerk_user_id: string; role: string; custom_role_id: string | null }
}

const companyRolesKey = (companyId: string) => ['companies', companyId, 'roles'] as const

export function useCompanyRoles(companyId: string | null | undefined) {
  return useQuery<CompanyRolesResponse>({
    queryKey: companyRolesKey(companyId ?? ''),
    enabled: Boolean(companyId),
    queryFn: () => request<CompanyRolesResponse>(`/api/companies/${encodeURIComponent(companyId!)}/roles`),
  })
}

export function useCreateCustomRole(companyId: string) {
  const qc = useQueryClient()
  return useMutation<{ role: CustomRole }, Error, CreateCustomRoleRequest>({
    mutationFn: (input) =>
      request<{ role: CustomRole }>(`/api/companies/${encodeURIComponent(companyId)}/roles`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: companyRolesKey(companyId) }),
  })
}

export function usePatchCustomRole(companyId: string) {
  const qc = useQueryClient()
  return useMutation<{ role: CustomRole }, Error, { roleId: string; body: PatchCustomRoleRequest }>({
    mutationFn: ({ roleId, body }) =>
      request<{ role: CustomRole }>(
        `/api/companies/${encodeURIComponent(companyId)}/roles/${encodeURIComponent(roleId)}`,
        { method: 'PATCH', json: body },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: companyRolesKey(companyId) }),
  })
}

export function useDeleteCustomRole(companyId: string) {
  const qc = useQueryClient()
  return useMutation<{ deleted: boolean; unlinked_memberships: number }, Error, { roleId: string }>({
    mutationFn: ({ roleId }) =>
      request<{ deleted: boolean; unlinked_memberships: number }>(
        `/api/companies/${encodeURIComponent(companyId)}/roles/${encodeURIComponent(roleId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: companyRolesKey(companyId) }),
  })
}

export function useAssignMembershipRole(companyId: string) {
  const qc = useQueryClient()
  return useMutation<AssignMembershipRoleResponse, Error, { membershipId: string; body: AssignMembershipRoleRequest }>({
    mutationFn: ({ membershipId, body }) =>
      request<AssignMembershipRoleResponse>(
        `/api/companies/${encodeURIComponent(companyId)}/memberships/${encodeURIComponent(membershipId)}/role`,
        { method: 'POST', json: body },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: companyRolesKey(companyId) }),
  })
}
