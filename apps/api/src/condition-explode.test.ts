import { describe, expect, it } from 'vitest'
import { deriveMeasurementDrivers, normalizeGeometry } from '@sitelayer/domain'
import {
  conditionHasEmitFlags,
  explodeConditionMeasurement,
  type ConditionLike,
  type ConditionMeasurementLike,
} from './condition-explode.js'

// A 10×5 board-space rectangle ("wall trace"), uncalibrated (factor 1.0 / world
// scale 1.0 — board space). Shoelace area = 50, perimeter = 30, bbox 10×5.
const WALL_POLYGON = {
  kind: 'polygon' as const,
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
    { x: 0, y: 5 },
  ],
}

function wallMeasurement(overrides: Partial<ConditionMeasurementLike> = {}): ConditionMeasurementLike {
  return {
    service_item_code: 'DRYWALL',
    quantity: 50, // an area measurement's primary derived quantity (= polygon area)
    unit: 'sqft',
    is_deduction: false,
    geometry: WALL_POLYGON,
    ...overrides,
  }
}

function condition(overrides: Partial<ConditionLike> = {}): ConditionLike {
  return {
    id: 'cond-1',
    measurement_kind: 'area',
    height_value: null,
    thickness_value: null,
    emit_linear: false,
    emit_area: false,
    emit_volume: false,
    ...overrides,
  }
}

/** The drivers the estimate path passes in: derived from the stored geometry. */
function driversFor(measurement: ConditionMeasurementLike) {
  const geo = normalizeGeometry(measurement.geometry)
  return geo ? deriveMeasurementDrivers(geo) : undefined
}

describe('conditionHasEmitFlags', () => {
  it('is false when no flag is set', () => {
    expect(conditionHasEmitFlags(condition())).toBe(false)
  })
  it('is true when any flag is set', () => {
    expect(conditionHasEmitFlags(condition({ emit_area: true }))).toBe(true)
    expect(conditionHasEmitFlags(condition({ emit_linear: true }))).toBe(true)
    expect(conditionHasEmitFlags(condition({ emit_volume: true }))).toBe(true)
  })
})

describe('explodeConditionMeasurement', () => {
  it('emits TWO typed lines for a wall condition with emit_area + emit_linear', () => {
    const m = wallMeasurement()
    const c = condition({ emit_area: true, emit_linear: true })
    const lines = explodeConditionMeasurement(m, c, driversFor(m))

    expect(lines).toHaveLength(2)

    const area = lines.find((l) => l.emit_kind === 'area')!
    expect(area.unit).toBe('sqft')
    expect(area.quantity).toBeCloseTo(50, 4) // shoelace 10×5
    expect(area.service_item_code).toBe('DRYWALL')
    expect(area.condition_id).toBe('cond-1')

    const linear = lines.find((l) => l.emit_kind === 'linear')!
    expect(linear.unit).toBe('lf')
    expect(linear.quantity).toBeCloseTo(30, 4) // perimeter 10+5+10+5
    expect(linear.condition_id).toBe('cond-1')
  })

  it('emits a VOLUME line = area × thickness when emit_volume + a thickness driver', () => {
    const m = wallMeasurement()
    const c = condition({ emit_volume: true, thickness_value: '0.5' }) // pg numeric arrives as string
    const lines = explodeConditionMeasurement(m, c, driversFor(m))

    expect(lines).toHaveLength(1)
    const volume = lines[0]!
    expect(volume.emit_kind).toBe('volume')
    expect(volume.unit).toBe('cuft')
    expect(volume.quantity).toBeCloseTo(25, 4) // 50 sqft × 0.5 ft depth
  })

  it('uses height_value as the depth when no thickness is set', () => {
    const m = wallMeasurement()
    const c = condition({ emit_volume: true, height_value: 8 })
    const lines = explodeConditionMeasurement(m, c, driversFor(m))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.quantity).toBeCloseTo(400, 4) // 50 × 8
  })

  it('emits all THREE lines for a full wall (area + linear + volume)', () => {
    const m = wallMeasurement()
    const c = condition({ emit_area: true, emit_linear: true, emit_volume: true, thickness_value: 0.5 })
    const lines = explodeConditionMeasurement(m, c, driversFor(m))
    expect(lines.map((l) => l.emit_kind).sort()).toEqual(['area', 'linear', 'volume'])
    expect(lines.find((l) => l.emit_kind === 'volume')!.quantity).toBeCloseTo(25, 4)
  })

  it('SKIPS the volume line when emit_volume is set but no depth exists', () => {
    const m = wallMeasurement()
    // emit_volume + emit_area, but no thickness/height and the polygon yields no
    // thickness driver → only the area line survives.
    const c = condition({ emit_area: true, emit_volume: true })
    const lines = explodeConditionMeasurement(m, c, driversFor(m))
    expect(lines.map((l) => l.emit_kind)).toEqual(['area'])
  })

  it('signs every emitted quantity NEGATIVE for a deduction', () => {
    const m = wallMeasurement({ is_deduction: true })
    const c = condition({ emit_area: true, emit_linear: true, emit_volume: true, thickness_value: 0.5 })
    const lines = explodeConditionMeasurement(m, c, driversFor(m))
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      expect(line.quantity).toBeLessThan(0)
    }
    expect(lines.find((l) => l.emit_kind === 'area')!.quantity).toBeCloseTo(-50, 4)
    expect(lines.find((l) => l.emit_kind === 'linear')!.quantity).toBeCloseTo(-30, 4)
    expect(lines.find((l) => l.emit_kind === 'volume')!.quantity).toBeCloseTo(-25, 4)
  })

  it('falls back to a SINGLE line (measurement qty + unit) when no emit flag is set', () => {
    const m = wallMeasurement({ quantity: 50, unit: 'sqft' })
    const c = condition() // no flags
    const lines = explodeConditionMeasurement(m, c, driversFor(m))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.quantity).toBeCloseTo(50, 4)
    expect(lines[0]!.unit).toBe('sqft')
    expect(lines[0]!.emit_kind).toBe('area') // typed from the condition's measurement_kind
    expect(lines[0]!.condition_id).toBe('cond-1')
  })

  it('fallback line is signed for a deduction with no emit flags', () => {
    const m = wallMeasurement({ is_deduction: true, quantity: 50, unit: 'sqft' })
    const lines = explodeConditionMeasurement(m, condition(), driversFor(m))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.quantity).toBeCloseTo(-50, 4)
  })

  it('derives the perimeter LF from a calibrated polygon (world scale folds in)', () => {
    // 2 ft per board unit on each axis: area 50 → 200 sqft, perimeter 30 → 60 lf.
    const calibrated: ConditionMeasurementLike = wallMeasurement({
      geometry: { ...WALL_POLYGON, world_per_board_x: 2, world_per_board_y: 2 },
    })
    const c = condition({ emit_area: true, emit_linear: true })
    const lines = explodeConditionMeasurement(calibrated, c, driversFor(calibrated))
    expect(lines.find((l) => l.emit_kind === 'area')!.quantity).toBeCloseTo(200, 4)
    expect(lines.find((l) => l.emit_kind === 'linear')!.quantity).toBeCloseTo(60, 4)
  })
})
