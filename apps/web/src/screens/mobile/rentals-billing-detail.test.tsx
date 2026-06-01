import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { RentalBillingSnapshot } from '@/lib/api/billing-runs'
import type { BillingReviewSnapshot } from '@/machines/billing-review'

/**
 * Screen tests for the headless-first mobile billing-run renderer. The
 * backend reducer + the useBillingReview machine are tested elsewhere; this
 * asserts the SCREEN renders the action grid from snapshot.next_events
 * verbatim, forwards the chosen event type to dispatch, and shows the
 * out-of-sync breadcrumb. No business logic is mirrored on the client.
 */

const mocks = vi.hoisted(() => ({
  useBillingReview: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock('@/machines/billing-review', () => ({
  useBillingReview: mocks.useBillingReview,
}))

vi.mock('@/lib/control-plane-probe-pub', () => ({
  useControlPlaneProbePublish: vi.fn(),
}))

import { MobileRentalBillingDetail } from './rentals-billing-detail'

const RUN_ID = '00000000-0000-4000-8000-000000000001'

function snapshot(overrides: Partial<RentalBillingSnapshot> = {}): RentalBillingSnapshot {
  return {
    state: 'generated',
    state_version: 1,
    next_events: [
      { type: 'APPROVE', label: 'Approve billing run' },
      { type: 'VOID', label: 'Void' },
    ],
    context: {
      id: RUN_ID,
      contract_id: 'c-1',
      project_id: 'p-1',
      customer_id: 'cust-1',
      period_start: '2026-05-01',
      period_end: '2026-05-31',
      subtotal: '1234.00',
      qbo_invoice_id: null,
      approved_at: null,
      posted_at: null,
      failed_at: null,
      error: null,
      workflow_engine: 'postgres',
      workflow_run_id: null,
      lines: [],
      ...overrides.context,
    },
    ...overrides,
  }
}

function machine(overrides: Partial<BillingReviewSnapshot> = {}): BillingReviewSnapshot {
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

function wrap(node: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[`/rentals/billing/${RUN_ID}`]}>
      <Routes>
        <Route path="/rentals/billing/:id" element={node} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.dispatch.mockReset()
  mocks.useBillingReview.mockReturnValue(machine())
})

afterEach(cleanup)

describe('MobileRentalBillingDetail', () => {
  it('renders the action grid from snapshot.next_events and forwards the event type to dispatch', () => {
    wrap(<MobileRentalBillingDetail companySlug="acme" companyRole="admin" />)
    expect(screen.getByText('Approve billing run')).toBeTruthy()
    expect(screen.getByText('Void')).toBeTruthy()
    fireEvent.click(screen.getByText('Approve billing run'))
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
    expect(mocks.dispatch).toHaveBeenCalledWith('APPROVE')
  })

  it('shows the CANCEL_POST escape hatch when the server offers it from posting', () => {
    mocks.useBillingReview.mockReturnValue(
      machine({
        snapshot: snapshot({
          state: 'posting',
          next_events: [{ type: 'CANCEL_POST', label: 'Cancel stuck QuickBooks post' }],
        }),
      }),
    )
    wrap(<MobileRentalBillingDetail companySlug="acme" companyRole="office" />)
    const btn = screen.getByText('Cancel stuck QuickBooks post')
    fireEvent.click(btn)
    expect(mocks.dispatch).toHaveBeenCalledWith('CANCEL_POST')
  })

  it('renders a terminal-state message and no action buttons when next_events is empty', () => {
    mocks.useBillingReview.mockReturnValue(machine({ snapshot: snapshot({ state: 'posted', next_events: [] }) }))
    wrap(<MobileRentalBillingDetail companySlug="acme" companyRole="admin" />)
    expect(screen.getByText(/Terminal state — no further actions/i)).toBeTruthy()
    expect(screen.queryByText('Approve billing run')).toBeNull()
  })

  it('renders the out-of-sync stale-state breadcrumb', () => {
    mocks.useBillingReview.mockReturnValue(machine({ outOfSync: true }))
    wrap(<MobileRentalBillingDetail companySlug="acme" companyRole="admin" />)
    expect(screen.getByText(/Out of sync/i)).toBeTruthy()
  })

  it('hides action buttons for non-admin/office roles (API stays authoritative)', () => {
    wrap(<MobileRentalBillingDetail companySlug="acme" companyRole="member" />)
    expect(screen.queryByText('Approve billing run')).toBeNull()
    expect(screen.getByText(/limited to admin \/ office roles/i)).toBeTruthy()
  })
})
