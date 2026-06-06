import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import type { TimeReviewMachineSnapshot } from '@/machines/time-review'
import type { TimeReviewSnapshot } from '@/lib/api/time-review'

/**
 * Screen tests for the headless-first time-review wire-through. The
 * backend reducer + the useTimeReview machine are unit-tested elsewhere
 * (machines/time-review.test.ts); these assert the SCREEN dispatches a
 * single run-level APPROVE event (not N per-row labor PATCHes) and that
 * the footer is driven by snapshot.next_events.
 */

const mocks = vi.hoisted(() => ({
  useTimeReview: vi.fn(),
  useTimeReviewRuns: vi.fn(),
  useCreateTimeReviewRun: vi.fn(),
  patchLaborMutateAsync: vi.fn(),
  createRunMutate: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock('@/machines/time-review', () => ({
  useTimeReview: mocks.useTimeReview,
}))

vi.mock('@/lib/control-plane-probe-pub', () => ({
  useControlPlaneProbePublish: vi.fn(),
}))

vi.mock('../../lib/api/time-review.js', async () => {
  const actual = await vi.importActual<typeof import('./../../lib/api/time-review')>('../../lib/api/time-review')
  return {
    ...actual,
    useTimeReviewRuns: mocks.useTimeReviewRuns,
    useCreateTimeReviewRun: mocks.useCreateTimeReviewRun,
  }
})

vi.mock('../../lib/api/labor-entries.js', () => ({
  usePatchLaborEntry: () => ({
    mutateAsync: mocks.patchLaborMutateAsync,
    isPending: false,
    variables: undefined,
    error: null,
  }),
}))

vi.mock('@/lib/api/client', () => ({
  getActiveCompanySlug: () => 'acme',
}))

import { MobileTimeReview } from './time-review'

const RUN_ID = '00000000-0000-4000-8000-000000000001'

function snapshot(overrides: Partial<TimeReviewSnapshot> = {}): TimeReviewSnapshot {
  return {
    state: 'pending',
    state_version: 1,
    context: {
      id: RUN_ID,
      company_id: 'c',
      project_id: null,
      period_start: '2026-04-27',
      period_end: '2026-05-03',
      covered_entry_ids: ['le-1', 'le-2'],
      total_hours: '16',
      total_entries: 2,
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
      anomalies: [{ entry_id: 'le-1', anomalies: [{ code: 'overlap', message: 'overlaps another entry' }] }],
      ...overrides.context,
    },
    next_events: [
      { type: 'APPROVE', label: 'Approve run' },
      { type: 'REJECT', label: 'Reject — needs corrections' },
    ],
    ...overrides,
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

function bootstrap(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    company: { id: 'c', name: 'Acme', slug: 'acme' },
    template: { slug: 't', name: 'T', description: '' },
    workflowStages: [],
    divisions: [],
    serviceItems: [],
    customers: [],
    projects: [
      {
        id: 'p1',
        customer_id: null,
        name: 'Maple Tower',
        customer_name: 'Maple Co',
        division_code: 'DRY',
        status: 'in_progress',
        bid_total: '0',
        labor_rate: '50',
        target_sqft_per_hr: null,
        bonus_pool: '0',
        closed_at: null,
        summary_locked_at: null,
        version: 1,
        created_at: '2026-04-27T00:00:00Z',
        updated_at: '2026-04-27T00:00:00Z',
      } as BootstrapResponse['projects'][number],
    ],
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
        status: 'pending',
        service_item_code: 'DRY-100',
        deleted_at: null,
        created_at: '2026-04-28T00:00:00Z',
      } as BootstrapResponse['laborEntries'][number],
      {
        id: 'le-2',
        project_id: 'p1',
        worker_id: 'w1',
        occurred_on: '2026-04-29',
        hours: '8',
        sqft_done: '0',
        version: 1,
        status: 'pending',
        service_item_code: 'DRY-100',
        deleted_at: null,
        created_at: '2026-04-29T00:00:00Z',
      } as BootstrapResponse['laborEntries'][number],
    ],
    materialBills: [],
    schedules: [],
    ...overrides,
  }
}

function wrap(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

beforeEach(() => {
  mocks.dispatch.mockReset()
  mocks.patchLaborMutateAsync.mockReset()
  mocks.createRunMutate.mockReset()
  mocks.useTimeReview.mockReturnValue(machine())
  mocks.useTimeReviewRuns.mockReturnValue({
    data: { timeReviewRuns: [{ id: RUN_ID, anomaly_count: 1 }] },
  })
  mocks.useCreateTimeReviewRun.mockReturnValue({ mutate: mocks.createRunMutate, isPending: false })
})

afterEach(cleanup)

describe('MobileTimeReview wire-through', () => {
  it('dispatches a single run-level APPROVE (not per-row labor PATCH)', () => {
    wrap(<MobileTimeReview bootstrap={bootstrap()} />)
    const approve = screen.getByText(/Approve all clean/i)
    fireEvent.click(approve)
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
    expect(mocks.dispatch).toHaveBeenCalledWith({ event: 'APPROVE' })
    // The N-PATCH bypass is gone: no labor-entries status PATCH on sign-off.
    expect(mocks.patchLaborMutateAsync).not.toHaveBeenCalled()
  })

  it('renders the footer from snapshot.next_events', () => {
    wrap(<MobileTimeReview bootstrap={bootstrap()} />)
    expect(screen.getByText(/Approve all clean/i)).toBeTruthy()
    expect(screen.getByText(/Reject — needs corrections/i)).toBeTruthy()
  })

  it('shows the week range in the top bar (not today)', () => {
    wrap(<MobileTimeReview bootstrap={bootstrap()} />)
    // Topbar eyebrow renders "Week · Mon, Apr 27 → Sun, May 3".
    expect(screen.getAllByText(/Week ·/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/Apr 27/i).length).toBeGreaterThanOrEqual(1)
  })

  it('renders one chip per anomaly (full stack, no +N collapse)', () => {
    mocks.useTimeReview.mockReturnValue(
      machine({
        snapshot: snapshot({
          context: {
            ...snapshot().context,
            anomalies: [
              {
                entry_id: 'le-1',
                anomalies: [
                  { code: 'overlap', message: 'overlap' },
                  { code: 'missing_break', message: 'no break' },
                ],
              },
            ],
          },
        }),
      }),
    )
    wrap(<MobileTimeReview bootstrap={bootstrap()} />)
    expect(screen.getAllByText('OT').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('LUNCH SKIP').length).toBeGreaterThanOrEqual(1)
  })

  it('offers a create CTA when no run exists', () => {
    mocks.useTimeReview.mockReturnValue(machine({ snapshot: null }))
    mocks.useTimeReviewRuns.mockReturnValue({ data: { timeReviewRuns: [] } })
    wrap(<MobileTimeReview bootstrap={bootstrap({ laborEntries: [] })} />)
    const cta = screen.getByText(/Start this week's review/i)
    fireEvent.click(cta)
    expect(mocks.createRunMutate).toHaveBeenCalledTimes(1)
    const [arg] = mocks.createRunMutate.mock.calls[0]!
    expect(arg).toMatchObject({ period_start: expect.any(String), period_end: expect.any(String) })
  })
})
