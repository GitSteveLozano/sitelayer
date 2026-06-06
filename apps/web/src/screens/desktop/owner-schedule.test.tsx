import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { offsetToIsoDate } from '@/lib/schedule-timeline'

/**
 * Owner 4-week drag-timeline wire-through (Gap 4). Asserts that pointer-dragging
 * a real assignment block calls patchCrewSchedule with each underlying row id at
 * its shifted YYYY-MM-DD — the bootstrap ledger is the only source of truth, no
 * local business state. Demo blocks are not draggable.
 */

const mocks = vi.hoisted(() => ({ patchCrewSchedule: vi.fn() }))

vi.mock('@/lib/api/crew-schedules', () => ({ patchCrewSchedule: mocks.patchCrewSchedule }))
vi.mock('./project-drawers', () => ({ NewAssignmentModal: () => null }))

import { OwnerSchedule } from './owner-schedule'

/** Monday of the week containing `d` (local) — mirrors the screen's mondayOf. */
function mondayOf(d: Date): Date {
  const m = new Date(d)
  const dow = (m.getDay() + 6) % 7
  m.setDate(m.getDate() - dow)
  m.setHours(0, 0, 0, 0)
  return m
}

const ANCHOR = mondayOf(new Date())

function isoForOffset(offset: number): string {
  return offsetToIsoDate(ANCHOR, offset)
}

function makeBootstrap(): BootstrapResponse {
  // One active project with two consecutive working days (offsets 0,1) so the
  // timeline derives a single 2-day block carrying rows s1 (Mon) and s2 (Tue).
  return {
    company: { id: 'co1', slug: 'acme', name: 'Acme', role: 'admin' },
    projects: [
      {
        id: 'p1',
        customer_id: null,
        name: 'Hillcrest',
        customer_name: 'JM',
        division_code: 'EPS',
        status: 'in_progress',
        bid_total: '0',
        labor_rate: '0',
        target_sqft_per_hr: null,
        bonus_pool: '0',
        closed_at: null,
        summary_locked_at: null,
        version: 1,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ],
    customers: [],
    workers: [{ id: 'w1', name: 'Marcus', role: 'member', version: 1, deleted_at: null } as never],
    divisions: [],
    serviceItems: [],
    pricingProfiles: [],
    bonusRules: [],
    integrationMappings: [],
    laborEntries: [],
    materialBills: [],
    schedules: [
      {
        id: 's1',
        project_id: 'p1',
        scheduled_for: isoForOffset(0),
        crew: [{ worker_id: 'w1' }],
        status: 'draft',
        version: 1,
        deleted_at: null,
      },
      {
        id: 's2',
        project_id: 'p1',
        scheduled_for: isoForOffset(1),
        crew: [{ worker_id: 'w1' }],
        status: 'draft',
        version: 1,
        deleted_at: null,
      },
    ],
  } as unknown as BootstrapResponse
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  mocks.patchCrewSchedule.mockReset()
  mocks.patchCrewSchedule.mockResolvedValue({})
  // jsdom doesn't implement the Pointer Capture API; stub it so the drag
  // handlers (set/has/releasePointerCapture) don't throw.
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  // jsdom returns a 0-width rect by default; give the row track a real width so
  // the px→working-day snap (1000px / 20 cols = 50px per day) is deterministic.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1000,
    height: 72,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 72,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('OwnerSchedule — 4-week drag-to-reschedule', () => {
  function openTimeline() {
    render(<OwnerSchedule bootstrap={makeBootstrap()} />, { wrapper })
    fireEvent.click(screen.getByText('4-WK'))
  }

  it('PATCHes every underlying schedule row to its shifted date on drop', async () => {
    openTimeline()
    const block = screen.getByRole('button', { name: /^EPS/ })

    // Drag right by 5 columns (250px over a 1000px / 20-col track) → +5 working
    // days. Block at offsets 0,1 moves to offsets 5,6.
    fireEvent.pointerDown(block, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(block, { clientX: 250, pointerId: 1 })
    fireEvent.pointerUp(block, { clientX: 250, pointerId: 1 })

    await vi.waitFor(() => expect(mocks.patchCrewSchedule).toHaveBeenCalledTimes(2))
    expect(mocks.patchCrewSchedule).toHaveBeenCalledWith('s1', { scheduled_for: isoForOffset(5) })
    expect(mocks.patchCrewSchedule).toHaveBeenCalledWith('s2', { scheduled_for: isoForOffset(6) })
  })

  it('does not PATCH when the drag snaps to a zero-day shift', () => {
    openTimeline()
    const block = screen.getByRole('button', { name: /^EPS/ })

    // 20px is < half a column (25px) → rounds to 0 working days → no-op.
    fireEvent.pointerDown(block, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(block, { clientX: 20, pointerId: 1 })
    fireEvent.pointerUp(block, { clientX: 20, pointerId: 1 })

    expect(mocks.patchCrewSchedule).not.toHaveBeenCalled()
  })
})
