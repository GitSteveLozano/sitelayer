import { describe, expect, it } from 'vitest'
import { buildTakeoffCanvasStateSnapshot } from './canvas-state-snapshot'
import type { BlueprintDocument, BlueprintPage, TakeoffMeasurement } from '../api/takeoff'
import type { TakeoffDraft } from '../api/takeoff-drafts'

const draft: TakeoffDraft = {
  id: 'draft-1',
  company_id: 'company-1',
  project_id: 'project-1',
  name: 'Main takeoff',
  type: 'measurement',
  kind: 'takeoff',
  status: 'active',
  version: 4,
  source: 'manual',
  review_required: false,
  pipeline_version: null,
  deleted_at: null,
  created_at: '2026-06-04T00:00:00.000Z',
  updated_at: '2026-06-04T00:00:00.000Z',
}

const blueprint: BlueprintDocument = {
  id: 'blueprint-1',
  project_id: 'project-1',
  file_name: 'Plans.pdf',
  storage_path: 'companies/company-1/private/plans.pdf',
  preview_type: 'pdf',
  calibration_length: '30',
  calibration_unit: 'ft',
  sheet_scale: '1/4" = 1\'-0"',
  version: 2,
  deleted_at: null,
  replaces_blueprint_document_id: null,
  file_url: 'https://signed.example/plans.pdf',
  created_at: '2026-06-04T00:00:00.000Z',
}

const page: BlueprintPage = {
  id: 'page-1',
  blueprint_document_id: 'blueprint-1',
  page_number: 3,
  storage_path: 'companies/company-1/private/page-1.png',
  calibration_world_distance: '30',
  calibration_world_unit: 'ft',
  calibration_x1: '10',
  calibration_y1: '10',
  calibration_x2: '40',
  calibration_y2: '10',
  calibration_set_at: '2026-06-04T00:00:00.000Z',
  scale_verified_at: '2026-06-04T00:00:00.000Z',
  scale_verified_by: 'user-1',
  measurement_count: 2,
}

const measurements: TakeoffMeasurement[] = [
  {
    id: 'm-1',
    project_id: 'project-1',
    blueprint_document_id: 'blueprint-1',
    page_id: 'page-1',
    service_item_code: 'DRYWALL',
    quantity: '12',
    unit: 'sqft',
    notes: null,
    elevation: 'north',
    image_thumbnail: 'data:image/png;base64,secret',
    geometry: { kind: 'polygon', points: [{ x: 1, y: 2 }] },
    is_deduction: false,
    assembly_id: null,
    condition_id: null,
    version: 1,
    created_at: '2026-06-04T00:00:00.000Z',
  },
  {
    id: 'm-2',
    project_id: 'project-1',
    blueprint_document_id: 'blueprint-1',
    page_id: 'page-1',
    service_item_code: 'DRYWALL',
    quantity: '3',
    unit: 'sqft',
    notes: null,
    elevation: 'north',
    image_thumbnail: null,
    geometry: { kind: 'lineal', points: [{ x: 3, y: 4 }] },
    is_deduction: true,
    assembly_id: 'assembly-1',
    condition_id: null,
    version: 1,
    created_at: '2026-06-04T00:00:00.000Z',
  },
]

describe('buildTakeoffCanvasStateSnapshot', () => {
  it('summarizes current takeoff state without leaking storage or media fields', () => {
    const snapshot = buildTakeoffCanvasStateSnapshot({
      surface: 'desktop_est_canvas',
      project_id: 'project-1',
      route_path: '/projects/project-1/takeoff-canvas?token=secret',
      reason: 'issue_submitted',
      active_draft: draft,
      active_blueprint: blueprint,
      active_page: page,
      viewport: { zoom: 2, pan: { x: 1, y: 2 }, token: 'secret' },
      session: { state: 'drawing', nested: { storage_key: 'hidden', value: 'kept' } },
      draft: {
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        quantity: 10,
        service_item_code: 'DRYWALL',
      },
      selection: { selected_measurement_id: 'm-1', bulk_selected_ids: ['m-1', 'm-2'] },
      measurements,
    })

    expect(snapshot.schema).toBe('sitelayer.takeoff.canvas-state.v1')
    expect(snapshot.piiLevel).toBe('internal')
    expect(snapshot.metadata).toMatchObject({
      route_state: true,
      surface: 'desktop_est_canvas',
      project_id: 'project-1',
      measurement_count: 2,
    })
    expect(snapshot.payload).toMatchObject({
      route_path: '/projects/project-1/takeoff-canvas',
      active_draft: {
        id: 'draft-1',
        name: 'Main takeoff',
        status: 'active',
        version: 4,
      },
      active_blueprint: {
        id: 'blueprint-1',
        file_name: 'Plans.pdf',
        version: 2,
      },
      active_page: {
        id: 'page-1',
        page_number: 3,
        scale_verified: true,
        calibration_set: true,
      },
      viewport: { zoom: 2, pan: { x: 1, y: 2 } },
      session: { state: 'drawing', nested: { value: 'kept' } },
      draft: {
        quantity: 10,
        service_item_code: 'DRYWALL',
        point_count: 2,
      },
      measurements: {
        measurement_count: 2,
        deduction_count: 1,
        assembly_count: 1,
        by_kind: [
          { id: 'lineal', count: 1 },
          { id: 'polygon', count: 1 },
        ],
        top_service_items: [{ id: 'DRYWALL', count: 2 }],
      },
    })
    expect(JSON.stringify(snapshot.payload)).not.toContain('storage_path')
    expect(JSON.stringify(snapshot.payload)).not.toContain('storage_key')
    expect(JSON.stringify(snapshot.payload)).not.toContain('secret')
    expect(JSON.stringify(snapshot.payload)).not.toContain('image_thumbnail')
  })
})
