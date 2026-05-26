import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { MobileProjectsList } from './projects-list'

/**
 * Render-smoke tests for the mobile projects list. Like AdminHome it is a
 * pure renderer of `bootstrap` + `useNavigate`, with local filter/search
 * state — no api hooks to mock.
 */

afterEach(cleanup)

function wrap(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

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

describe('MobileProjectsList render-smoke', () => {
  it('renders the Projects top bar and search input even when bootstrap is null', () => {
    wrap(<MobileProjectsList bootstrap={null} />)
    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.getByPlaceholderText('Search projects, clients…')).toBeTruthy()
  })

  it('shows the empty state when there are no projects', () => {
    wrap(<MobileProjectsList bootstrap={emptyBootstrap({ projects: [] })} />)
    expect(screen.getByText('No projects yet')).toBeTruthy()
  })

  it('lists active projects and keeps the search input editable', () => {
    const bootstrap = emptyBootstrap({
      projects: [
        project({ id: 'a', name: 'Maple Tower', status: 'in_progress' }),
        project({ id: 'b', name: 'Birch Lofts', status: 'in_progress' }),
      ],
    })
    wrap(<MobileProjectsList bootstrap={bootstrap} />)
    expect(screen.getByText('Maple Tower')).toBeTruthy()
    expect(screen.getByText('Birch Lofts')).toBeTruthy()

    // Smoke-check that typing into the controlled search input is wired
    // and doesn't throw. (Filtering correctness is covered via the
    // status-chip filter below, which is exercised through onClick.)
    const search = screen.getByPlaceholderText('Search projects, clients…') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'maple' } })
    expect(search.value).toBe('maple')
  })

  it('shows the no-match message when the filter excludes every project', () => {
    const bootstrap = emptyBootstrap({
      projects: [project({ id: 'a', name: 'Maple Tower', status: 'in_progress' })],
    })
    wrap(<MobileProjectsList bootstrap={bootstrap} />)
    // Switch to the "Closeout" filter — the lone in_progress project drops out.
    fireEvent.click(screen.getByRole('button', { name: /Closeout/ }))
    expect(screen.getByText('No projects match this filter.')).toBeTruthy()
  })
})
