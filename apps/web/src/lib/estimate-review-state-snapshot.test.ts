import { describe, expect, it } from 'vitest'
import { buildEstimateReviewStateSnapshot } from './estimate-review-state-snapshot'
import type { ProjectSummary } from './api'
import type { EstimateLine, ScopeVsBidResponse } from './api/estimate'

const lines = [
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
    service_item_code: 'LABOR',
    quantity: '5',
    unit: 'hr',
    rate: '50',
    amount: '250',
    division_code: '09',
    created_at: '2026-06-04T00:00:00.000Z',
    kind: 'labor',
  },
] satisfies EstimateLine[]

const summary = {
  project: {
    id: 'project-1',
    name: 'Lobby Rebuild',
    status: 'active',
    customer_id: 'customer-1',
    customer_name: 'Northwind',
  },
  metrics: {
    estimateTotal: 1000,
    totalCost: 700,
    laborCost: 300,
    materialCost: 250,
    subCost: 150,
  },
  estimateLines: lines,
} as unknown as ProjectSummary

const snapshot = {
  bid_total: 1000,
  scope_total: 1050,
  delta: 50,
  delta_pct: 0.05,
  status: 'ok',
  draft_id: 'draft-1',
  recomputed_at: '2026-06-04T00:00:00.000Z',
  source_updated_at: '2026-06-04T00:00:00.000Z',
  is_stale: false,
  lines,
} satisfies ScopeVsBidResponse

describe('buildEstimateReviewStateSnapshot', () => {
  it('captures send and builder state without leaking share URLs', () => {
    const out = buildEstimateReviewStateSnapshot({
      projectId: 'project-1',
      routePath: '/m/projects/project-1/estimate?token=secret',
      reason: 'recording_stopped',
      summary,
      builder: {
        snapshot,
        lines,
        pendingEdits: { DRYWALL: { quantity: 11 } },
        hasDirtyEdits: true,
        isLoading: false,
        isSaving: false,
        conflict: true,
        error: 'stale estimate',
      },
      ui: {
        creatingPush: false,
        createError: null,
        shareCreated: true,
        marginOverride: 0.22,
        marginSaving: false,
        showSendSheet: true,
        sendNoteLength: 42,
        sendEmailPresent: true,
      },
      totals: {
        liveTotal: 1050,
        costBasis: 700,
        sellTotal: 900,
        profit: 200,
        margin: 0.22,
        roundingDelta: 3.5,
      },
    })

    expect(out.schema).toBe('sitelayer.estimate-review.state.v1')
    expect(out.metadata).toMatchObject({
      route_state: true,
      surface: 'mobile_estimate_review',
      project_id: 'project-1',
      summary_line_count: 2,
      builder_line_count: 2,
      pending_edit_count: 1,
    })
    expect(out.payload).toMatchObject({
      route_path: '/m/projects/project-1/estimate',
      builder: {
        status: 'conflict',
        has_dirty_edits: true,
        pending_edit_count: 1,
        snapshot_stale: false,
      },
      send_sheet: {
        open: true,
        share_created: true,
        send_note_length: 42,
        send_email_present: true,
      },
      lines: {
        builder: {
          line_count: 2,
          amount: 500,
          by_kind: { material: 1, labor: 1 },
        },
      },
    })
    expect(JSON.stringify(out.payload)).not.toContain('token=secret')
    expect(JSON.stringify(out.payload)).not.toContain('share_url')
  })
})
