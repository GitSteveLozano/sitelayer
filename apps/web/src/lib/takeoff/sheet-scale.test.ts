import { describe, expect, it } from 'vitest'
import { detectSheetScale, parseScaleNotation } from './sheet-scale'

describe('parseScaleNotation', () => {
  it('parses architectural fractions to drawing-inches per foot', () => {
    expect(parseScaleNotation('1/4" = 1\'-0"')?.drawingInchesPerFoot).toBeCloseTo(0.25)
    expect(parseScaleNotation('3/8" = 1\'')?.drawingInchesPerFoot).toBeCloseTo(0.375)
    expect(parseScaleNotation('1/2"=1\'-0"')?.drawingInchesPerFoot).toBeCloseTo(0.5)
  })

  it('parses engineering scales as 1/N', () => {
    expect(parseScaleNotation('1" = 20\'')?.drawingInchesPerFoot).toBeCloseTo(0.05)
    expect(parseScaleNotation('1"=50\'')?.drawingInchesPerFoot).toBeCloseTo(0.02)
  })

  it('rejects non-scale text', () => {
    expect(parseScaleNotation('not a scale')).toBeNull()
    expect(parseScaleNotation('12\'-6"')).toBeNull()
  })
})

describe('detectSheetScale', () => {
  it('finds the scale in a title-block blob and reports it', () => {
    const text = 'SHEET A-101  FLOOR PLAN\nSCALE: 1/4" = 1\'-0"\nDATE 2026-05-30'
    const got = detectSheetScale(text)
    expect(got?.drawingInchesPerFoot).toBeCloseTo(0.25)
    expect(got?.labeled).toBe(true)
    expect(got?.label).toMatch(/1\/4/)
  })

  it('detects an engineering scale on a site plan', () => {
    const got = detectSheetScale('SITE PLAN   SCALE 1" = 20\'   NORTH')
    expect(got?.drawingInchesPerFoot).toBeCloseTo(0.05)
  })

  it('prefers the notation next to a SCALE label over an unrelated match', () => {
    // A stray "1" = 1'" elsewhere should lose to the labeled 1/8" scale.
    const text = 'DETAIL 1" = 1\' ... ... ... ... ... ... ... ... ... SCALE: 1/8" = 1\'-0"'
    const got = detectSheetScale(text)
    expect(got?.drawingInchesPerFoot).toBeCloseTo(0.125)
    expect(got?.labeled).toBe(true)
  })

  it('returns null when there is no scale notation', () => {
    expect(detectSheetScale('FLOOR PLAN — NOT TO SCALE')).toBeNull()
    expect(detectSheetScale('')).toBeNull()
  })

  it('normalizes prime / curly-quote marks', () => {
    // 1/4″ = 1′-0″ using primes (U+2033 / U+2032).
    const got = detectSheetScale('SCALE: 1/4″ = 1′-0″')
    expect(got?.drawingInchesPerFoot).toBeCloseTo(0.25)
  })
})
