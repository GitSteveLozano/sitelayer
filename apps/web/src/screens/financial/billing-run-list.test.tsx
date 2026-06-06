import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BillingRunListParams, BillingRunListResponse, RentalBillingRunRow } from '@/lib/api'

/**
 * Render-smoke + filter-interaction tests for the financial billing-run
 * list. The screen reads everything from `useBillingRuns(params)`, so we
 * mock that hook to return the loading / empty / data shapes and assert
 * each renders without crashing. The status-chip row is exercised to
 * confirm the filter param is threaded into the hook call.
 */

const useBillingRunsMock =
  vi.fn<(params?: BillingRunListParams) => { data: BillingRunListResponse | undefined; isPending: boolean }>()

vi.mock('@/lib/api', () => ({
  useBillingRuns: (params?: BillingRunListParams) => useBillingRunsMock(params),
}))

import { BillingRunListScreen } from './billing-run-list'

afterEach(() => {
  cleanup()
  useBillingRunsMock.mockReset()
})

function wrap(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

const run = (overrides: Partial<RentalBillingRunRow> = {}): RentalBillingRunRow =>
  ({
    id: 'br-1',
    contract_id: 'ct-1',
    project_id: 'p-1',
    customer_id: 'c-1',
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    status: 'generated',
    state_version: 1,
    subtotal: '1250',
    qbo_invoice_id: null,
    approved_at: null,
    approved_by: null,
    posted_at: null,
    failed_at: null,
    error: null,
    workflow_engine: 'reducer',
    workflow_run_id: null,
    version: 1,
    created_at: '2026-05-31T00:00:00Z',
    updated_at: '2026-05-31T00:00:00Z',
    ...overrides,
  }) as RentalBillingRunRow

describe('BillingRunListScreen render-smoke', () => {
  it('shows the loading card while the query is pending', () => {
    useBillingRunsMock.mockReturnValue({ isPending: true, data: undefined })
    wrap(<BillingRunListScreen />)
    expect(screen.getByText('Billing runs')).toBeTruthy()
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('shows the empty-state card when the list resolves with no runs', () => {
    useBillingRunsMock.mockReturnValue({ isPending: false, data: { billingRuns: [] } })
    wrap(<BillingRunListScreen />)
    expect(screen.getByText('Nothing in this state.')).toBeTruthy()
    expect(screen.getByText('0 runs')).toBeTruthy()
  })

  it('renders run rows with subtotal, period, and status pill', () => {
    useBillingRunsMock.mockReturnValue({
      isPending: false,
      data: {
        billingRuns: [
          run({ id: 'a', subtotal: '1250', status: 'posted', qbo_invoice_id: '901' }),
          run({ id: 'b', subtotal: '4000', status: 'failed' }),
        ],
      },
    })
    wrap(<BillingRunListScreen />)
    expect(screen.getByText('2 runs')).toBeTruthy()
    expect(screen.getByText(/1,250/)).toBeTruthy()
    expect(screen.getByText(/QBO inv #901/)).toBeTruthy()
    // The status appears both as a filter chip and a row pill, so assert
    // at least one element carries the resolved state text.
    expect(screen.getAllByText('posted').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('failed').length).toBeGreaterThanOrEqual(1)
  })

  it('threads the selected status chip into the hook params', () => {
    useBillingRunsMock.mockReturnValue({ isPending: false, data: { billingRuns: [] } })
    wrap(<BillingRunListScreen />)
    // Initial render passes the "all" branch -> {} params.
    expect(useBillingRunsMock).toHaveBeenLastCalledWith({})
    fireEvent.click(screen.getByRole('button', { name: 'posted' }))
    expect(useBillingRunsMock).toHaveBeenLastCalledWith({ state: 'posted' })
  })
})
