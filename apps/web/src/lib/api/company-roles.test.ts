import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { request } from './client'
import {
  useAssignMembershipRole,
  useCompanyRoles,
  useCreateCustomRole,
  useDeleteCustomRole,
  usePatchCustomRole,
  type CompanyRolesResponse,
} from './company-roles'

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>()
  return { ...actual, request: vi.fn() }
})

const requestMock = vi.mocked(request)

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

const rolesResponse: CompanyRolesResponse = {
  builtins: [
    { role: 'owner', actions: ['create_project'] },
    { role: 'crew', actions: ['clock_in_out'] },
  ],
  custom: [
    {
      id: 'role-1',
      name: 'Lead Foreman',
      inherit_from: 'foreman',
      created_at: '2026-06-01T00:00:00Z',
      created_by: 'u1',
      grants: [{ action: 'auth_materials', constraints: { max_amount_cents: 100000 } }],
    },
  ],
}

beforeEach(() => {
  requestMock.mockReset()
})
afterEach(() => cleanup())

describe('useCompanyRoles', () => {
  it('fetches the builtins matrix + custom roles for a company', async () => {
    requestMock.mockResolvedValueOnce(rolesResponse)
    const { result } = renderHook(() => useCompanyRoles('co-1'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(requestMock).toHaveBeenCalledWith('/api/companies/co-1/roles')
    expect(result.current.data?.custom[0]?.name).toBe('Lead Foreman')
  })

  it('is disabled (no fetch) without a company id', () => {
    renderHook(() => useCompanyRoles(null), { wrapper: wrapper() })
    expect(requestMock).not.toHaveBeenCalled()
  })
})

describe('useCreateCustomRole', () => {
  it('POSTs name + inherit_from + grants to the roles endpoint', async () => {
    requestMock.mockResolvedValueOnce({ role: rolesResponse.custom[0] })
    const { result } = renderHook(() => useCreateCustomRole('co-1'), { wrapper: wrapper() })
    await result.current.mutateAsync({
      name: 'Lead Foreman',
      inherit_from: 'foreman',
      grants: [{ action: 'auth_materials', constraints: { max_amount_cents: 100000 } }],
    })
    expect(requestMock).toHaveBeenCalledWith('/api/companies/co-1/roles', {
      method: 'POST',
      json: {
        name: 'Lead Foreman',
        inherit_from: 'foreman',
        grants: [{ action: 'auth_materials', constraints: { max_amount_cents: 100000 } }],
      },
    })
  })
})

describe('usePatchCustomRole', () => {
  it('PATCHes the role-by-id endpoint with rename + grants', async () => {
    requestMock.mockResolvedValueOnce({ role: rolesResponse.custom[0] })
    const { result } = renderHook(() => usePatchCustomRole('co-1'), { wrapper: wrapper() })
    await result.current.mutateAsync({ roleId: 'role-1', body: { name: 'Renamed', grants: [] } })
    expect(requestMock).toHaveBeenCalledWith('/api/companies/co-1/roles/role-1', {
      method: 'PATCH',
      json: { name: 'Renamed', grants: [] },
    })
  })
})

describe('useDeleteCustomRole', () => {
  it('DELETEs the role-by-id endpoint', async () => {
    requestMock.mockResolvedValueOnce({ deleted: true, unlinked_memberships: 2 })
    const { result } = renderHook(() => useDeleteCustomRole('co-1'), { wrapper: wrapper() })
    await expect(result.current.mutateAsync({ roleId: 'role-1' })).resolves.toMatchObject({
      unlinked_memberships: 2,
    })
    expect(requestMock).toHaveBeenCalledWith('/api/companies/co-1/roles/role-1', { method: 'DELETE' })
  })
})

describe('useAssignMembershipRole', () => {
  it('POSTs to the membership-role endpoint with a custom_role_id', async () => {
    requestMock.mockResolvedValueOnce({
      membership: { id: 'm1', clerk_user_id: 'u9', role: 'foreman', custom_role_id: 'role-1' },
    })
    const { result } = renderHook(() => useAssignMembershipRole('co-1'), { wrapper: wrapper() })
    await result.current.mutateAsync({ membershipId: 'm1', body: { custom_role_id: 'role-1' } })
    expect(requestMock).toHaveBeenCalledWith('/api/companies/co-1/memberships/m1/role', {
      method: 'POST',
      json: { custom_role_id: 'role-1' },
    })
  })

  it('POSTs a builtin_role to reset a member back to a base', async () => {
    requestMock.mockResolvedValueOnce({
      membership: { id: 'm1', clerk_user_id: 'u9', role: 'admin', custom_role_id: null },
    })
    const { result } = renderHook(() => useAssignMembershipRole('co-1'), { wrapper: wrapper() })
    await result.current.mutateAsync({ membershipId: 'm1', body: { builtin_role: 'owner' } })
    expect(requestMock).toHaveBeenCalledWith('/api/companies/co-1/memberships/m1/role', {
      method: 'POST',
      json: { builtin_role: 'owner' },
    })
  })
})
