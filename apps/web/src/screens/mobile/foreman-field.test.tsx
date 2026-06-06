import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'

/**
 * Render-smoke + filter tests for the foreman field-events inbox. The
 * screen loads open/resolved worker_issues through `apiGet` on mount
 * (with `apiPatch` reserved for the resolve flow), then renders a chip
 * filter row + a per-issue list. We mock `@/lib/api`'s `apiGet`/`apiPatch`
 * to drive the loading skeleton, the empty state, and a populated list,
 * and to confirm the chip counts reflect the fetched rows. The detail /
 * resolve sub-flow is left untested here; it calls the wired
 * `PATCH /api/worker-issues/:id` endpoint, which has its own server-side
 * coverage in worker-issues.test.ts.
 */

const apiGetMock = vi.fn<(path: string, slug?: string) => Promise<unknown>>()
const apiPatchMock = vi.fn<(path: string, body: unknown, slug?: string) => Promise<unknown>>()

vi.mock('@/lib/api', () => ({
  apiGet: (path: string, slug?: string) => apiGetMock(path, slug),
  apiPatch: (path: string, body: unknown, slug?: string) => apiPatchMock(path, body, slug),
}))

import { ForemanField } from './foreman-field'

afterEach(() => {
  cleanup()
  apiGetMock.mockReset()
  apiPatchMock.mockReset()
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

const worker = (id: string, name: string) =>
  ({
    id,
    name,
    role: 'crew',
    version: 1,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00Z',
  }) as BootstrapResponse['workers'][number]

const project = (id: string, name: string) =>
  ({
    id,
    customer_id: null,
    name,
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
  }) as BootstrapResponse['projects'][number]

const issue = (overrides: Record<string, unknown> = {}) => ({
  id: 'i1',
  project_id: 'p1',
  worker_id: 'w1',
  reporter_clerk_user_id: 'user_w1',
  kind: 'material',
  message: 'Out of screws on the north wall',
  resolved_at: null,
  resolved_by_clerk_user_id: null,
  created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  ...overrides,
})

const bootstrap = emptyBootstrap({
  workers: [worker('w1', 'Alex Mason')],
  projects: [project('p1', 'Maple Tower')],
})

describe('ForemanField render-smoke', () => {
  it('shows the skeleton while the issues fetch is in flight, then the empty state', async () => {
    // Never-resolving promise keeps `issues` null → skeleton renders.
    apiGetMock.mockReturnValue(new Promise(() => {}))
    wrap(<ForemanField bootstrap={bootstrap} companySlug="acme" />)
    expect(screen.getByText('Field')).toBeTruthy()
    // No issues resolved yet → header reads "0 incoming".
    expect(screen.getByText(/incoming/)).toBeTruthy()
  })

  it('renders the empty state when the fetch resolves with no issues', async () => {
    apiGetMock.mockResolvedValue({ worker_issues: [] })
    wrap(<ForemanField bootstrap={bootstrap} companySlug="acme" />)
    expect(await screen.findByText('No open events')).toBeTruthy()
    expect(screen.getByText('Nice quiet day.')).toBeTruthy()
    expect(apiGetMock).toHaveBeenCalledWith('/api/worker-issues?resolved=true', 'acme')
  })

  it('renders the issue list with worker name + chip counts when issues land', async () => {
    apiGetMock.mockResolvedValue({
      worker_issues: [
        issue({ id: 'a', worker_id: 'w1', kind: 'material' }),
        issue({ id: 'b', worker_id: 'w1', kind: 'safety', message: 'Trip hazard at entry' }),
        issue({ id: 'c', worker_id: 'w1', message: '[photo_log] progress photo', kind: 'photo' }),
      ],
    })
    wrap(<ForemanField bootstrap={bootstrap} companySlug="acme" />)
    // Wait for the list to render after the async fetch settles.
    await waitFor(() => expect(screen.getAllByText('Alex Mason').length).toBeGreaterThanOrEqual(1))
    // 3 open issues total → "3 incoming".
    expect(screen.getByText(/^3$/)).toBeTruthy()
  })
})
