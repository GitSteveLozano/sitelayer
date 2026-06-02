import { describe, expect, it } from 'vitest'
import {
  deriveMeasurementDrivers,
  resolveAssembly,
  type AssemblyComponent,
  type AssemblyHeader,
  type LinealGeometry,
  type PolygonGeometry,
  type VolumeGeometry,
} from './index.js'

/**
 * M2 (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §5.3): a single drawn object exposes
 * real-world DRIVERS (height/width/thickness/perimeter/sides) so one wall can
 * drive plate-LF from its run, stud-count from its height, and sheet-count from
 * its area. The explode wiring (apps/api/src/assembly-explode.ts) binds these
 * into the formula + include_when context; here we cover the pure domain pieces:
 * (1) deriving the drivers from geometry, and (2) the resolveAssembly behavior an
 * include_when "skip" produces (the skipped component is simply absent from the
 * component list the explode path passes in).
 */

describe('deriveMeasurementDrivers', () => {
  it('derives width/height/perimeter/sides for a scaled rectangle polygon', () => {
    // 10 board-units wide × 5 board-units tall, scaled 2 ft/unit on both axes →
    // 20 ft wide × 10 ft tall, perimeter 2·(20+10)=60 ft, 4 vertices.
    const geometry: PolygonGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      world_per_board_x: 2,
      world_per_board_y: 2,
    }
    const d = deriveMeasurementDrivers(geometry)
    expect(d.width).toBeCloseTo(20, 4)
    expect(d.height).toBeCloseTo(10, 4)
    expect(d.perimeter).toBeCloseTo(60, 4)
    expect(d.sides).toBe(4)
    // polygons have no geometric thickness source.
    expect(d.thickness).toBeUndefined()
  })

  it('drives multiple component quantities from ONE polygon (the M2 case)', () => {
    // One 20ft × 10ft wall (area 200 sqft) drives: plate-LF from perimeter,
    // stud-count from height, sheet-count from area — exactly the PlanSwift
    // parent-driver propagation the deep-dive calls for.
    const geometry: PolygonGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      world_per_board_x: 2,
      world_per_board_y: 2,
    }
    const d = deriveMeasurementDrivers(geometry)
    expect(d.perimeter).toBeCloseTo(60, 4) // plate LF input
    expect(d.height).toBeCloseTo(10, 4) // stud-count input
    expect(d.width).toBeCloseTo(20, 4) // sheet-count-by-run input
  })

  it('treats a lineal run as perimeter + width with a segment count', () => {
    // Two segments: (0,0)->(10,0)->(10,0) collapses; use a real 2-segment run.
    const geometry: LinealGeometry = {
      kind: 'lineal',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ],
      world_per_board_x: 1,
      world_per_board_y: 1,
    }
    const d = deriveMeasurementDrivers(geometry)
    expect(d.perimeter).toBeCloseTo(20, 4)
    expect(d.width).toBeCloseTo(20, 4)
    expect(d.sides).toBe(2)
    expect(d.height).toBeUndefined()
  })

  it('maps a volume to width/height/perimeter + thickness=min(w,h)', () => {
    const geometry: VolumeGeometry = { kind: 'volume', length: 30, width: 8, height: 12 }
    const d = deriveMeasurementDrivers(geometry)
    expect(d.width).toBe(8)
    expect(d.height).toBe(12)
    expect(d.perimeter).toBe(30)
    expect(d.thickness).toBe(8)
  })

  it('lets an explicit drivers override win over the geometry-derived value', () => {
    const geometry: PolygonGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      world_per_board_x: 2,
      world_per_board_y: 2,
      // A typed wall height + a thickness the geometry has no source for.
      drivers: { height: 9, thickness: 0.5 },
    }
    const d = deriveMeasurementDrivers(geometry)
    expect(d.height).toBe(9) // override beats the geometric 10
    expect(d.thickness).toBe(0.5) // supplied where geometry had none
    expect(d.width).toBeCloseTo(20, 4) // un-overridden field still geometric
  })

  it('returns no drivers for a degenerate (empty) polygon', () => {
    const geometry: PolygonGeometry = { kind: 'polygon', points: [] }
    const d = deriveMeasurementDrivers(geometry)
    expect(d.width).toBeUndefined()
    expect(d.height).toBeUndefined()
    expect(d.perimeter).toBeUndefined()
    expect(d.sides).toBeUndefined()
  })
})

describe('resolveAssembly with an include_when-skipped component', () => {
  const header: AssemblyHeader = { id: 'a-1', service_item_code: 'WALL', name: 'Framed wall', unit: 'sqft' }
  const comp = (overrides: Partial<AssemblyComponent> = {}): AssemblyComponent => ({
    id: `c-${Math.random().toString(16).slice(2)}`,
    assembly_id: 'a-1',
    kind: 'material',
    name: 'stud',
    quantity_per_unit: 1,
    unit: 'ea',
    unit_cost: 1,
    waste_pct: 0,
    sort_order: 0,
    ...overrides,
  })

  it('omits the skipped component from totals + lines', () => {
    // The explode path drops an include_when-false component BEFORE calling
    // resolveAssembly, so resolveAssembly never sees it. This asserts the
    // resulting math: only the retained components contribute.
    const studs = comp({ id: 'studs', name: 'studs', quantity_per_unit: 1, unit_cost: 3, sort_order: 1 })
    const insulation = comp({ id: 'insul', name: 'insulation', quantity_per_unit: 1, unit_cost: 5, sort_order: 2 })

    const withInsulation = resolveAssembly(100, header, [studs, insulation])
    expect(withInsulation.lines).toHaveLength(2)
    expect(withInsulation.total).toBe(100 * 3 + 100 * 5)

    // include_when false => caller drops `insulation` from the component list.
    const skipped = resolveAssembly(100, header, [studs])
    expect(skipped.lines).toHaveLength(1)
    expect(skipped.lines[0]!.component_id).toBe('studs')
    expect(skipped.total).toBe(100 * 3)
  })
})
