import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlueprintDocument, BlueprintPage, TakeoffMeasurement } from '../api/takeoff'
import { uploadCaptureArtifact } from '../api/capture-sessions'
import {
  buildCanvasGeometryArtifact,
  canvasGeometryArtifactBlob,
  uploadCanvasGeometryArtifact,
} from './canvas-geometry-artifact'

vi.mock('../api/capture-sessions', () => ({
  uploadCaptureArtifact: vi.fn(),
}))

const uploadCaptureArtifactMock = vi.mocked(uploadCaptureArtifact)

function blueprint(overrides: Partial<BlueprintDocument> = {}): BlueprintDocument {
  return {
    id: 'bp-1',
    project_id: 'project-1',
    file_name: 'A101.pdf',
    storage_path: 'co-1/blueprints/private/A101.pdf',
    preview_type: 'pdf',
    calibration_length: '12',
    calibration_unit: 'ft',
    sheet_scale: '1/4" = 1\'-0"',
    version: 3,
    deleted_at: null,
    replaces_blueprint_document_id: null,
    file_url: 'https://storage.example/private/A101.pdf',
    created_at: '2026-05-31T12:00:00.000Z',
    ...overrides,
  }
}

function page(overrides: Partial<BlueprintPage> = {}): BlueprintPage {
  return {
    id: 'page-1',
    blueprint_document_id: 'bp-1',
    page_number: 1,
    storage_path: 'co-1/blueprints/private/page-1.png',
    calibration_world_distance: '12',
    calibration_world_unit: 'ft',
    calibration_x1: '10',
    calibration_y1: '10',
    calibration_x2: '70',
    calibration_y2: '10',
    calibration_set_at: '2026-05-31T12:01:00.000Z',
    scale_verified_at: '2026-05-31T12:02:00.000Z',
    scale_verified_by: 'user-1',
    measurement_count: 2,
    ...overrides,
  }
}

function measurement(overrides: Partial<TakeoffMeasurement> = {}): TakeoffMeasurement {
  return {
    id: 'm-1',
    project_id: 'project-1',
    blueprint_document_id: 'bp-1',
    page_id: 'page-1',
    service_item_code: 'AIR-BARRIER',
    quantity: '42.50',
    unit: 'sqft',
    notes: 'North wall',
    elevation: 'North',
    image_thumbnail: 'data:image/png;base64,private-pixels',
    geometry: {
      kind: 'polygon',
      points: [
        { x: 10, y: 20 },
        { x: Number.POSITIVE_INFINITY, y: 40 },
        { x: 30, y: 40 },
      ],
      world_per_board_x: 0.2,
      world_per_board_y: 0.2,
    },
    is_deduction: false,
    assembly_id: null,
    version: 1,
    created_at: '2026-05-31T12:03:00.000Z',
    ...overrides,
  }
}

describe('canvas geometry capture artifact', () => {
  beforeEach(() => {
    uploadCaptureArtifactMock.mockReset()
  })

  it('builds a machine-readable canvas snapshot without private blobs or storage paths', () => {
    const payload = buildCanvasGeometryArtifact({
      project_id: 'project-1',
      route_path: '/desktop/takeoff?sheet=A101#panel',
      active_draft_id: 'draft-1',
      active_blueprint_id: 'bp-1',
      active_page_id: 'page-1',
      blueprint: blueprint(),
      page: page(),
      viewport: { zoom: 1.25, pan: { x: 12, y: 24 }, mode: 'draw', tool: 'polygon' },
      draft: { id: 'draft-1', status: 'open', screenshot: 'data:image/png;base64,private' },
      selection: { measurement_id: 'm-1' },
      measurements: [measurement()],
      captured_at: '2026-05-31T12:04:00.000Z',
    })

    expect(payload).toMatchObject({
      schema_version: 1,
      artifact_type: 'takeoff.canvas_geometry',
      project_id: 'project-1',
      route_path: '/desktop/takeoff',
      active_draft_id: 'draft-1',
      stats: {
        measurement_count: 1,
        geometry_kinds: ['polygon'],
        omitted_image_thumbnail_count: 1,
      },
    })
    expect(payload.blueprint).toMatchObject({ id: 'bp-1', file_name: 'A101.pdf', version: 3 })
    expect(payload.blueprint).not.toHaveProperty('storage_path')
    expect(payload.blueprint).not.toHaveProperty('file_url')
    expect(payload.page).not.toHaveProperty('storage_path')

    const captured = payload.measurements[0]
    expect(captured).not.toHaveProperty('image_thumbnail')
    expect(captured?.geometry).toMatchObject({
      kind: 'polygon',
      points: [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ],
    })
    expect(JSON.stringify(payload)).not.toContain('data:image')
    expect(JSON.stringify(payload)).not.toContain('private-pixels')
    expect(JSON.stringify(payload)).not.toContain('storage.example')
  })

  it('serializes and uploads the artifact through the capture artifact route', async () => {
    const payload = buildCanvasGeometryArtifact({
      project_id: 'project-1',
      route_path: '/desktop/takeoff',
      measurements: [measurement({ image_thumbnail: null })],
      captured_at: '2026-05-31T12:04:00.000Z',
    })
    uploadCaptureArtifactMock.mockResolvedValueOnce({
      artifact: {
        id: 'artifact-1',
        kind: 'canvas_geometry',
        storage_key: 'co-1/capture-sessions/session-1/artifacts/canvas-geometry.json',
        content_type: 'application/json',
        byte_size: 100,
        content_hash: 'sha256:abc',
        redaction_version: 'capture-session-v1',
      },
    })

    await expect(
      uploadCanvasGeometryArtifact('00000000-0000-4000-8000-000000000123', payload, { trigger: 'finalize' }),
    ).resolves.toMatchObject({ artifact: { kind: 'canvas_geometry' } })

    expect(uploadCaptureArtifactMock).toHaveBeenCalledTimes(1)
    const [, input] = uploadCaptureArtifactMock.mock.calls[0]!
    expect(input).toMatchObject({
      kind: 'canvas_geometry',
      fileName: 'canvas-geometry.json',
      pii_level: 'internal',
      access_policy: 'support_only',
      metadata: {
        source: 'takeoff_canvas',
        artifact_type: 'takeoff.canvas_geometry',
        schema_version: 1,
        project_id: 'project-1',
        route_path: '/desktop/takeoff',
        measurement_count: 1,
        trigger: 'finalize',
      },
    })
    expect(input.file.type).toBe('application/json')
    expect(await input.file.text()).toBe(await canvasGeometryArtifactBlob(payload).text())
  })
})
