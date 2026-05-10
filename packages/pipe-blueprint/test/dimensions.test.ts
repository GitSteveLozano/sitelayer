import { describe, expect, it } from 'vitest'
import {
  dimensionMatches,
  parseArchitecturalScale,
  parseDimensionToFeet,
  pixelsPerFootFromScaleText,
} from '../src/dimensions.js'

describe('parseDimensionToFeet', () => {
  it.each([
    ["12'", 12],
    ['12\'-0"', 12],
    ['12\' 0"', 12],
    ['12\'-6"', 12.5],
    ['12\'-6 1/2"', 12 + 6.5 / 12],
    ["±29'", 29],
    ["12.5'", 12.5],
    ['12.5 ft', 12.5],
    ['6"', 0.5],
    ['6 1/2"', 6.5 / 12],
    ['12\'6"BM', 12.5],
  ])('parses %s → %s ft', (input, expected) => {
    const v = parseDimensionToFeet(input)
    expect(v).not.toBeNull()
    expect(v!).toBeCloseTo(expected, 5)
  })

  it('returns null for ambiguous bare numbers', () => {
    expect(parseDimensionToFeet('12.5')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseDimensionToFeet('')).toBeNull()
  })
})

describe('parseArchitecturalScale', () => {
  it.each([
    ['1/4" = 1\'-0"', 0.25],
    ['1/8" = 1\'-0"', 0.125],
    ['3/16" = 1\'-0"', 0.1875],
    ['1/2" = 1\'-0"', 0.5],
  ])('parses %s', (input, expected) => {
    const r = parseArchitecturalScale(input)
    expect(r).not.toBeNull()
    expect(r!.drawingInchesPerFoot).toBeCloseTo(expected, 5)
  })

  it('parses engineering scale 1" = 20\'', () => {
    const r = parseArchitecturalScale('1" = 20\'')
    expect(r).not.toBeNull()
    expect(r!.drawingInchesPerFoot).toBeCloseTo(0.05, 5)
  })
})

describe('pixelsPerFootFromScaleText', () => {
  it('1/4" = 1\'-0" at 100 DPI → 25 px/ft', () => {
    const px = pixelsPerFootFromScaleText('1/4" = 1\'-0"', 100)
    expect(px).toBeCloseTo(25, 5)
  })
})

describe('dimensionMatches', () => {
  it('matches 12 ft against "12\'-0""', () => {
    expect(dimensionMatches(12, '12\'-0"')).toBe(true)
  })
  it('matches 12.5 ft against "12\'-6""', () => {
    expect(dimensionMatches(12.5, '12\'-6"')).toBe(true)
  })
  it('rejects mismatches outside tolerance', () => {
    expect(dimensionMatches(12, '15\'-0"')).toBe(false)
  })
})
