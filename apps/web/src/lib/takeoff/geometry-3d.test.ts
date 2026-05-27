import { describe, expect, it } from 'vitest'
import { buildTakeoffPreviewScene } from './geometry-3d'
import type { BlueprintPage, TakeoffMeasurement } from '@/lib/api'

const baseMeasurement = {
  id: 'm1',
  project_id: 'p1',
  blueprint_document_id: 'b1',
  page_id: 'page1',
  service_item_code: '09 29 00',
  quantity: '100',
  unit: 'sqft',
  notes: null,
  elevation: null,
  image_thumbnail: null,
  version: 1,
  created_at: '2026-05-20T00:00:00Z',
} satisfies Omit<TakeoffMeasurement, 'geometry'>

const calibratedPage = {
  id: 'page1',
  blueprint_document_id: 'b1',
  page_number: 1,
  storage_path: null,
  calibration_world_distance: '30',
  calibration_world_unit: 'ft',
  calibration_x1: '10',
  calibration_y1: '10',
  calibration_x2: '40',
  calibration_y2: '10',
  calibration_set_at: '2026-05-20T00:00:00Z',
  measurement_count: 1,
} satisfies BlueprintPage

describe('buildTakeoffPreviewScene', () => {
  it('converts board-space polygons into calibrated world coordinates', () => {
    const scene = buildTakeoffPreviewScene(
      [
        {
          ...baseMeasurement,
          geometry: {
            kind: 'polygon',
            points: [
              { x: 50, y: 50 },
              { x: 60, y: 50 },
              { x: 60, y: 60 },
            ],
          },
        },
      ],
      { activeBlueprintId: 'b1', activePage: calibratedPage },
    )

    expect(scene.hasCalibration).toBe(true)
    expect(scene.worldPerBoardUnit).toBe(1)
    expect(scene.items).toHaveLength(1)
    expect(scene.items[0]?.points).toEqual([
      { x: 0, z: 0, boardX: 50, boardY: 50 },
      { x: 10, z: 0, boardX: 60, boardY: 50 },
      { x: 10, z: 10, boardX: 60, boardY: 60 },
    ])
    expect(scene.items[0]?.heightFt).toBe(0.08)
  })

  it('filters to the active blueprint', () => {
    const scene = buildTakeoffPreviewScene(
      [
        {
          ...baseMeasurement,
          geometry: { kind: 'count', points: [{ x: 50, y: 50 }] },
        },
        {
          ...baseMeasurement,
          id: 'm2',
          blueprint_document_id: 'b2',
          geometry: { kind: 'count', points: [{ x: 60, y: 60 }] },
        },
      ],
      { activeBlueprintId: 'b1' },
    )

    expect(scene.items.map((item) => item.id)).toEqual(['m1'])
  })

  it('filters to the active blueprint page with page-one fallback for legacy rows', () => {
    const page2 = { ...calibratedPage, id: 'page2', page_number: 2 }
    const scene = buildTakeoffPreviewScene(
      [
        {
          ...baseMeasurement,
          id: 'page-1',
          page_id: 'page1',
          geometry: { kind: 'count', points: [{ x: 50, y: 50 }] },
        },
        {
          ...baseMeasurement,
          id: 'page-2',
          page_id: 'page2',
          geometry: { kind: 'count', points: [{ x: 60, y: 60 }] },
        },
        {
          ...baseMeasurement,
          id: 'legacy-page-1',
          page_id: null,
          geometry: { kind: 'count', points: [{ x: 70, y: 70 }] },
        },
      ],
      { activeBlueprintId: 'b1', activePage: page2 },
    )

    expect(scene.items.map((item) => item.id)).toEqual(['page-2'])

    const page1Scene = buildTakeoffPreviewScene(
      [
        {
          ...baseMeasurement,
          id: 'page-1',
          page_id: 'page1',
          geometry: { kind: 'count', points: [{ x: 50, y: 50 }] },
        },
        {
          ...baseMeasurement,
          id: 'legacy-page-1',
          page_id: null,
          geometry: { kind: 'count', points: [{ x: 70, y: 70 }] },
        },
      ],
      { activeBlueprintId: 'b1', activePage: calibratedPage },
    )
    expect(page1Scene.items.map((item) => item.id)).toEqual(['page-1', 'legacy-page-1'])
    expect(page1Scene.warnings.join(' ')).toContain('had no page_id')
  })

  it('assigns vertical preview heights to lineals and opening counts', () => {
    const scene = buildTakeoffPreviewScene(
      [
        {
          ...baseMeasurement,
          id: 'wall-run',
          service_item_code: '09 22 16',
          geometry: {
            kind: 'lineal',
            points: [
              { x: 40, y: 50 },
              { x: 60, y: 50 },
            ],
          },
        },
        {
          ...baseMeasurement,
          id: 'window-count',
          service_item_code: '08 50 00',
          geometry: { kind: 'count', points: [{ x: 52, y: 50 }] },
        },
        {
          ...baseMeasurement,
          id: 'door-count',
          service_item_code: '08 14 00',
          geometry: { kind: 'count', points: [{ x: 58, y: 50 }] },
        },
      ],
      { activeBlueprintId: 'b1', activePage: calibratedPage, defaultWallHeightFt: 10 },
    )

    expect(scene.items.find((item) => item.id === 'wall-run')?.heightFt).toBe(10)
    expect(scene.items.find((item) => item.id === 'window-count')?.heightFt).toBeCloseTo(3.6)
    expect(scene.items.find((item) => item.id === 'door-count')?.heightFt).toBeCloseTo(7.2)
  })

  it('warns and skips unsupported geometry blobs', () => {
    const scene = buildTakeoffPreviewScene([
      {
        ...baseMeasurement,
        geometry: {},
      },
    ])

    expect(scene.items).toHaveLength(0)
    expect(scene.skippedCount).toBe(1)
    expect(scene.warnings.join(' ')).toContain('unsupported or incomplete geometry')
  })

  it('renders captured polygons normalized to relative scale, bypassing the blueprint filter', () => {
    const scene = buildTakeoffPreviewScene(
      [
        {
          ...baseMeasurement,
          id: 'cap1',
          // Promoted captures carry no blueprint/page association.
          blueprint_document_id: null,
          page_id: null,
          geometry: {
            kind: 'capture',
            surfaceId: 's1',
            refs: ['s1'],
            // Source-space coords (e.g. image pixels): a 200x100 rectangle.
            polygon: [
              [100, 100],
              [300, 100],
              [300, 200],
              [100, 200],
            ],
          },
        },
      ],
      // A blueprint filter is active, yet the capture must still render.
      { activeBlueprintId: 'b1' },
    )

    const item = scene.items.find((i) => i.id === 'cap1')
    expect(item).toBeDefined()
    expect(item?.kind).toBe('polygon')
    expect(item?.points).toHaveLength(4)
    // Largest span (200) maps to ~60 ft, centered at origin: x spans -30..30.
    const xs = item!.points.map((p) => p.x)
    expect(Math.min(...xs)).toBeCloseTo(-30)
    expect(Math.max(...xs)).toBeCloseTo(30)
    expect(scene.skippedCount).toBe(0)
    expect(scene.warnings.join(' ')).toContain('normalized (relative) scale')
  })

  it('drops a capture geometry with too few points', () => {
    const scene = buildTakeoffPreviewScene([
      {
        ...baseMeasurement,
        id: 'cap-bad',
        blueprint_document_id: null,
        page_id: null,
        geometry: { kind: 'capture', refs: ['s1'], polygon: [[1, 1]] },
      },
    ])
    expect(scene.items).toHaveLength(0)
  })
})
