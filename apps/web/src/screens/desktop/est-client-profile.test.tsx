import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import type { Customer } from '@/lib/api/customers'
import type { ProjectListRow } from '@/lib/api/projects'

/**
 * EstClientProfile route wire-through: the "New project" CTA must navigate to
 * the DESKTOP new-project route (`/desktop/projects/new`). It previously
 * navigated to `/projects/new`, which is the mobile shell's form — a desktop
 * estimator clicking it landed on the wrong (mobile) screen. The customer_id
 * intent is preserved in the query string.
 */

const mocks = vi.hoisted(() => ({
  useCustomers: vi.fn(),
  useProjects: vi.fn(),
}))

vi.mock('@/lib/api/customers', () => ({ useCustomers: mocks.useCustomers }))
vi.mock('@/lib/api/projects', () => ({ useProjects: mocks.useProjects }))

import { EstClientProfile } from './est-client-profile'

const CLIENT_ID = 'cust-1'

function customer(): Customer {
  return {
    id: CLIENT_ID,
    external_id: null,
    name: 'Maple Builders',
    source: 'sitelayer',
    version: 1,
    deleted_at: null,
    created_at: '2026-01-02T00:00:00Z',
  }
}

function project(): ProjectListRow {
  return {
    id: 'proj-1',
    name: 'Maple Tower',
    customer_id: CLIENT_ID,
    status: 'in_progress',
    bid_total: '1000',
    division_code: 'D4',
    created_at: '2026-02-01T00:00:00Z',
  } as ProjectListRow
}

// Renders the current pathname+search so the test can assert where a
// navigate() landed without spying on react-router internals.
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

function wrap() {
  return render(
    <MemoryRouter initialEntries={[`/desktop/clients/${CLIENT_ID}`]}>
      <Routes>
        <Route path="/desktop/clients/:clientId" element={<EstClientProfile />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.useCustomers.mockReturnValue({ data: { customers: [customer()] }, isPending: false, isError: false })
  mocks.useProjects.mockReturnValue({ data: { projects: [project()] }, isPending: false, isError: false })
})

afterEach(cleanup)

describe('EstClientProfile — New project CTA route', () => {
  it('navigates to the desktop new-project route, carrying customer_id', () => {
    wrap()
    fireEvent.click(screen.getByText('New project'))
    expect(screen.getByTestId('loc').textContent).toBe(`/desktop/projects/new?customer_id=${CLIENT_ID}`)
  })

  it('does NOT navigate to the mobile-shell /projects/new form', () => {
    wrap()
    fireEvent.click(screen.getByText('New project'))
    expect(screen.getByTestId('loc').textContent?.startsWith('/projects/new')).toBe(false)
  })
})
