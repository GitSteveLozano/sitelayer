import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { CompanyRolesResponse } from '@/lib/api'

/**
 * Render-smoke for the wired mobile Roles + custom-role-create screens. The
 * built-in matrix is read-only (built-ins are immutable); the custom-roles list
 * comes from GET /api/companies/:id/roles; CustomRoleScreen POSTs the encoded
 * grants (including the auth_materials $-cap as integer cents and the inert OT
 * cap as whole hours).
 */

interface CreateRoleArg {
  name: string
  inherit_from: string
  grants: Array<{ action: string; constraints: Record<string, number> | null }>
}

const useActiveCompanyIdMock = vi.fn<() => string | null>()
const useCompanyRolesMock = vi.fn()
const mutateAsyncMock = vi.fn(async (_arg: CreateRoleArg) => ({ role: {} }))
const useCreateCustomRoleMock = vi.fn(() => ({ mutateAsync: mutateAsyncMock, isPending: false }))

vi.mock('@/lib/api/active-company', () => ({
  useActiveCompanyId: () => useActiveCompanyIdMock(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    useCompanyRoles: () => useCompanyRolesMock(),
    useCreateCustomRole: () => useCreateCustomRoleMock(),
    // The screens also import these data hooks at module scope; stub the few
    // that RolesScreen/CustomRoleScreen don't use but live in the same module
    // are unaffected because only these two components are rendered here.
  }
})

import { RolesScreen, CustomRoleScreen } from './owner-settings-mobile'

const fullMatrix: CompanyRolesResponse = {
  builtins: [
    { role: 'owner', actions: ['create_project', 'edit_pricing_book', 'auth_materials'] },
    { role: 'estimator', actions: ['create_project', 'edit_pricing_book'] },
    { role: 'foreman', actions: ['brief_crew', 'submit_daily_log', 'approve_time'] },
    { role: 'crew', actions: ['clock_in_out'] },
    { role: 'bookkeeper', actions: ['flag_issue'] },
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
  useActiveCompanyIdMock.mockReturnValue('co-1')
  useCompanyRolesMock.mockReturnValue({ data: fullMatrix, isPending: false, isError: false })
  useCreateCustomRoleMock.mockReturnValue({ mutateAsync: mutateAsyncMock, isPending: false })
  mutateAsyncMock.mockClear()
})
afterEach(() => cleanup())

function wrap(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

describe('RolesScreen', () => {
  it('renders the read-only built-in matrix and the custom-roles list', () => {
    wrap(<RolesScreen navigate={() => undefined} />)
    expect(screen.getByText('5 built-in roles')).toBeTruthy()
    // Action labels from the matrix.
    expect(screen.getByText('Auth materials · $')).toBeTruthy()
    // Custom role row with its capped grant summarized.
    expect(screen.getByText('Lead Foreman')).toBeTruthy()
    expect(screen.getByText(/Inherits Foreman ·.*1,000/)).toBeTruthy()
  })

  it('shows the empty state when there are no custom roles', () => {
    useCompanyRolesMock.mockReturnValue({
      data: { ...fullMatrix, custom: [] },
      isPending: false,
      isError: false,
    })
    wrap(<RolesScreen navigate={() => undefined} />)
    expect(screen.getByText(/No custom roles yet/)).toBeTruthy()
  })
})

describe('CustomRoleScreen', () => {
  it('POSTs the encoded grants (cents + whole hours) on create', async () => {
    const navigate = vi.fn()
    wrap(<CustomRoleScreen navigate={navigate} />)

    // Name the role.
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Site Lead' } })
    // Defaults: inherit=foreman, auth_materials $1000 on, approve_time inherited by
    // foreman so it is filtered out of the POST. Submit.
    fireEvent.click(screen.getByText('Create role'))

    await vi.waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1))
    const arg = mutateAsyncMock.mock.calls[0]![0]
    expect(arg.name).toBe('Site Lead')
    expect(arg.inherit_from).toBe('foreman')
    // auth_materials is NOT in foreman's base, so it's sent with the $1000 cap.
    const auth = arg.grants.find((g) => g.action === 'auth_materials')
    expect(auth?.constraints).toEqual({ max_amount_cents: 100000 })
    // approve_time IS in foreman's base → filtered out (additive no-op).
    expect(arg.grants.find((g) => g.action === 'approve_time')).toBeUndefined()
    expect(navigate).toHaveBeenCalledWith('/more/roles')
  })

  it('blocks create with an empty name', () => {
    const navigate = vi.fn()
    wrap(<CustomRoleScreen navigate={navigate} />)
    fireEvent.click(screen.getByText('Create role'))
    expect(screen.getByText('Give the role a name.')).toBeTruthy()
    expect(mutateAsyncMock).not.toHaveBeenCalled()
  })
})
