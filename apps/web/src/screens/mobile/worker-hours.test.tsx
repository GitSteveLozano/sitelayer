import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { WorkerHours } from './worker-hours'

/**
 * Render-smoke tests for the worker "My week" hours screen. Like the other
 * worker screens it is a pure renderer of `bootstrap` (labor entries +
 * projects) plus `useNavigate` — no api/TanStack hooks to mock. A
 * MemoryRouter wrapper and a minimal bootstrap fixture cover the empty
 * week and the with-data week.
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
    target_sqft_per_hr: null,
    bonus_pool: '0',
    closed_at: null,
    summary_locked_at: null,
    version: 1,
    created_at: '2026-05-09T00:00:00Z',
    updated_at: '2026-05-09T00:00:00Z',
    ...overrides,
  }) as BootstrapResponse['projects'][number]

// Local-date ISO matching the screen's own helper, so a labor entry lands
// in the rendered 7-day window regardless of the machine's timezone.
function todayLocalIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const laborEntry = (overrides: Partial<BootstrapResponse['laborEntries'][number]> = {}) =>
  ({
    id: 'le-1',
    project_id: 'p1',
    worker_id: 'w1',
    occurred_on: todayLocalIso(),
    hours: '8',
    rate: '50',
    status: 'approved',
    deleted_at: null,
    created_at: '2026-05-26T00:00:00Z',
    updated_at: '2026-05-26T00:00:00Z',
    ...overrides,
  }) as BootstrapResponse['laborEntries'][number]

describe('WorkerHours render-smoke', () => {
  it('renders the My week top bar and a zeroed week when bootstrap is null', () => {
    wrap(<WorkerHours bootstrap={null} />)
    expect(screen.getByText('My week')).toBeTruthy()
    expect(screen.getByText('0:00')).toBeTruthy()
    expect(screen.getByText('Daily entries')).toBeTruthy()
  })

  it('renders an empty week (no labor entries) without crashing', () => {
    wrap(<WorkerHours bootstrap={emptyBootstrap({ projects: [project()] })} />)
    expect(screen.getByText('0:00')).toBeTruthy()
    // Every day row reports "No entries" in the daily list.
    expect(screen.getAllByText('No entries').length).toBeGreaterThanOrEqual(1)
    // "Pay period to date" appears as both the section header and the
    // card eyebrow, so assert at least one is present.
    expect(screen.getAllByText('Pay period to date').length).toBeGreaterThanOrEqual(1)
  })

  it('totals logged hours and surfaces the approval-state pills with data', () => {
    const bootstrap = emptyBootstrap({
      projects: [project()],
      laborEntries: [
        laborEntry({ id: 'a', hours: '8', status: 'approved' }),
        laborEntry({ id: 'b', hours: '4', status: 'pending' }),
      ],
    })
    wrap(<WorkerHours bootstrap={bootstrap} />)
    // 8 + 4 = 12h → "12:00" headline total.
    expect(screen.getByText('12:00')).toBeTruthy()
    // Approval buckets render as pills (1 approved, 1 pending, 0 disputed).
    expect(screen.getByText('1 approved')).toBeTruthy()
    expect(screen.getByText('1 pending')).toBeTruthy()
  })
})
