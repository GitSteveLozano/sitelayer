import { describe, expect, it } from 'vitest'
import { ELEVATION_TAGS, prettyElevation, readElevation } from './elevation'

describe('readElevation', () => {
  it('reads the persisted elevation column (case-insensitive)', () => {
    expect(readElevation({ elevation: 'North', notes: null })).toBe('north')
    expect(readElevation({ elevation: 'roof', notes: null })).toBe('roof')
  })

  it('maps an unknown stored value to "other"', () => {
    expect(readElevation({ elevation: 'penthouse', notes: null })).toBe('other')
  })

  it('falls back to a legacy elev: notes prefix', () => {
    expect(readElevation({ elevation: null, notes: 'elev:west framing' })).toBe('west')
    expect(readElevation({ elevation: null, notes: 'elev:bogus' })).toBe('other')
  })

  it('returns "none" when untagged', () => {
    expect(readElevation({ elevation: null, notes: null })).toBe('none')
    expect(readElevation({ elevation: null, notes: 'just a note' })).toBe('none')
  })
})

describe('prettyElevation', () => {
  it('labels every tag', () => {
    expect(prettyElevation('north')).toBe('North elevation')
    expect(prettyElevation('roof')).toBe('Roof')
    expect(prettyElevation('other')).toBe('Other')
    expect(prettyElevation('none')).toBe('Untagged')
  })

  it('covers all tags without throwing', () => {
    for (const t of ELEVATION_TAGS) expect(typeof prettyElevation(t)).toBe('string')
  })
})
