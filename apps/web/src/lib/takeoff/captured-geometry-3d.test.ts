import { describe, expect, it } from 'vitest'
import { buildCapturedGeometryScene, isCapturedPreviewId, mergeCapturedSceneIntoBase } from './captured-geometry-3d'
import { buildTakeoffPreviewScene } from './geometry-3d'
import type { CapturedGeometry, TakeoffMeasurement } from '@/lib/api'

describe('buildCapturedGeometryScene', () => {
  it('returns null when there is no geometry', () => {
    expect(buildCapturedGeometryScene(null)).toBeNull()
    expect(buildCapturedGeometryScene(undefined)).toBeNull()
    expect(buildCapturedGeometryScene({})).toBeNull()
  })

  it('renders a floor surface polygon as a normalized polygon item', () => {
    const geometry: CapturedGeometry = {
      surfaces: [
        {
          id: 's1',
          kind: 'floor',
          // 200 x 100 rectangle in source-space coords.
          polygon: [
            [100, 100],
            [300, 100],
            [300, 200],
            [100, 200],
          ],
        },
      ],
    }

    const scene = buildCapturedGeometryScene(geometry)
    expect(scene).not.toBeNull()
    const item = scene!.items.find((candidate) => candidate.serviceItemCode === 'CAP·FLOOR')
    expect(item).toBeDefined()
    expect(item?.kind).toBe('polygon')
    expect(isCapturedPreviewId(item!.id)).toBe(true)
    // Largest span (200) normalizes to ~60 ft centered at origin: x spans -30..30.
    const xs = item!.points.map((point) => point.x)
    expect(Math.min(...xs)).toBeCloseTo(-30)
    expect(Math.max(...xs)).toBeCloseTo(30)
    expect(item?.heightFt).toBe(0.08)
    expect(scene!.hasCalibration).toBe(false)
    expect(scene!.warnings.join(' ')).toContain('normalized (relative) scale')
  })

  it('maps walls to lineals and openings to count markers', () => {
    const geometry: CapturedGeometry = {
      surfaces: [
        {
          id: 'wall-1',
          kind: 'wall',
          polygon: [
            [0, 0],
            [120, 0],
          ],
        },
        {
          id: 'door-1',
          kind: 'opening',
          polygon: [
            [40, 0],
            [60, 0],
            [60, 5],
            [40, 5],
          ],
        },
      ],
    }

    const scene = buildCapturedGeometryScene(geometry, { defaultWallHeightFt: 10 })
    expect(scene).not.toBeNull()
    const wall = scene!.items.find((item) => item.serviceItemCode === 'CAP·WALL')
    const opening = scene!.items.find((item) => item.serviceItemCode === 'CAP·OPENING')
    expect(wall?.kind).toBe('lineal')
    expect(wall?.heightFt).toBe(10)
    expect(opening?.kind).toBe('count')
    // The opening collapses to a single centroid marker.
    expect(opening?.points).toHaveLength(1)
  })

  it('renders RoomPlan wall lines (start/end/height) as extruded lineal wall boxes', () => {
    const geometry: CapturedGeometry = {
      walls: [
        // 12-ft east-running wall, 8-ft tall.
        { id: 'w1', start: [0, 0], end: [12, 0], heightFt: 8, thicknessFt: 0.52 },
        // 14-ft south-running wall, 8-ft tall.
        { id: 'w2', start: [12, 0], end: [12, 14], heightFt: 8, thicknessFt: 0.52 },
      ],
    }

    const scene = buildCapturedGeometryScene(geometry)
    expect(scene).not.toBeNull()
    const walls = scene!.items.filter((item) => item.serviceItemCode === 'CAP·WALL')
    expect(walls).toHaveLength(2)
    for (const wall of walls) {
      expect(wall.kind).toBe('lineal')
      // The captured wall height (8 ft) reaches the scene, not the polygon thickness.
      expect(wall.heightFt).toBe(8)
      expect(wall.points).toHaveLength(2)
      expect(isCapturedPreviewId(wall.id)).toBe(true)
    }
  })

  it('falls back to the default wall height when a captured wall omits heightFt', () => {
    const geometry = {
      walls: [{ id: 'w1', start: [0, 0], end: [10, 0] }],
    } as unknown as CapturedGeometry

    const scene = buildCapturedGeometryScene(geometry, { defaultWallHeightFt: 11 })
    expect(scene).not.toBeNull()
    const wall = scene!.items.find((item) => item.serviceItemCode === 'CAP·WALL')
    expect(wall?.kind).toBe('lineal')
    expect(wall?.heightFt).toBe(11)
  })

  it('renders object bboxes as count markers', () => {
    const geometry: CapturedGeometry = {
      objects: [
        { id: 'fixture-1', category: 'sink', bbox: [10, 10, 2, 2] },
        { id: 'fixture-2', category: 'toilet', bbox: [40, 30, 2, 2] },
      ],
    }

    const scene = buildCapturedGeometryScene(geometry)
    expect(scene).not.toBeNull()
    expect(scene!.items.filter((item) => item.serviceItemCode === 'CAP·OBJECT')).toHaveLength(2)
    expect(scene!.items.every((item) => item.kind === 'count')).toBe(true)
  })

  it('projects drone lon/lat footprints at true scale', () => {
    const lat = 43.6
    const dLon = 20 / (364_000 * Math.cos((lat * Math.PI) / 180))
    const dLat = 10 / 364_000
    const geometry: CapturedGeometry = {
      surfaces: [
        {
          id: 'roof-1',
          kind: 'roof',
          polygon: [
            [-79.4, lat],
            [-79.4 + dLon, lat],
            [-79.4 + dLon, lat + dLat],
            [-79.4, lat + dLat],
          ],
        },
      ],
    }

    const scene = buildCapturedGeometryScene(geometry, { source: 'drone' })
    expect(scene).not.toBeNull()
    const roof = scene!.items.find((item) => item.serviceItemCode === 'CAP·ROOF')!
    const xs = roof.points.map((point) => point.x)
    const zs = roof.points.map((point) => point.z)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 0)
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(10, 0)
    expect(scene!.unitLabel).toBe('ft')
    expect(scene!.warnings.join(' ')).toContain('drone GPS')
  })

  it('reports rooms-only geometry as non-drawable', () => {
    const geometry: CapturedGeometry = {
      rooms: [{ id: 'r1', label: 'Kitchen', floorAreaSqFt: 120 }],
    }
    expect(buildCapturedGeometryScene(geometry)).toBeNull()
  })
})

describe('mergeCapturedSceneIntoBase', () => {
  const baseMeasurement = {
    id: 'm1',
    project_id: 'p1',
    blueprint_document_id: 'b1',
    page_id: null,
    service_item_code: '09 29 00',
    quantity: '100',
    unit: 'sqft',
    notes: null,
    elevation: null,
    image_thumbnail: null,
    version: 1,
    created_at: '2026-05-20T00:00:00Z',
  } satisfies Omit<TakeoffMeasurement, 'geometry'>

  it('returns the base scene unchanged when there is no captured geometry', () => {
    const base = buildTakeoffPreviewScene([
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
    ])
    expect(mergeCapturedSceneIntoBase(base, null)).toBe(base)
  })

  it('appends captured items to the manual measurement scene', () => {
    const base = buildTakeoffPreviewScene([
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
    ])
    const captured = buildCapturedGeometryScene({
      surfaces: [
        {
          id: 's1',
          kind: 'floor',
          polygon: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
        },
      ],
    })

    const merged = mergeCapturedSceneIntoBase(base, captured)
    expect(merged.items.length).toBe(base.items.length + captured!.items.length)
    expect(merged.items.some((item) => item.id === 'm1')).toBe(true)
    expect(merged.items.some((item) => isCapturedPreviewId(item.id))).toBe(true)
  })
})
