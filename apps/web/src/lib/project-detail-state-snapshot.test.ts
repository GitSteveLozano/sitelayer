import { describe, expect, it } from 'vitest'
import { buildProjectDetailStateSnapshot } from './project-detail-state-snapshot'
import type { ProjectRow } from './api'

const project: ProjectRow = {
  id: 'project-1',
  customer_id: 'customer-1',
  name: 'Lobby Rebuild',
  customer_name: 'Northwind',
  division_code: '09',
  status: 'active',
  bid_total: '12000',
  labor_rate: '75',
  target_sqft_per_hr: null,
  bonus_pool: '0',
  closed_at: null,
  summary_locked_at: null,
  lifecycle_state: 'in_progress',
  lifecycle_state_version: 7,
  version: 11,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-04T00:00:00.000Z',
}

describe('buildProjectDetailStateSnapshot', () => {
  it('captures project detail route state without row dumps', () => {
    const out = buildProjectDetailStateSnapshot({
      project,
      activeTab: 'budget',
      companyRole: 'admin',
      routePath: '/m/projects/project-1?token=secret',
      reason: 'issue_submitted',
      totalHours: 12.345,
      bid: 12000,
      spent: 925.875,
      pctSpent: 8,
      onTrack: true,
      scheduleCount: 3,
      laborEntryCount: 4,
      materialBillCount: 2,
    })

    expect(out.schema).toBe('sitelayer.project-detail.state.v1')
    expect(out.piiLevel).toBe('internal')
    expect(out.metadata).toMatchObject({
      route_state: true,
      surface: 'mobile_project_detail',
      project_id: 'project-1',
      active_tab: 'budget',
      reason: 'issue_submitted',
    })
    expect(out.payload).toMatchObject({
      route_path: '/m/projects/project-1',
      active_tab: 'budget',
      actor: { company_role: 'admin' },
      project: {
        id: 'project-1',
        name: 'Lobby Rebuild',
        lifecycle_state: 'in_progress',
        lifecycle_state_version: 7,
        customer_name: 'Northwind',
        bid_total: 12000,
      },
      budget: {
        total_hours: 12.35,
        spent: 925.88,
        percent_spent: 8,
        on_track: true,
      },
      related_counts: {
        schedules: 3,
        labor_entries: 4,
        material_bills: 2,
      },
    })
    expect(JSON.stringify(out.payload)).not.toContain('token=')
  })
})
