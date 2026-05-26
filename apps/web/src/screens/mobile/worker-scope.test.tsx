import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import type { ProjectBriefListResponse } from '@/lib/api/projects'

/**
 * Render-smoke tests for the worker "Today's scope" screen. The screen
 * renders today's most-recent brief, which it pulls via
 * `useProjectBriefs` (lib/api/projects). We mock that hook to return the
 * "no brief yet" (empty) and the "brief with steps" shapes and assert
 * each branch renders without crashing. The active project comes from the
 * bootstrap prop, so no other api mocking is needed.
 */

const useProjectBriefsMock = vi.fn<() => { data?: ProjectBriefListResponse }>()

vi.mock('../../lib/api/projects.js', () => ({
  useProjectBriefs: () => useProjectBriefsMock(),
}))

import { WorkerScope } from './worker-scope'

afterEach(() => {
  cleanup()
  useProjectBriefsMock.mockReset()
})

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

const project = (overrides: Partial<BootstrapResponse['projects'][number]> = {}) =>
  ({
    id: 'p1',
    customer_id: null,
    name: 'Maple Tower',
    customer_name: 'Maple Co',
    division_code: 'DRY',
    status: 'in_progress',
    bid_total: '0',
    labor_rate: '50',
    target_sqft_per_hr: '1000',
    bonus_pool: '0',
    closed_at: null,
    summary_locked_at: null,
    version: 1,
    created_at: '2026-05-09T00:00:00Z',
    updated_at: '2026-05-09T00:00:00Z',
    ...overrides,
  }) as BootstrapResponse['projects'][number]

const brief = (steps: unknown[]): ProjectBriefListResponse =>
  ({
    briefs: [
      {
        id: 'b1',
        company_id: 'c',
        project_id: 'p1',
        foreman_user_id: 'f1',
        effective_date: '2026-05-26',
        goal: 'Hang and tape the north wall by lunch.',
        steps,
        crew: [],
        materials: [],
        version: 1,
        created_at: '2026-05-26T13:00:00Z',
        updated_at: '2026-05-26T13:00:00Z',
      },
    ],
  }) as ProjectBriefListResponse

describe('WorkerScope render-smoke', () => {
  it('renders the awaiting-brief placeholder when no active project / no brief', () => {
    useProjectBriefsMock.mockReturnValue({ data: { briefs: [] } })
    wrap(<WorkerScope bootstrap={emptyBootstrap({ projects: [] })} />)
    expect(screen.getByText('Scope')).toBeTruthy()
    expect(screen.getByText('Awaiting brief')).toBeTruthy()
    expect(screen.getByText(/No active project/)).toBeTruthy()
  })

  it('renders the empty-steps hint when the active project has a brief with no steps', () => {
    useProjectBriefsMock.mockReturnValue({ data: brief([]) })
    wrap(<WorkerScope bootstrap={emptyBootstrap({ projects: [project()] })} />)
    expect(screen.getByText('Hang and tape the north wall by lunch.')).toBeTruthy()
    expect(screen.getByText(/No steps in today/)).toBeTruthy()
  })

  it('renders the goal and step rows when the brief has steps', () => {
    useProjectBriefsMock.mockReturnValue({
      data: brief([
        { id: 's1', title: 'Hang board', duration_min: 90, status: 'done' },
        { id: 's2', title: 'Tape seams', duration_min: 60, status: 'in_progress' },
      ]),
    })
    wrap(<WorkerScope bootstrap={emptyBootstrap({ projects: [project()] })} />)
    expect(screen.getByText('Hang and tape the north wall by lunch.')).toBeTruthy()
    expect(screen.getByText('Hang board')).toBeTruthy()
    expect(screen.getByText('Tape seams')).toBeTruthy()
    // The in-progress step shows the "NOW" tag.
    expect(screen.getByText('NOW')).toBeTruthy()
  })
})
