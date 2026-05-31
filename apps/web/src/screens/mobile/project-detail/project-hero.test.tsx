import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProjectRow } from '@/lib/api'
import type { ProjectCloseoutViewModel } from '../../../machines/project-closeout'
import type { ProjectCloseoutSnapshot } from '../../../lib/api/projects'

/**
 * Project hero render tests. The hero renders the live "% SPENT" variant
 * for an active closeout snapshot, and the Closed/Paid terminal variant
 * (design msg 64) when the project-closeout workflow reaches a terminal
 * state. We mock the headless machine view-model + navigate.
 */

const closeoutMachineMock = vi.fn<() => ProjectCloseoutViewModel>()
const navigateSpy = vi.fn()

vi.mock('../../../machines/project-closeout.js', () => ({
  useProjectCloseoutMachine: () => closeoutMachineMock(),
}))
vi.mock('../../../lib/api/client.js', () => ({
  getActiveCompanySlug: () => 'co',
}))
// The declined-state hero reads the saved lost reason; stub the hook so it
// returns no reason (the other states never branch on it).
vi.mock('../../../lib/api/project-lost-reasons.js', () => ({
  useProjectLostReason: () => ({ data: { lost_reason: null } }),
}))
// The in-progress hero now reads project guardrails to promote to the AT
// RISK variant. Stub the hook so it returns the triggered set under test
// (default: none triggered → the normal IN PROGRESS hero).
const guardrailsMock = vi.fn<() => { data: { guardrails: unknown[] } }>(() => ({ data: { guardrails: [] } }))
vi.mock('../../../lib/api/guardrails.js', () => ({
  useProjectGuardrails: () => guardrailsMock(),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
}))

import { ProjectHero } from './project-hero'

afterEach(() => {
  cleanup()
  closeoutMachineMock.mockReset()
  navigateSpy.mockReset()
  guardrailsMock.mockReset()
  guardrailsMock.mockReturnValue({ data: { guardrails: [] } })
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

const snapshot = (overrides: Partial<ProjectCloseoutSnapshot> = {}): ProjectCloseoutSnapshot => ({
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

const viewModel = (snap: ProjectCloseoutSnapshot | null): ProjectCloseoutViewModel => ({
  snapshot: snap,
  error: null,
  outOfSync: false,
  isLoading: false,
  isSubmitting: false,
  refresh: vi.fn(),
  dispatch: vi.fn(),
  dismissError: vi.fn(),
})

describe('ProjectHero', () => {
  it('renders the live "% DONE" hero for an in-progress active closeout snapshot (no PAID pill)', () => {
    closeoutMachineMock.mockReturnValue(viewModel(snapshot()))
    render(
      <ProjectHero
        project={project({ lifecycle_state: 'in_progress' })}
        pctSpent={62}
        onTrack
        spent={6200}
        bid={10000}
      />,
    )
    expect(screen.getByText('% DONE')).toBeTruthy()
    // The terminal PAID badge is an MPill; the live hero must not render
    // it. (Note: "PAID" also appears as the lifecycle stepper's last track
    // label in every live hero now — design M03 — so scope to the pill.)
    const paidPill = Array.from(document.querySelectorAll('.m-pill')).find((el) => el.textContent?.includes('PAID'))
    expect(paidPill).toBeUndefined()
  })

  it('renders the Closed/Paid terminal hero with closed date + Open post-mortem when completed', () => {
    closeoutMachineMock.mockReturnValue(
      viewModel(
        snapshot({
          state: 'completed',
          state_version: 2,
          next_events: [{ type: 'ACKNOWLEDGE_POST_MORTEM', label: 'Open post-mortem' }],
          context: { ...snapshot().context, status: 'completed', closed_at: '2026-05-20T00:00:00Z' },
        }),
      ),
    )
    render(<ProjectHero project={project({ status: 'completed' })} pctSpent={62} onTrack spent={6200} bid={10000} />)
    expect(screen.getByText('PAID')).toBeTruthy()
    expect(screen.getByText(/CLOSED ·/)).toBeTruthy()
    expect(screen.getByText('% FINAL MARGIN')).toBeTruthy()
    const openButton = screen.getByText('Open post-mortem')
    fireEvent.click(openButton)
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p1/post-mortem')
    // No live "% SPENT" hero in the terminal variant.
    expect(screen.queryByText('% SPENT')).toBeNull()
  })

  it('renders the SENT word hero (AWAITING RESPONSE) for a sent project, not a percent number', () => {
    closeoutMachineMock.mockReturnValue(viewModel(snapshot()))
    render(<ProjectHero project={project({ lifecycle_state: 'sent' })} pctSpent={0} onTrack spent={0} bid={184000} />)
    expect(screen.getByText('AWAITING RESPONSE')).toBeTruthy()
    expect(screen.queryByText('% SPENT')).toBeNull()
    expect(screen.queryByText('% DONE')).toBeNull()
  })

  it('renders the red Bid lost hero for a declined project', () => {
    closeoutMachineMock.mockReturnValue(viewModel(snapshot()))
    render(
      <ProjectHero project={project({ lifecycle_state: 'declined' })} pctSpent={0} onTrack spent={0} bid={184000} />,
    )
    expect(screen.getByText('Bid lost.')).toBeTruthy()
    expect(screen.queryByText('% SPENT')).toBeNull()
  })

  it('shows the acknowledged date on the post_mortem terminal state', () => {
    closeoutMachineMock.mockReturnValue(
      viewModel(
        snapshot({
          state: 'post_mortem',
          state_version: 3,
          next_events: [],
          context: {
            ...snapshot().context,
            status: 'completed',
            closed_at: '2026-05-20T00:00:00Z',
            post_mortem_acknowledged_at: '2026-05-22T00:00:00Z',
          },
        }),
      ),
    )
    render(<ProjectHero project={project({ status: 'completed' })} pctSpent={62} onTrack spent={6200} bid={10000} />)
    expect(screen.getByText(/Post-mortem · reviewed/)).toBeTruthy()
  })

  it('promotes the in-progress hero to the red AT RISK variant when a guardrail is triggered (design msg 62)', () => {
    closeoutMachineMock.mockReturnValue(viewModel(snapshot()))
    guardrailsMock.mockReturnValue({
      data: {
        guardrails: [
          {
            id: 'g1',
            type: 'margin',
            status: 'triggered',
            label: 'LABOR -18% VS PLAN',
            detail: 'Burn rate is outpacing the plan. Margin recoverable if addressed this week.',
            threshold: 0,
            current_value: -18,
          },
        ],
      },
    })
    render(
      <ProjectHero
        project={project({ lifecycle_state: 'in_progress' })}
        pctSpent={34}
        onTrack
        spent={6600}
        bid={10000}
      />,
    )
    // The AT RISK pill + guardrail headline appear; the calm HEALTHY label
    // does not.
    expect(screen.getAllByText(/AT RISK/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Burn rate is outpacing the plan/)).toBeTruthy()
    expect(screen.queryByText('HEALTHY')).toBeNull()
  })
})
