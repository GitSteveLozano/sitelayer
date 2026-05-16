import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  readActivePricingProfileId,
  writeActivePricingProfileId,
  useActivePricingProfileId,
} from './active-pricing-profile'

const SLUG = 'la-operations'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('active-pricing-profile storage', () => {
  it('returns null when nothing is pinned', () => {
    expect(readActivePricingProfileId(SLUG)).toBeNull()
  })

  it('round-trips a pinned id', () => {
    writeActivePricingProfileId(SLUG, 'profile-1')
    expect(readActivePricingProfileId(SLUG)).toBe('profile-1')
  })

  it('clears the pin when given null', () => {
    writeActivePricingProfileId(SLUG, 'profile-1')
    writeActivePricingProfileId(SLUG, null)
    expect(readActivePricingProfileId(SLUG)).toBeNull()
  })

  it('keeps pins per-company-slug isolated', () => {
    writeActivePricingProfileId('alpha', 'a-1')
    writeActivePricingProfileId('bravo', 'b-1')
    expect(readActivePricingProfileId('alpha')).toBe('a-1')
    expect(readActivePricingProfileId('bravo')).toBe('b-1')
  })

  it('returns null for an empty company slug', () => {
    writeActivePricingProfileId('', 'x')
    expect(readActivePricingProfileId('')).toBeNull()
  })
})

describe('useActivePricingProfileId', () => {
  it('exposes the current value and a setter', () => {
    const { result } = renderHook(() => useActivePricingProfileId(SLUG))
    expect(result.current[0]).toBeNull()
    act(() => result.current[1]('profile-7'))
    expect(result.current[0]).toBe('profile-7')
    expect(readActivePricingProfileId(SLUG)).toBe('profile-7')
  })

  it('reacts to a same-tab cross-component write via the custom event', () => {
    const { result } = renderHook(() => useActivePricingProfileId(SLUG))
    act(() => {
      writeActivePricingProfileId(SLUG, 'profile-9')
    })
    expect(result.current[0]).toBe('profile-9')
  })
})
