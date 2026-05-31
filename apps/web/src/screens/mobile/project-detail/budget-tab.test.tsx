import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ProjectRow } from '@/lib/api'
import type { CloseoutSummaryResponse } from '../../../lib/api/closeout-summary'
import type { LaborVarianceResponse } from '../../../lib/api/labor-variance'
import type { ProjectCloseoutViewModel } from '../../../machines/project-closeout'
import type { ProjectCloseoutSnapshot } from '../../../lib/api/projects'
import type { Role } from '../../../lib/role'

/**
 * Render-smoke tests for the project-detail Budget tab. The tab composes
 * three cards — closeout summary, labor variance, and (owner-only) the
 * closeout action — plus the KPI strip from its props. The closeout card
 * now routes through the headless `useProjectCloseoutMachine` XState
 * machine (no hand-rolled TanStack-Query + 409 path), so we mock the
 * machine view-model directly to drive its loading / active / terminal /
 * submitting / outOfSync branches.
 */

const closeoutSummaryMock =
  vi.fn<() => { data: CloseoutSummaryResponse | undefined; isPending: boolean; isError: boolean }>()
const laborVarianceMock =
  vi.fn<() => { data: LaborVarianceResponse | undefined; isPending: boolean; isError: boolean }>()
const closeoutMachineMock = vi.fn<() => ProjectCloseoutViewModel>()
const dispatchSpy = vi.fn()
const navigateSpy = vi.fn()
const roleMock = vi.fn<() => Role>()

vi.mock('../../../lib/api/closeout-summary.js', () => ({
  useProjectCloseoutSummary: () => closeoutSummaryMock(),
}))
vi.mock('../../../lib/api/labor-variance.js', () => ({
  useProjectLaborVariance: () => laborVarianceMock(),
}))
vi.mock('../../../machines/project-closeout.js', () => ({
  useProjectCloseoutMachine: () => closeoutMachineMock(),
}))
vi.mock('../../../lib/api/client.js', () => ({
  getActiveCompanySlug: () => 'co',
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
}))
vi.mock('../../../lib/role.js', () => ({
  useRole: () => roleMock(),
}))

import { BudgetTab } from './budget-tab'

afterEach(() => {
  cleanup()
  closeoutSummaryMock.mockReset()
  laborVarianceMock.mockReset()
  closeoutMachineMock.mockReset()
  dispatchSpy.mockReset()
  navigateSpy.mockReset()
  roleMock.mockReset()
})

const project = (overrides: Partial<ProjectRow> = {}): ProjectRow =>
  ({
    id: 'p1',
    customer_id: null,
    name: 'Maple Tower',
    customer_name: 'Maple Co',
    division_code: 'DRY',
    status: 'in_progress',
    bid_total: '10000',
    labor_rate: '50',
    target_sqft_per_hr: null,
    bonus_pool: '0',
    closed_at: null,
    summary_locked_at: null,
    version: 3,
    created_at: '2026-05-09T00:00:00Z',
    updated_at: '2026-05-09T00:00:00Z',
    ...overrides,
  }) as ProjectRow

const summary = (overrides: Partial<CloseoutSummaryResponse> = {}): CloseoutSummaryResponse => ({
  project: { id: 'p1', name: 'Maple Tower' },
  bid: 10000,
  estimate_total: 9000,
  labor_hours: 100,
  labor_rate: 50,
  labor_actual: 5000,
  materials_actual: 1200,
  rentals_actual: 0,
  total_actual: 6200,
  margin: 3800,
  margin_pct: 38,
  ...overrides,
})

const closeoutSnapshot = (overrides: Partial<ProjectCloseoutSnapshot> = {}): ProjectCloseoutSnapshot => ({
  state: 'active',
  state_version: 1,
  next_events: [{ type: 'CLOSEOUT', label: 'Close out project' }],
  context: {
    id: 'p1',
    company_id: 'c',
    status: 'in_progress',
    closed_at: null,
    closed_by: null,
    summary_locked_at: null,
    post_mortem_acknowledged_at: null,
    post_mortem_acknowledged_by: null,
    workflow_engine: 'reducer',
    workflow_run_id: null,
    version: 3,
    created_at: '2026-05-09T00:00:00Z',
    updated_at: '2026-05-09T00:00:00Z',
  },
  ...overrides,
})

const viewModel = (overrides: Partial<ProjectCloseoutViewModel> = {}): ProjectCloseoutViewModel => ({
  snapshot: closeoutSnapshot(),
  error: null,
  outOfSync: false,
  isLoading: false,
  isSubmitting: false,
  refresh: vi.fn(),
  dispatch: dispatchSpy,
  dismissError: vi.fn(),
  ...overrides,
})

function renderTab(node: ReactNode) {
  return render(<>{node}</>)
}

describe('BudgetTab render-smoke', () => {
  it('shows the loading cards while both summary + variance queries are pending', () => {
    roleMock.mockReturnValue('worker')
    closeoutSummaryMock.mockReturnValue({ isPending: true, isError: false, data: undefined })
    laborVarianceMock.mockReturnValue({ isPending: true, isError: false, data: undefined })
    closeoutMachineMock.mockReturnValue(viewModel())

    renderTab(<BudgetTab project={project()} totalHours={100} spent={6200} bid={10000} pctSpent={62} />)
    expect(screen.getByText('Loading closeout summary…')).toBeTruthy()
    expect(screen.getByText('Loading scope variance…')).toBeTruthy()
    expect(screen.getByText('Spent vs bid')).toBeTruthy()
  })

  it('renders the calm empty states when the project has no closeout/variance data yet', () => {
    roleMock.mockReturnValue('worker')
    closeoutSummaryMock.mockReturnValue({
      isPending: false,
      isError: false,
      data: summary({ bid: 0, estimate_total: 0, labor_actual: 0, materials_actual: 0, total_actual: 0 }),
    })
    laborVarianceMock.mockReturnValue({ isPending: false, isError: false, data: { variance: [] } })
    closeoutMachineMock.mockReturnValue(viewModel())

    renderTab(<BudgetTab project={project({ bid_total: '0' })} totalHours={0} spent={0} bid={0} pctSpent={0} />)
    expect(screen.getByText(/Closeout summary fills in as labor entries/)).toBeTruthy()
    expect(screen.getByText(/No variance data yet/)).toBeTruthy()
  })

  it('renders the closeout summary rollup and variance rows when data lands', () => {
    roleMock.mockReturnValue('worker')
    closeoutSummaryMock.mockReturnValue({ isPending: false, isError: false, data: summary() })
    laborVarianceMock.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        variance: [
          {
            service_item_code: 'DRY-100',
            division_code: 'DRY',
            unit: 'sqft',
            estimated_quantity: 1000,
            actual_quantity: 1300,
            estimated_hours: 40,
            actual_hours: 52,
            quantity_variance_pct: 30,
            hours_variance_pct: 30,
          },
        ],
      },
    })
    closeoutMachineMock.mockReturnValue(viewModel())

    renderTab(<BudgetTab project={project()} totalHours={100} spent={6200} bid={10000} pctSpent={62} />)
    expect(screen.getAllByText('Closeout summary').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Margin +38.0%')).toBeTruthy()
    expect(screen.getByText('DRY-100')).toBeTruthy()
    expect(screen.getByText(/worst offenders/)).toBeTruthy()
  })

  it('renders the owner closeout action and dispatches CLOSEOUT on click (machine path, no hand-rolled 409)', () => {
    roleMock.mockReturnValue('owner')
    closeoutSummaryMock.mockReturnValue({ isPending: false, isError: false, data: summary() })
    laborVarianceMock.mockReturnValue({ isPending: false, isError: false, data: { variance: [] } })
    closeoutMachineMock.mockReturnValue(viewModel())

    renderTab(<BudgetTab project={project()} totalHours={100} spent={6200} bid={10000} pctSpent={62} />)
    const button = screen.getByText('Close out project')
    expect(button).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    fireEvent.click(button)
    expect(dispatchSpy).toHaveBeenCalledWith('CLOSEOUT')
  })

  it('surfaces the outOfSync note from the machine (no hand-derived ApiError 409)', () => {
    roleMock.mockReturnValue('owner')
    closeoutSummaryMock.mockReturnValue({ isPending: false, isError: false, data: summary() })
    laborVarianceMock.mockReturnValue({ isPending: false, isError: false, data: { variance: [] } })
    closeoutMachineMock.mockReturnValue(viewModel({ outOfSync: true }))

    renderTab(<BudgetTab project={project()} totalHours={100} spent={6200} bid={10000} pctSpent={62} />)
    expect(screen.getByText('Project state moved')).toBeTruthy()
  })

  it('disables the closeout button while the machine is submitting', () => {
    roleMock.mockReturnValue('owner')
    closeoutSummaryMock.mockReturnValue({ isPending: false, isError: false, data: summary() })
    laborVarianceMock.mockReturnValue({ isPending: false, isError: false, data: { variance: [] } })
    closeoutMachineMock.mockReturnValue(viewModel({ isSubmitting: true }))

    renderTab(<BudgetTab project={project()} totalHours={100} spent={6200} bid={10000} pctSpent={62} />)
    const button = screen.getByText('Closing out…') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(true)
  })

  it('renders the terminal "Closed out" card with an Open post-mortem affordance', () => {
    roleMock.mockReturnValue('owner')
    closeoutSummaryMock.mockReturnValue({ isPending: false, isError: false, data: summary() })
    laborVarianceMock.mockReturnValue({ isPending: false, isError: false, data: { variance: [] } })
    closeoutMachineMock.mockReturnValue(
      viewModel({
        snapshot: closeoutSnapshot({
          state: 'completed',
          state_version: 2,
          next_events: [{ type: 'ACKNOWLEDGE_POST_MORTEM', label: 'Open post-mortem' }],
          context: {
            ...closeoutSnapshot().context,
            status: 'completed',
            closed_at: '2026-05-20T00:00:00Z',
          },
        }),
      }),
    )

    renderTab(<BudgetTab project={project({ status: 'completed' })} totalHours={100} spent={6200} bid={10000} pctSpent={62} />)
    // The "Closed out" pill + the "Closed out on …" body both match.
    expect(screen.getAllByText(/Closed out/).length).toBeGreaterThanOrEqual(1)
    const openButton = screen.getByText('Open post-mortem')
    fireEvent.click(openButton)
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p1/post-mortem')
  })
})
