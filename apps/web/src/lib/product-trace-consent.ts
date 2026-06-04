export const TRACE_CONSENT_VERSION = '2026-05-29'

const CONSENT_KEY = 'sitelayer.trace-consent'

export function beaconUrl(): string {
  try {
    return String((import.meta as { env?: Record<string, string> }).env?.VITE_TRACE_BEACON_URL || '').trim()
  } catch {
    return ''
  }
}

export function dntOptOut(): boolean {
  if (typeof navigator === 'undefined') return true
  const nav = navigator as unknown as { doNotTrack?: string; globalPrivacyControl?: boolean }
  if (nav.globalPrivacyControl === true) return true
  if (nav.doNotTrack === '1' || nav.doNotTrack === 'yes') return true
  return false
}

export function traceBeaconConsentGranted(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(CONSENT_KEY) === TRACE_CONSENT_VERSION
  } catch {
    return false
  }
}

export function setTraceBeaconConsent(accepted: boolean): void {
  try {
    if (accepted) localStorage.setItem(CONSENT_KEY, TRACE_CONSENT_VERSION)
    else localStorage.removeItem(CONSENT_KEY)
  } catch {
    /* storage disabled - treat as no consent */
  }
}

export function traceBeaconEnabled(): boolean {
  return Boolean(beaconUrl()) && !dntOptOut() && traceBeaconConsentGranted()
}
