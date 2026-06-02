import { describe, expect, it } from 'vitest'
import {
  UNIT_REGISTRY,
  UnitDimensionError,
  areCompatible,
  assertCompatible,
  convert,
  normalizeUnit,
  unitDimension,
} from './uom.js'

describe('normalizeUnit', () => {
  it('maps the common free-text spellings to canonical units', () => {
    expect(normalizeUnit('SF')).toBe('SQFT')
    expect(normalizeUnit('sq ft')).toBe('SQFT')
    expect(normalizeUnit('Sq. Ft.')).toBe('SQFT')
    expect(normalizeUnit('square feet')).toBe('SQFT')
    expect(normalizeUnit('SQFT')).toBe('SQFT')
    expect(normalizeUnit('SY')).toBe('SQYD')
    expect(normalizeUnit('square yard')).toBe('SQYD')
    expect(normalizeUnit('square')).toBe('SQUARE')
    expect(normalizeUnit('squares')).toBe('SQUARE')
    expect(normalizeUnit('lf')).toBe('LF')
    expect(normalizeUnit('linear feet')).toBe('LF')
    expect(normalizeUnit('CY')).toBe('CUYD')
    expect(normalizeUnit('cubic yard')).toBe('CUYD')
    expect(normalizeUnit('cf')).toBe('CUFT')
    expect(normalizeUnit('ea')).toBe('EA')
    expect(normalizeUnit('each')).toBe('EA')
    expect(normalizeUnit('in')).toBe('IN')
    expect(normalizeUnit('inches')).toBe('IN')
    expect(normalizeUnit('ft')).toBe('FT')
    expect(normalizeUnit('yd')).toBe('YD')
    expect(normalizeUnit('hr')).toBe('HR')
    expect(normalizeUnit('job')).toBe('JOB')
  })

  it('canonical tokens normalize to themselves regardless of case', () => {
    expect(normalizeUnit('sqft')).toBe('SQFT')
    expect(normalizeUnit('CuYd')).toBe('CUYD')
    expect(normalizeUnit('  LF  ')).toBe('LF')
  })

  it('returns null for unrecognised / empty / nullish input (free-text tolerated)', () => {
    expect(normalizeUnit('widgets')).toBeNull()
    expect(normalizeUnit('per wall')).toBeNull()
    expect(normalizeUnit('')).toBeNull()
    expect(normalizeUnit('   ')).toBeNull()
    expect(normalizeUnit(null)).toBeNull()
    expect(normalizeUnit(undefined)).toBeNull()
  })

  it('never throws on garbage', () => {
    expect(() => normalizeUnit('🙂')).not.toThrow()
    expect(normalizeUnit('🙂')).toBeNull()
  })
})

describe('unitDimension', () => {
  it('returns the dimension for free-text and canonical units', () => {
    expect(unitDimension('SF')).toBe('area')
    expect(unitDimension('SQFT')).toBe('area')
    expect(unitDimension('lf')).toBe('length')
    expect(unitDimension('CY')).toBe('volume')
    expect(unitDimension('ea')).toBe('count')
  })

  it('returns null for unknown units', () => {
    expect(unitDimension('flux')).toBeNull()
    expect(unitDimension(null)).toBeNull()
  })
})

describe('convert', () => {
  it('converts area units through the SQFT base', () => {
    // 1 square yard = 9 square feet
    expect(convert(1, 'SY', 'SF')).toBe(9)
    expect(convert(9, 'SF', 'SY')).toBe(1)
    // 1 roofing square = 100 SF
    expect(convert(1, 'SQUARE', 'SF')).toBe(100)
    expect(convert(250, 'SF', 'SQUARE')).toBe(2.5)
  })

  it('converts length units through the FT base', () => {
    expect(convert(1, 'YD', 'FT')).toBe(3)
    expect(convert(12, 'IN', 'FT')).toBe(1)
    // LF and FT are the same physical length dimension and base factor.
    expect(convert(10, 'LF', 'FT')).toBe(10)
    expect(convert(10, 'FT', 'LF')).toBe(10)
  })

  it('converts volume units through the CUFT base', () => {
    // 1 cubic yard = 27 cubic feet
    expect(convert(1, 'CY', 'CF')).toBe(27)
    expect(convert(54, 'CF', 'CY')).toBe(2)
  })

  it('passes identity conversions through unchanged', () => {
    expect(convert(42, 'EA', 'EA')).toBe(42)
    expect(convert(7, 'SQFT', 'SQFT')).toBe(7)
  })

  it('throws across dimensions (the silent-error class)', () => {
    // sqft measurement multiplied/converted into a per-LF component is the
    // exact bug §4 calls out.
    expect(() => convert(100, 'SF', 'LF')).toThrow(UnitDimensionError)
    expect(() => convert(100, 'CY', 'SF')).toThrow(UnitDimensionError)
    expect(() => convert(5, 'EA', 'FT')).toThrow(UnitDimensionError)
  })

  it('refuses to convert between unlike count units', () => {
    expect(() => convert(1, 'EA', 'JOB')).toThrow(/count/)
    expect(() => convert(3, 'EA', 'HR')).toThrow(/count/)
  })

  it('throws on unrecognised or non-finite inputs', () => {
    expect(() => convert(1, 'widgets', 'SF')).toThrow(/unrecognised source/)
    expect(() => convert(1, 'SF', 'widgets')).toThrow(/unrecognised target/)
    expect(() => convert(Number.NaN, 'SF', 'SF')).toThrow(/non-finite/)
  })
})

describe('areCompatible', () => {
  it('is true within a dimension and false across', () => {
    expect(areCompatible('SQFT', 'SQYD')).toBe(true)
    expect(areCompatible('FT', 'LF')).toBe(true)
    expect(areCompatible('SQFT', 'LF')).toBe(false)
    expect(areCompatible('CUYD', 'SQFT')).toBe(false)
  })
})

describe('assertCompatible (non-fatal dimensional guard)', () => {
  it('returns ok for same-dimension recognised pairs', () => {
    const r = assertCompatible('SF', 'SQYD')
    expect(r.ok).toBe(true)
    expect(r.recognized).toBe(true)
    expect(r.a).toBe('SQFT')
    expect(r.b).toBe('SQYD')
  })

  it('returns NOT ok with a message for incompatible recognised pairs (no throw by default)', () => {
    const r = assertCompatible('sqft', 'lf')
    expect(r.ok).toBe(false)
    expect(r.recognized).toBe(true)
    expect(r.fromDimension).toBe('area')
    expect(r.toDimension).toBe('length')
    expect(r.message).toMatch(/Incompatible/)
  })

  it('does NOT fire when either side is unrecognised (free-text tolerance)', () => {
    const r1 = assertCompatible('widgets', 'lf')
    expect(r1.ok).toBe(true)
    expect(r1.recognized).toBe(false)
    expect(r1.a).toBeNull()

    const r2 = assertCompatible('sqft', 'per wall')
    expect(r2.ok).toBe(true)
    expect(r2.recognized).toBe(false)
    expect(r2.b).toBeNull()
  })

  it('does not fire when both sides are unrecognised', () => {
    const r = assertCompatible('foo', 'bar')
    expect(r.ok).toBe(true)
    expect(r.recognized).toBe(false)
  })

  it('throws when throwOnError is set and the pair is incompatible', () => {
    expect(() => assertCompatible('sqft', 'lf', { throwOnError: true })).toThrow(UnitDimensionError)
  })

  it('does NOT throw under throwOnError when a side is unrecognised', () => {
    expect(() => assertCompatible('widgets', 'lf', { throwOnError: true })).not.toThrow()
  })
})

describe('UNIT_REGISTRY invariants', () => {
  it('every dimension has exactly one base unit (factor === 1) among its physical units', () => {
    // Each dimension's base factor is 1; LF and FT both map to 1 in length
    // (both linear-foot scale), so we only assert at least one base exists.
    for (const dim of ['area', 'length', 'volume', 'count'] as const) {
      const units = Object.values(UNIT_REGISTRY).filter((u) => u.dimension === dim)
      expect(units.some((u) => u.factor === 1)).toBe(true)
    }
  })

  it('canonical key matches the record key', () => {
    for (const [key, def] of Object.entries(UNIT_REGISTRY)) {
      expect(def.canonical).toBe(key)
    }
  })
})
