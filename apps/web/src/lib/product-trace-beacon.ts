// product-trace-beacon.ts — the PUBLIC client beacon (observability T3, browser).
//
// When there is NO operator browser-extension bridge (every real visitor), the
// trace emitter (control-plane-trace.ts) calls beaconTraceEvent(), which batches
// typed flow events and sendBeacon()s them to the gateway public route
// (/api/product-trace-ingress/:site → mesh). That's how we observe a session that
// recorded nothing.
//
// OFF BY DEFAULT — three independent gates, all must pass:
//   1. VITE_TRACE_BEACON_URL must be set at build time (else disabled).
//   2. Consent: localStorage 'sitelayer.trace-consent' === TRACE_CONSENT_VERSION
//      (set via setTraceBeaconConsent() from a consent UI / the T1 toggle).
//   3. Do-Not-Track / Global-Privacy-Control honored → disabled when the user
//      signals opt-out.
// sendBeacon is fire-and-forget (can't read 4xx), so consent is enforced
// client-side here; the gateway is a silent-drop backstop. Low-PII by
// construction: route is location.pathname (no query); the gateway templates +
// redacts further.

export const TRACE_CONSENT_VERSION = '2026-05-29'
const CONSENT_KEY = 'sitelayer.trace-consent'
const SESSION_KEY = 'sitelayer.trace-session'

type BeaconInput = {
  event_type: string
  event_class: string
  route_path: string
  severity?: string
  payload?: Record<string, unknown>
}

type BeaconEvent = {
  session_id: string
  seq: number
  event_class: string
  route_path: string
  state_after: string
  outcome: string
  error_code: string
  occurred_at: string
  payload: Record<string, unknown>
}

function beaconUrl(): string {
  try {
    return String((import.meta as { env?: Record<string, string> }).env?.VITE_TRACE_BEACON_URL || '').trim()
  } catch {
    return ''
  }
}

function dntOptOut(): boolean {
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
    /* storage disabled — treat as no consent */
  }
}

function beaconEnabled(): boolean {
  return Boolean(beaconUrl()) && !dntOptOut() && traceBeaconConsentGranted()
}

function sessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY)
    if (!id) {
      id = (crypto?.randomUUID?.() ?? `s_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return 's_ephemeral'
  }
}

const FAILURE_EVENT_HINTS = ['error', 'fail', 'failed', 'crash']

let buffer: BeaconEvent[] = []
let seq = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pagehideWired = false

function flush(): void {
  if (buffer.length === 0) return
  const url = beaconUrl()
  if (!url) {
    buffer = []
    return
  }
  const batch = buffer
  buffer = []
  const body = JSON.stringify({ events: batch })
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
    } else if (typeof fetch === 'function') {
      void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {})
    }
  } catch {
    /* never throw into the caller */
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, 4000)
  if (typeof flushTimer === 'object' && typeof (flushTimer as { unref?: () => void }).unref === 'function') {
    ;(flushTimer as { unref?: () => void }).unref?.()
  }
  if (!pagehideWired && typeof window !== 'undefined') {
    pagehideWired = true
    window.addEventListener('pagehide', flush)
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }
}

/**
 * Buffer one typed flow event for the public beacon. No-op unless the beacon is
 * enabled (URL + consent + not-DNT). Never throws. Called from the trace
 * emitter's no-bridge path.
 */
export function beaconTraceEvent(input: BeaconInput): void {
  if (!beaconEnabled()) return
  try {
    const p = input.payload ?? {}
    const stateAfter = String((p.user_state as Record<string, unknown> | undefined)?.state ?? p.state ?? '')
    const errLike = FAILURE_EVENT_HINTS.some((h) => input.event_type.toLowerCase().includes(h)) || input.severity === 'error'
    buffer.push({
      session_id: sessionId(),
      seq: seq++,
      event_class: input.event_class || 'user_action',
      // strip query string — never send raw query (PII surface)
      route_path: (input.route_path || '').split('?')[0] ?? '',
      state_after: stateAfter,
      outcome: errLike ? 'failed' : '',
      error_code: errLike ? input.event_type : '',
      occurred_at: new Date().toISOString(),
      payload: { event_name: input.event_type },
    })
    if (buffer.length >= 25) flush()
    else scheduleFlush()
  } catch {
    /* never throw into the caller */
  }
}
