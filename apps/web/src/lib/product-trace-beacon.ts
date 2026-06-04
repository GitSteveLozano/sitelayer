// product-trace-beacon.ts — the PUBLIC client beacon (observability T3, browser).
//
// When there is NO operator browser-extension bridge (every real visitor), the
// trace emitter (control-plane-trace.ts) calls beaconTraceEvent(), which batches
// typed flow events and sendBeacon()s them to the SAME-ORIGIN ingest route
// (/api/signal). That route validates each event against the @operator/projectkit
// contract and forwards to whatever subscriber the server is configured with
// (mesh is just one possible SIGNAL_SINK_URL). That's how we observe a session
// that recorded nothing.
//
// SEAM (decoupling): the browser no longer reads a mesh URL. Events are shaped
// as projectkit ProjectEvents and posted same-origin; the subscriber URL +
// secret live server-side only (apps/api/src/routes/signal.ts). No sink URL or
// secret ever touches the client, and the app keeps working when no sink is
// configured (the route no-ops with 204).
//
// OFF BY DEFAULT — the consent + privacy gates are unchanged:
//   1. Consent: localStorage 'sitelayer.trace-consent' === TRACE_CONSENT_VERSION
//      (set via setTraceBeaconConsent() from a consent UI / the T1 toggle).
//   2. Do-Not-Track / Global-Privacy-Control honored → disabled when the user
//      signals opt-out.
// sendBeacon is fire-and-forget (can't read 4xx), so consent is enforced
// client-side here; the server route is a silent-drop backstop. Low-PII by
// construction: route_path is location.pathname (no query); the server route
// templates + redacts further.

import {
  createProjectSignal,
  NullSink,
  type EmitInput,
  type EventDomain,
  type ProjectSignal,
} from '@operator/projectkit'
import { getActiveCaptureSessionId } from './capture-session'
import { resolveCaptureCapabilities } from './capture-capabilities'

export const TRACE_CONSENT_VERSION = '2026-05-29'
const CONSENT_KEY = 'sitelayer.trace-consent'
const SESSION_KEY = 'sitelayer.trace-session'

/** Same-origin ingest route. mesh is no longer a client-visible URL — the
 * server route (apps/api/src/routes/signal.ts) forwards to SIGNAL_SINK_URL. */
const SIGNAL_INGEST_PATH = '/api/signal'

const PROJECT_KEY = 'sitelayer'

type BeaconInput = {
  event_type: string
  event_class: string
  route_path: string
  severity?: string
  payload?: Record<string, unknown>
}

export function beaconUrl(): string {
  // The beacon now posts SAME-ORIGIN; there is no mesh URL to read from the
  // build env. Kept as the capability-ladder's "transport configured" probe
  // (composed by capture-capabilities.ts:defaultBeaconEnabled), which is always
  // true now — so the consent + DNT gates are what actually gate the beacon.
  return SIGNAL_INGEST_PATH
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
    /* storage disabled — treat as no consent */
  }
}

function beaconEnabled(): boolean {
  // Single source of truth for the capability ladder. The resolver composes the
  // same gate (transport available + consent granted + not DNT) from this
  // module's leaf helpers; see capture-capabilities.ts.
  return resolveCaptureCapabilities().beacon
}

function sessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY)
    if (!id) {
      id = crypto?.randomUUID?.() ?? `s_${Date.now()}_${Math.random().toString(36).slice(2)}`
      sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return 's_ephemeral'
  }
}

const FAILURE_EVENT_HINTS = ['error', 'fail', 'failed', 'crash']

// projectkit signal used ONLY to shape + validate the wire envelope (NullSink —
// we control the actual sendBeacon transport below so the pagehide path works).
let signal: ProjectSignal | null = null
function getSignal(): ProjectSignal {
  if (signal) return signal
  signal = createProjectSignal({
    projectKey: PROJECT_KEY,
    sink: new NullSink(),
    defaults: { source_surface: 'web', domain: 'user_action' },
    onError: () => {},
  })
  return signal
}

let buffer: EmitInput[] = []
let seq = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pagehideWired = false

function flush(): void {
  if (buffer.length === 0) return
  const batch = buffer
  buffer = []
  // Build a contract-valid ProjectEventEnvelope, then sendBeacon it. The
  // server route revalidates with validateProjectEvent before forwarding.
  const envelope = getSignal().build(batch)
  const body = JSON.stringify(envelope)
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(SIGNAL_INGEST_PATH, new Blob([body], { type: 'application/json' }))
    } else if (typeof fetch === 'function') {
      void fetch(SIGNAL_INGEST_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {})
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

/** Coarse projectkit domain for a flow event_class. Keeps the contract's domain
 * field meaningful without leaking project internals. */
function mapEventClassToDomain(eventClass: string): EventDomain {
  switch (eventClass) {
    case 'workflow_event':
      return 'workflow_event'
    case 'navigation':
      return 'navigation'
    case 'lifecycle':
      return 'lifecycle'
    default:
      return 'user_action'
  }
}

/**
 * Buffer one typed flow event for the public beacon. No-op unless the beacon is
 * enabled (transport available + consent + not-DNT). Never throws. Called from
 * the trace emitter's no-bridge path.
 */
export function beaconTraceEvent(input: BeaconInput): void {
  if (!beaconEnabled()) return
  try {
    const p = input.payload ?? {}
    const captureSessionId = getActiveCaptureSessionId()
    const stateAfter = String((p.user_state as Record<string, unknown> | undefined)?.state ?? p.state ?? '')
    const errLike =
      FAILURE_EVENT_HINTS.some((h) => input.event_type.toLowerCase().includes(h)) || input.severity === 'error'
    const eventClass = input.event_class || 'user_action'
    const payload: Record<string, unknown> = {
      event_name: input.event_type,
      event_class: eventClass,
      state_after: stateAfter,
      // per-page-load monotonic sequence so the sink can order events
      seq,
    }
    if (captureSessionId) payload.capture_session_id = captureSessionId
    const event: EmitInput = {
      event_type: input.event_type,
      domain: mapEventClassToDomain(eventClass),
      session_id: sessionId(),
      // strip query string — never send raw query (PII surface)
      route_path: (input.route_path || '').split('?')[0] ?? '',
      outcome: errLike ? 'failed' : 'unknown',
      payload,
    }
    if (errLike) event.error_code = input.event_type
    seq += 1
    buffer.push(event)
    if (buffer.length >= 25) flush()
    else scheduleFlush()
  } catch {
    /* never throw into the caller */
  }
}
