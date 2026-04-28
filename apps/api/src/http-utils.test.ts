import { describe, expect, it } from 'vitest'
import { HttpError, isValidDateInput, isValidUuid, parseExpectedVersion, parseOptionalNumber } from './http-utils.js'

describe('HttpError', () => {
  it('captures status and message', () => {
    const err = new HttpError(413, 'too big')
    expect(err.status).toBe(413)
    expect(err.message).toBe('too big')
    expect(err.name).toBe('HttpError')
  })
})

describe('isValidDateInput', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(isValidDateInput('2026-04-28')).toBe(true)
    expect(isValidDateInput('1999-01-01')).toBe(true)
  })

  it('rejects malformed dates', () => {
    expect(isValidDateInput('2026/04/28')).toBe(false)
    expect(isValidDateInput('2026-4-28')).toBe(false)
    expect(isValidDateInput('2026-04-28T10:00')).toBe(false)
    expect(isValidDateInput('')).toBe(false)
    expect(isValidDateInput(null)).toBe(false)
    expect(isValidDateInput(undefined)).toBe(false)
    expect(isValidDateInput(20260428)).toBe(false)
  })
})

describe('parseOptionalNumber', () => {
  it('returns null for nullish/empty inputs', () => {
    expect(parseOptionalNumber(undefined)).toBeNull()
    expect(parseOptionalNumber(null)).toBeNull()
    expect(parseOptionalNumber('')).toBeNull()
  })

  it('passes through finite numbers', () => {
    expect(parseOptionalNumber(0)).toBe(0)
    expect(parseOptionalNumber(42)).toBe(42)
    expect(parseOptionalNumber(-1.5)).toBe(-1.5)
  })

  it('parses numeric strings', () => {
    expect(parseOptionalNumber('42')).toBe(42)
    expect(parseOptionalNumber('  3.14 ')).toBe(3.14)
  })

  it('returns null for non-finite or non-numeric inputs', () => {
    expect(parseOptionalNumber('abc')).toBeNull()
    expect(parseOptionalNumber(NaN)).toBeNull()
    expect(parseOptionalNumber(Infinity)).toBeNull()
    expect(parseOptionalNumber(-Infinity)).toBeNull()
  })
})

describe('parseExpectedVersion', () => {
  it('accepts positive integers', () => {
    expect(parseExpectedVersion(1)).toBe(1)
    expect(parseExpectedVersion('42')).toBe(42)
  })

  it('returns null for nullish/empty/non-positive', () => {
    expect(parseExpectedVersion(undefined)).toBeNull()
    expect(parseExpectedVersion(null)).toBeNull()
    expect(parseExpectedVersion('')).toBeNull()
    expect(parseExpectedVersion(0)).toBeNull()
    expect(parseExpectedVersion(-1)).toBeNull()
    expect(parseExpectedVersion(1.5)).toBeNull()
    expect(parseExpectedVersion('not a number')).toBeNull()
  })
})

describe('isValidUuid', () => {
  it('accepts canonical v4 UUIDs', () => {
    expect(isValidUuid('123e4567-e89b-42d3-a456-426614174000')).toBe(true)
    expect(isValidUuid('00000000-0000-1000-8000-000000000000')).toBe(true)
  })

  it('rejects non-uuids', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false)
    expect(isValidUuid('123e4567e89b42d3a456426614174000')).toBe(false)
    expect(isValidUuid('123e4567-e89b-72d3-a456-426614174000')).toBe(false) // version > 5
    expect(isValidUuid('')).toBe(false)
    expect(isValidUuid(null)).toBe(false)
    expect(isValidUuid(123)).toBe(false)
  })
})
