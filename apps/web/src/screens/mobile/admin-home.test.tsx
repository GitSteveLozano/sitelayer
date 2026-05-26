import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { AdminHome } from './admin-home'

/**
 * Render-smoke tests for the admin "Today" dashboard. The screen is a
 * pure renderer of its `bootstrap` prop plus `useNavigate`, so a
 * MemoryRouter wrapper and a minimal bootstrap fixture are enough — no
 * api/TanStack mocking required.
 */

afterEach(cleanup)

function wrap(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

// Mirrors the proven fixture shape from foreman-today.test.ts so the
// BootstrapResponse type stays satisfied.
function emptyBootstrap(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    company: { id: 'c', name: 'Acme Builders', slug: 'acme' },
    template: { slug: 't', name: 'T', description: '' },
    workflowStages: [],
    divisions: [],
    serviceItems: [],
    customers: [],
    projects: [],
    workers: [],
    pricingProfiles: [],
    bonusRules: [],
    integrations: [],
    integrationMappings: [],
    laborEntries: [],
    materialBills: [],
    schedules: [],
    ...overrides,
  }
}

const project = (overrides: Partial<BootstrapResponse['projects'][number]>) =>
  ({
    id: 'p1',
    customer_id: null,
    name: 'Maple Tower',
    customer_name: 'Maple Co',
    division_code: 'DRY',
    status: 'in_progress',
    bid_total: '0',
    labor_rate: '0',
    target_sqft_per_hr: null,
    bonus_pool: '0',
    closed_at: null,
    summary_locked_at: null,
    version: 1,
    created_at: '2026-05-09T00:00:00Z',
    updated_at: '2026-05-09T00:00:00Z',
    ...overrides,
  }) as BootstrapResponse['projects'][number]

describe('AdminHome render-smoke', () => {
  it('renders just the Today top bar when bootstrap is null', () => {
    wrap(<AdminHome bootstrap={null} />)
    expect(screen.getByText('Today')).toBeTruthy()
  })

  it('renders the empty state when there are no projects', () => {
    wrap(<AdminHome bootstrap={emptyBootstrap({ projects: [] })} />)
    expect(screen.getByText('No projects yet')).toBeTruthy()
    // The empty-state body copy is unique to this branch.
    expect(screen.getByText(/Start with an address or upload drawings/)).toBeTruthy()
    // Both the top-bar action and the empty-state CTA are labelled
    // "New project", so assert at least one such button is present.
    expect(screen.getAllByRole('button', { name: 'New project' }).length).toBeGreaterThanOrEqual(1)
  })

  it('shows the calm "caught up" hero when projects exist but none are active', () => {
    const bootstrap = emptyBootstrap({
      projects: [project({ id: 'sent1', status: 'sent', name: 'Cedar Reno' })],
    })
    wrap(<AdminHome bootstrap={bootstrap} />)
    expect(screen.getByText("You're caught up.")).toBeTruthy()
  })

  it('renders active projects in the "Today on site" list and lets you switch the segmented control', () => {
    const bootstrap = emptyBootstrap({
      projects: [
        project({ id: 'a', status: 'in_progress', name: 'Maple Tower' }),
        project({ id: 'b', status: 'in_progress', name: 'Birch Lofts' }),
      ],
    })
    wrap(<AdminHome bootstrap={bootstrap} />)
    expect(screen.getByText(/2 sites running/)).toBeTruthy()
    expect(screen.getByText('Maple Tower')).toBeTruthy()
    expect(screen.getByText('Birch Lofts')).toBeTruthy()

    // The "What needs me" chip switches the view without throwing.
    fireEvent.click(screen.getByRole('button', { name: /What needs me/ }))
    expect(screen.getByText(/sorted by impact/i)).toBeTruthy()
  })
})
