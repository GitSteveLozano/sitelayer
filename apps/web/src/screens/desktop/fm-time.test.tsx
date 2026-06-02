import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import type { TimeReviewMachineSnapshot } from '@/machines/time-review'
import type { TimeReviewSnapshot } from '@/lib/api/time-review'

/**
 * Desktop FM-time wire-through tests: the footer dispatches a run-level
 * APPROVE through useTimeReview (no per-row labor PATCH), and the action
 * set is driven by snapshot.next_events.
 */

const mocks = vi.hoisted(() => ({
  useTimeReview: vi.fn(),
  useTimeReviewRuns: vi.fn(),
  useCreateTimeReviewRun: vi.fn(),
  patchLaborMutateAsync: vi.fn(),
  createRunMutate: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock('@/machines/time-review', () => ({ useTimeReview: mocks.useTimeReview }))
vi.mock('@/lib/control-plane-probe-pub', () => ({ useControlPlaneProbePublish: vi.fn() }))
vi.mock('@/lib/api/client', () => ({ getActiveCompanySlug: () => 'acme' }))
vi.mock('@/lib/api/labor-entries', () => ({
  usePatchLaborEntry: () => ({
    mutateAsync: mocks.patchLaborMutateAsync,
    isPending: false,
    variables: undefined,
    error: null,
  }),
}))
vi.mock('@/lib/api/time-review', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/time-review')>('@/lib/api/time-review')
  return {
    ...actual,
    useTimeReviewRuns: mocks.useTimeReviewRuns,
    useCreateTimeReviewRun: mocks.useCreateTimeReviewRun,
  }
})

// Phase B responsive consolidation: FmTime (the desktop time-review surface)
// moved into the merged screens/mobile/foreman-time-entry.tsx; the standalone
// screens/desktop/fm-time.tsx twin was deleted. The mocked hook modules are
// referenced by their `@/` aliases (resolved-path mocks), so they still apply.
import { FmTime } from '../mobile/foreman-time-entry'

const RUN_ID = '00000000-0000-4000-8000-000000000001'

function snapshot(): TimeReviewSnapshot {
  return {
    state: 'pending',
    state_version: 1,
    context: {
      id: RUN_ID,
      company_id: 'c',
      project_id: null,
      period_start: '2026-04-27',
      period_end: '2026-05-03',
      covered_entry_ids: ['le-1'],
      total_hours: '8',
      total_entries: 1,
      anomaly_count: 1,
      reviewer_user_id: null,
      approved_at: null,
      rejected_at: null,
      rejection_reason: null,
      reopened_at: null,
      workflow_engine: 'postgres',
      workflow_run_id: null,
      origin: null,
      created_at: '',
      updated_at: '',
      anomalies: [
        {
          entry_id: 'le-1',
          anomalies: [
            { code: 'overlap', message: 'overlap' },
            { code: 'geofence', message: 'off-site' },
          ],
        },
      ],
    },
    next_events: [
      { type: 'APPROVE', label: 'Approve run' },
      { type: 'REJECT', label: 'Reject — needs corrections' },
    ],
  }
}

function machine(overrides: Partial<TimeReviewMachineSnapshot> = {}): TimeReviewMachineSnapshot {
  return {
    snapshot: snapshot(),
    error: null,
    outOfSync: false,
    isLoading: false,
    isSubmitting: false,
    refresh: vi.fn(),
    dispatch: mocks.dispatch,
    dismissError: vi.fn(),
    ...overrides,
  }
}

function bootstrap(): BootstrapResponse {
  return {
    company: { id: 'c', name: 'Acme', slug: 'acme' },
    template: { slug: 't', name: 'T', description: '' },
    workflowStages: [],
    divisions: [],
    serviceItems: [],
    customers: [],
    projects: [{ id: 'p1', name: 'Maple Tower', labor_rate: '50' } as BootstrapResponse['projects'][number]],
    workers: [{ id: 'w1', name: 'Jordan Diaz' } as BootstrapResponse['workers'][number]],
    pricingProfiles: [],
    bonusRules: [],
    integrations: [],
    integrationMappings: [],
    laborEntries: [
      {
        id: 'le-1',
        project_id: 'p1',
        worker_id: 'w1',
        occurred_on: '2026-04-28',
        hours: '8',
        sqft_done: '0',
        version: 1,
        service_item_code: 'DRY-100',
        status: 'pending',
        deleted_at: null,
        created_at: '2026-04-28T00:00:00Z',
      } as BootstrapResponse['laborEntries'][number],
    ],
    materialBills: [],
    schedules: [],
  }
}

function wrap(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

beforeEach(() => {
  mocks.dispatch.mockReset()
  mocks.patchLaborMutateAsync.mockReset()
  mocks.useTimeReview.mockReturnValue(machine())
  mocks.useTimeReviewRuns.mockReturnValue({ data: { timeReviewRuns: [{ id: RUN_ID, anomaly_count: 1 }] } })
  mocks.useCreateTimeReviewRun.mockReturnValue({ mutate: mocks.createRunMutate, isPending: false })
})

afterEach(cleanup)

describe('FmTime wire-through', () => {
  it('dispatches run-level APPROVE from the footer and fires no labor PATCH', () => {
    wrap(<FmTime bootstrap={bootstrap()} />)
    const approve = screen.getByText(/Approve .* clean/i)
    fireEvent.click(approve)
    expect(mocks.dispatch).toHaveBeenCalledWith({ event: 'APPROVE' })
    expect(mocks.patchLaborMutateAsync).not.toHaveBeenCalled()
  })

  it('renders the full anomaly stack (chip per anomaly)', () => {
    wrap(<FmTime bootstrap={bootstrap()} />)
    expect(screen.getByText('OT')).toBeTruthy()
    expect(screen.getByText('OFF-SITE')).toBeTruthy()
  })
})
