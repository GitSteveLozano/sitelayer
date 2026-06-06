import { describe, expect, it } from 'vitest'
import {
  buildCapturedGeometryScene,
  isCapturedPreviewId,
  mergeCapturedSceneIntoBase,
} from '@/lib/takeoff/captured-geometry-3d'
import { buildTakeoffPreviewScene } from '@/lib/takeoff/geometry-3d'
import { TAKEOFF_DEMO_FIXTURES } from './takeoff-preview-demo-fixtures'

// These tests pin the public demo harness (/demo/takeoff-preview-3d) to the
// exact mapping path the screen uses: each fixture's manual `measurements` go
// through `buildTakeoffPreviewScene`, any captured-draft `TakeoffGeometry` goes
// through `buildCapturedGeometryScene`, and the two merge into one scene. They
// guard the captured-draft fixture specifically, since that is the proof that a
// captured draft renders in 3D in the harness with zero committed measurements.

const CAPTURED_FIXTURE_ID = 'captured-room'

function buildFixtureScene(fixture: (typeof TAKEOFF_DEMO_FIXTURES)[number]) {
  const base = buildTakeoffPreviewScene(fixture.measurements, {
    activeBlueprintId: fixture.blueprintId,
    activePage: fixture.page,
  })
  const captured = buildCapturedGeometryScene(fixture.capturedGeometry, {
    source: fixture.capturedSource ?? null,
  })
  return mergeCapturedSceneIntoBase(base, captured)
}

describe('takeoff demo fixtures', () => {
  it('every fixture has a unique id and a non-empty drawable scene', () => {
    const ids = new Set<string>()
    for (const fixture of TAKEOFF_DEMO_FIXTURES) {
      expect(ids.has(fixture.id)).toBe(false)
      ids.add(fixture.id)
      const scene = buildFixtureScene(fixture)
      expect(scene.items.length).toBeGreaterThan(0)
    }
  })

  it('ships a captured-draft fixture that carries geometry but no committed measurements', () => {
    const fixture = TAKEOFF_DEMO_FIXTURES.find((candidate) => candidate.id === CAPTURED_FIXTURE_ID)
    expect(fixture).toBeDefined()
    expect(fixture!.measurements).toHaveLength(0)
    expect(fixture!.capturedGeometry).toBeDefined()
    expect(fixture!.capturedGeometry?.surfaces?.length ?? 0).toBeGreaterThan(0)
  })
})

describe('captured-room demo fixture renders captured geometry', () => {
  const fixture = TAKEOFF_DEMO_FIXTURES.find((candidate) => candidate.id === CAPTURED_FIXTURE_ID)!

  it('produces a captured scene with floor, wall, opening, and object items', () => {
    const captured = buildCapturedGeometryScene(fixture.capturedGeometry, {
      source: fixture.capturedSource ?? null,
    })
    expect(captured).not.toBeNull()
    const kinds = new Map(captured!.items.map((item) => [item.serviceItemCode, item.kind]))
    expect(kinds.get('CAP·FLOOR')).toBe('polygon')
    expect(kinds.get('CAP·WALL')).toBe('lineal')
    expect(kinds.get('CAP·OPENING')).toBe('count')
    expect(kinds.get('CAP·OBJECT')).toBe('count')
    // Every captured item id is namespaced so it can never collide with a
    // committed-measurement id once merged into the base scene.
    expect(captured!.items.every((item) => isCapturedPreviewId(item.id))).toBe(true)
  })

  it('bounds-normalizes the source-space footprint to the relative target span', () => {
    const captured = buildCapturedGeometryScene(fixture.capturedGeometry, {
      source: fixture.capturedSource ?? null,
    })!
    const floor = captured.items.find((item) => item.serviceItemCode === 'CAP·FLOOR')!
    const xs = floor.points.map((point) => point.x)
    // The 600 x 500 source rectangle normalizes its largest span (600) to the
    // ~60 ft relative target, centered on the origin: x spans -30..30.
    expect(Math.min(...xs)).toBeCloseTo(-30)
    expect(Math.max(...xs)).toBeCloseTo(30)
    expect(captured.hasCalibration).toBe(false)
    expect(captured.warnings.join(' ')).toContain('normalized (relative) scale')
  })

  it('renders entirely from captured geometry when there are no committed measurements', () => {
    const scene = buildFixtureScene(fixture)
    expect(scene.items.length).toBeGreaterThan(0)
    // No manual measurements, so every drawable item is captured.
    expect(scene.items.every((item) => isCapturedPreviewId(item.id))).toBe(true)
  })
})
