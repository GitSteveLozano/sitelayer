/**
 * Unit tests for the overnight delta computation that drives the
 * `<MAiStripe eyebrow="OVERNIGHT">` block on fm-today.
 *
 * The stripe must:
 *   - count items strictly inside (cutoffMs, firstRenderMs]
 *   - return total === 0 when bootstrap is empty (no false positives)
 *   - bucket schedule changes / issues filed / project touches separately
 *   - skip schedules on inactive projects + soft-deleted rows
 *   - treat a project as "touched" only when updated_at > created_at
 */
import { describe, expect, test } from 'vitest'
import { computeOvernightDelta, __overnightInternals } from './foreman-today'
import type { BootstrapResponse } from '../../api-v1-compat'

const { yesterdayCutoffMs, overnightDismissKey } = __overnightInternals

function emptyBootstrap(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    company: { id: 'c', name: 'Co', slug: 'co' },
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

const project = (overrides: Partial<BootstrapResponse['projects'][number]>) =>
  ({
    id: 'p1',
    customer_id: null,
    name: 'P',
    customer_name: '',
    division_code: 'd',
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

describe('computeOvernightDelta', () => {
  // Window: yesterday 17:00 → today 06:42
  const cutoffMs = Date.parse('2026-05-08T17:00:00-07:00')
  const firstRenderMs = Date.parse('2026-05-09T06:42:00-07:00')

  test('returns total 0 when bootstrap and issues are empty', () => {
    const out = computeOvernightDelta({
      bootstrap: emptyBootstrap(),
      issues: [],
      cutoffMs,
      firstRenderMs,
    })
    expect(out.total).toBe(0)
    expect(out.buckets).toHaveLength(0)
  })

  test('returns total 0 when bootstrap is null', () => {
    const out = computeOvernightDelta({ bootstrap: null, issues: null, cutoffMs, firstRenderMs })
    expect(out.total).toBe(0)
    expect(out.buckets).toHaveLength(0)
  })

  test('counts schedule rows created in window for active projects', () => {
    const bootstrap = emptyBootstrap({
      projects: [project({ id: 'active1', status: 'in_progress' }), project({ id: 'closed1', status: 'closed' })],
      schedules: [
        // Inside window, active project — counted
        {
          id: 's1',
          project_id: 'active1',
          scheduled_for: '2026-05-09',
          crew: [],
          status: 'scheduled',
          version: 1,
          deleted_at: null,
          created_at: '2026-05-08T20:30:00-07:00',
        },
        // Inside window but soft-deleted — skipped
        {
          id: 's2',
          project_id: 'active1',
          scheduled_for: '2026-05-09',
          crew: [],
          status: 'scheduled',
          version: 1,
          deleted_at: '2026-05-08T22:00:00-07:00',
          created_at: '2026-05-08T20:30:00-07:00',
        },
        // Inside window but project is closed — skipped
        {
          id: 's3',
          project_id: 'closed1',
          scheduled_for: '2026-05-09',
          crew: [],
          status: 'scheduled',
          version: 1,
          deleted_at: null,
          created_at: '2026-05-08T20:30:00-07:00',
        },
        // Outside window (before cutoff) — skipped
        {
          id: 's4',
          project_id: 'active1',
          scheduled_for: '2026-05-09',
          crew: [],
          status: 'scheduled',
          version: 1,
          deleted_at: null,
          created_at: '2026-05-08T15:00:00-07:00',
        },
      ],
    })
    const out = computeOvernightDelta({ bootstrap, issues: [], cutoffMs, firstRenderMs })
    expect(out.scheduleCount).toBe(1)
    expect(out.issueCount).toBe(0)
    expect(out.projectCount).toBe(0)
    expect(out.total).toBe(1)
    expect(out.buckets[0]).toMatch(/Crew schedule: 1 change/)
  })

  test('counts worker issues filed in window and includes a clock time', () => {
    const issues = [
      {
        id: 'i1',
        project_id: 'p1',
        worker_id: 'w1',
        reporter_clerk_user_id: 'u',
        kind: 'blocker',
        message: 'EPS short',
        resolved_at: null,
        resolved_by_clerk_user_id: null,
        created_at: '2026-05-08T18:42:00-07:00',
      },
      // Outside window — skipped
      {
        id: 'i2',
        project_id: 'p1',
        worker_id: 'w1',
        reporter_clerk_user_id: 'u',
        kind: 'question',
        message: 'old',
        resolved_at: null,
        resolved_by_clerk_user_id: null,
        created_at: '2026-05-08T15:00:00-07:00',
      },
    ]
    const out = computeOvernightDelta({
      bootstrap: emptyBootstrap(),
      issues,
      cutoffMs,
      firstRenderMs,
    })
    expect(out.issueCount).toBe(1)
    expect(out.total).toBe(1)
    expect(out.buckets[0]).toMatch(/1 issue filed at /)
  })

  test('only counts projects whose updated_at advanced past created_at within the window', () => {
    const bootstrap = emptyBootstrap({
      projects: [
        // Touched overnight: updated_at strictly after created_at
        project({
          id: 'touched',
          status: 'in_progress',
          created_at: '2026-05-01T08:00:00-07:00',
          updated_at: '2026-05-08T19:15:00-07:00',
        }),
        // Brand-new row: updated_at == created_at — not a "touch"
        project({
          id: 'inserted',
          status: 'in_progress',
          created_at: '2026-05-08T19:00:00-07:00',
          updated_at: '2026-05-08T19:00:00-07:00',
        }),
        // Updated yesterday morning, before cutoff — outside window
        project({
          id: 'stale',
          status: 'in_progress',
          created_at: '2026-05-01T08:00:00-07:00',
          updated_at: '2026-05-08T09:00:00-07:00',
        }),
        // Closed project, even if updated overnight, is excluded
        project({
          id: 'closed',
          status: 'closed',
          created_at: '2026-05-01T08:00:00-07:00',
          updated_at: '2026-05-08T19:30:00-07:00',
        }),
      ],
    })
    const out = computeOvernightDelta({ bootstrap, issues: [], cutoffMs, firstRenderMs })
    expect(out.projectCount).toBe(1)
    expect(out.buckets[0]).toMatch(/1 project updated/)
  })

  test('accumulates totals across all three buckets', () => {
    const bootstrap = emptyBootstrap({
      projects: [
        project({
          id: 'a',
          status: 'in_progress',
          created_at: '2026-05-01T08:00:00-07:00',
          updated_at: '2026-05-08T19:15:00-07:00',
        }),
      ],
      schedules: [
        {
          id: 's1',
          project_id: 'a',
          scheduled_for: '2026-05-09',
          crew: [],
          status: 'scheduled',
          version: 1,
          deleted_at: null,
          created_at: '2026-05-08T20:30:00-07:00',
        },
      ],
    })
    const issues = [
      {
        id: 'i1',
        project_id: 'a',
        worker_id: 'w1',
        reporter_clerk_user_id: 'u',
        kind: 'blocker',
        message: 'x',
        resolved_at: null,
        resolved_by_clerk_user_id: null,
        created_at: '2026-05-08T18:42:00-07:00',
      },
    ]
    const out = computeOvernightDelta({ bootstrap, issues, cutoffMs, firstRenderMs })
    expect(out.total).toBe(3)
    expect(out.scheduleCount).toBe(1)
    expect(out.issueCount).toBe(1)
    expect(out.projectCount).toBe(1)
    expect(out.buckets).toHaveLength(3)
  })
})

describe('overnight helpers', () => {
  test('yesterdayCutoffMs lands on yesterday 17:00 local', () => {
    const fixed = new Date('2026-05-09T06:42:00-07:00')
    const ms = yesterdayCutoffMs(fixed)
    const d = new Date(ms)
    expect(d.getHours()).toBe(17)
    expect(d.getMinutes()).toBe(0)
    // Day-of-month should be one less than `fixed`'s local date.
    expect(d.getDate()).toBe(fixed.getDate() - 1)
  })

  test('overnightDismissKey is namespaced by cutoff so a new morning starts fresh', () => {
    const a = overnightDismissKey(1)
    const b = overnightDismissKey(2)
    expect(a).not.toBe(b)
    expect(a).toContain('fm-today.overnight-dismissed.')
  })
})
