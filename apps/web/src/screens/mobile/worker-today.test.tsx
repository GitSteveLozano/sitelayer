import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'

/**
 * Crew-side STOP WORK reachability (C-P1 follow-up). The worker home surfaces a
 * hazard banner at the top when an OPEN `worker_issue` with
 * `severity === 'stopped'` exists on the crew's current/active project, and the
 * banner opens the full-screen safety takeover at
 * `/projects/<id>/stop-work`. We mock `apiGet` exactly like the foreman/blocker
 * tests do: clock timeline + worker-issues are routed by path.
 */

const apiGetMock = vi.fn<(path: string, slug?: string) => Promise<unknown>>()
vi.mock('@/lib/api', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    apiGet: (path: string, slug?: string) => apiGetMock(path, slug),
    apiPost: vi.fn().mockResolvedValue({}),
  }
})

import { WorkerToday } from './worker-today'

afterEach(() => {
  cleanup()
  apiGetMock.mockReset()
})

type OpenIssue = {
  id: string
  project_id: string | null
  severity?: 'question' | 'slowing' | 'stopped' | null
  resolved_at: string | null
}

// Route apiGet by path: the clock timeline + the open worker-issues feed are
// the only two GETs this screen makes that we care about here. Everything else
// (project briefs, notifications) flows through TanStack Query hooks which we
// let settle empty under a no-retry QueryClient.
function installApiGet(opts: { issues: OpenIssue[]; clockedInProjectId?: string | null }) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/clock/timeline')) {
      const events =
        opts.clockedInProjectId != null
          ? [
              {
                id: 'e1',
                worker_id: 'w1',
                project_id: opts.clockedInProjectId,
                event_type: 'in',
                occurred_at: '2026-05-09T13:00:00.000Z',
                lat: null,
                lng: null,
              },
            ]
          : []
      return Promise.resolve({ events })
    }
    if (path.startsWith('/api/worker-issues')) {
      return Promise.resolve({ worker_issues: opts.issues })
    }
    return Promise.resolve({})
  })
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
    workers: [
      { id: 'w1', name: 'Sam Crew', role: 'member', version: 1, deleted_at: null, created_at: '2026-05-09T00:00:00Z' },
    ],
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

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={node} />
          <Route path="/projects/:projectId/stop-work" element={<div>STOP WORK TAKEOVER</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('WorkerToday — crew STOP WORK banner', () => {
  it('renders the hazard banner when an open stopped issue is on the clocked-in project and opens the takeover', async () => {
    installApiGet({
      clockedInProjectId: 'p1',
      issues: [{ id: 'i1', project_id: 'p1', severity: 'stopped', resolved_at: null }],
    })
    const bootstrap = emptyBootstrap({ projects: [project({ id: 'p1', status: 'in_progress' })] })
    wrap(<WorkerToday bootstrap={bootstrap} companySlug="acme" />)

    const banner = await screen.findByRole('button', { name: /stop work in effect/i })
    expect(banner).toBeTruthy()
    expect(screen.getByText('STOP WORK IN EFFECT')).toBeTruthy()

    fireEvent.click(banner)
    expect(await screen.findByText('STOP WORK TAKEOVER')).toBeTruthy()
  })

  it('falls back to an active project when not clocked in', async () => {
    installApiGet({
      clockedInProjectId: null,
      issues: [{ id: 'i1', project_id: 'p2', severity: 'stopped', resolved_at: null }],
    })
    const bootstrap = emptyBootstrap({
      projects: [project({ id: 'p2', status: 'in_progress', name: 'Birch Lofts' })],
    })
    wrap(<WorkerToday bootstrap={bootstrap} companySlug="acme" />)

    const banner = await screen.findByRole('button', { name: /stop work in effect/i })
    fireEvent.click(banner)
    expect(await screen.findByText('STOP WORK TAKEOVER')).toBeTruthy()
  })

  it('renders no banner when there is no open stopped issue', async () => {
    installApiGet({
      clockedInProjectId: 'p1',
      // a slowing issue + a resolved stopped issue — neither counts
      issues: [
        { id: 'i1', project_id: 'p1', severity: 'slowing', resolved_at: null },
        { id: 'i2', project_id: 'p1', severity: 'stopped', resolved_at: '2026-05-09T14:00:00.000Z' },
      ],
    })
    const bootstrap = emptyBootstrap({ projects: [project({ id: 'p1', status: 'in_progress' })] })
    wrap(<WorkerToday bootstrap={bootstrap} companySlug="acme" />)

    // Wait for the issues fetch to have resolved, then assert no banner.
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith('/api/worker-issues?resolved=false', 'acme'))
    expect(screen.queryByRole('button', { name: /stop work in effect/i })).toBeNull()
  })

  it('renders no banner when the only stopped issue is on a DIFFERENT inactive project', async () => {
    installApiGet({
      clockedInProjectId: null,
      issues: [{ id: 'i1', project_id: 'p9', severity: 'stopped', resolved_at: null }],
    })
    // p9 isn't in bootstrap projects (and the only listed one is not active),
    // so there's no current/active site to attach the stop to.
    const bootstrap = emptyBootstrap({ projects: [project({ id: 'p1', status: 'sent' })] })
    wrap(<WorkerToday bootstrap={bootstrap} companySlug="acme" />)

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith('/api/worker-issues?resolved=false', 'acme'))
    expect(screen.queryByRole('button', { name: /stop work in effect/i })).toBeNull()
  })
})
