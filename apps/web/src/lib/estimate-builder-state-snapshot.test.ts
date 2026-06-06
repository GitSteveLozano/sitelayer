import { describe, expect, it } from 'vitest'
import { buildEstimateBuilderStateSnapshot } from './estimate-builder-state-snapshot'
import type { ScopeVsBidResponse } from './api/estimate'

const snapshot: ScopeVsBidResponse = {
  bid_total: 1200,
  scope_total: 1000,
  delta: -200,
  delta_pct: -0.1667,
  status: 'warn',
  draft_id: 'draft-1',
  recomputed_at: '2026-06-04T00:00:00.000Z',
  source_updated_at: '2026-06-04T01:00:00.000Z',
  is_stale: true,
  lines: [
    {
      id: 'line-1',
      service_item_code: 'DRYWALL',
      quantity: '10',
      unit: 'sqft',
      rate: '25',
      amount: '250',
      division_code: '09',
      created_at: '2026-06-04T00:00:00.000Z',
      kind: 'material',
    },
    {
      id: 'line-2',
      service_item_code: 'DRYWALL',
      quantity: '5',
      unit: 'hr',
      rate: '50',
      amount: '250',
      division_code: '09',
      created_at: '2026-06-04T00:00:00.000Z',
      kind: 'labor',
    },
    {
      id: 'line-3',
      service_item_code: 'PAINT',
      quantity: '1',
      unit: 'ls',
      rate: '500',
      amount: '500',
      division_code: '09',
      created_at: '2026-06-04T00:00:00.000Z',
      kind: null,
    },
  ],
}

describe('buildEstimateBuilderStateSnapshot', () => {
  it('captures estimate builder state without full line payloads', () => {
    const out = buildEstimateBuilderStateSnapshot({
      projectId: 'project-1',
      routePath: '/projects/project-1/estimate-builder?token=secret',
      reason: 'issue_submitted',
      project: {
        id: 'project-1',
        name: 'Project A',
        status: 'active',
        customer_name: 'Customer A',
        bid_total: '1200',
      },
      snapshot,
      pendingEdits: { DRYWALL: { quantity: 11 } },
      selectedCategory: 'Drywall',
      activeProfile: { id: 'profile-1', name: 'Default' },
      ui: {
        isLoading: false,
        isSaving: false,
        isRecomputing: false,
        hasDirtyEdits: true,
        conflict: true,
        error: 'out of date',
        compactKeystone: true,
        shareSheetOpen: false,
        keystoneSheetOpen: true,
      },
    })

    expect(out.schema).toBe('sitelayer.estimate-builder.state.v1')
    expect(out.metadata).toMatchObject({
      route_state: true,
      surface: 'estimate_builder',
      project_id: 'project-1',
      line_count: 3,
      pending_edit_count: 1,
    })
    expect(out.payload).toMatchObject({
      route_path: '/projects/project-1/estimate-builder',
      project: {
        id: 'project-1',
        name: 'Project A',
        status: 'active',
        customer_name: 'Customer A',
        bid_total: 1200,
      },
      machine: {
        status: 'conflict',
        has_dirty_edits: true,
        pending_edit_count: 1,
        conflict: true,
        error: 'out of date',
      },
      filters: {
        selected_category: 'Drywall',
        compact_keystone: true,
        keystone_sheet_open: true,
        active_pricing_profile: { id: 'profile-1', name: 'Default' },
      },
      estimate: {
        bid_total: 1200,
        scope_total: 1000,
        status: 'warn',
        is_stale: true,
      },
      lines: {
        line_count: 3,
        by_division: [{ id: '09', count: 3 }],
        by_kind: [
          { id: 'flat', count: 1 },
          { id: 'labor', count: 1 },
          { id: 'material', count: 1 },
        ],
        top_service_items: [
          { id: 'DRYWALL', count: 2, amount: 500 },
          { id: 'PAINT', count: 1, amount: 500 },
        ],
      },
    })
    expect(JSON.stringify(out.payload)).not.toContain('token=secret')
    expect(JSON.stringify(out.payload)).not.toContain('line-1')
  })
})
