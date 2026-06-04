import { afterEach, describe, expect, it } from 'vitest'
import { dntOptOut, setTraceBeaconConsent, traceBeaconConsentGranted } from './product-trace-consent'

describe('product trace consent', () => {
  const originalDoNotTrack = navigator.doNotTrack

  afterEach(() => {
    localStorage.clear()
    Object.defineProperty(navigator, 'doNotTrack', {
      configurable: true,
      value: originalDoNotTrack,
    })
    Object.defineProperty(navigator, 'globalPrivacyControl', {
      configurable: true,
      value: undefined,
    })
  })

  it('stores and clears the trace consent grant', () => {
    expect(traceBeaconConsentGranted()).toBe(false)

    setTraceBeaconConsent(true)
    expect(traceBeaconConsentGranted()).toBe(true)

    setTraceBeaconConsent(false)
    expect(traceBeaconConsentGranted()).toBe(false)
  })

  it('honors browser privacy opt-outs', () => {
    Object.defineProperty(navigator, 'doNotTrack', {
      configurable: true,
      value: '1',
    })
    expect(dntOptOut()).toBe(true)

    Object.defineProperty(navigator, 'doNotTrack', {
      configurable: true,
      value: '0',
    })
    Object.defineProperty(navigator, 'globalPrivacyControl', {
      configurable: true,
      value: true,
    })
    expect(dntOptOut()).toBe(true)
  })
})
