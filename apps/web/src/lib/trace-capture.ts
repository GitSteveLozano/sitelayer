// trace-capture.ts — STEP4 of issue-context.
//
// A HEADLESS, PII-safe auto-filer that turns an unhandled client error into a
// `mode="trace"` capture session + finalized work_item, so a crash the user
// never reports still lands in the app-issue triage queue with the diagnostic
// anchors needed to chase it down (workflow event_ref + sentry trace +
// x-request-id).
//
// It is deliberately the thinnest possible producer:
//   - mode="trace" requires NO consent and NO media (no audio/screen/DOM
//     replay). The only payload is structural diagnostics — error name, a
//     truncated message, the route, and the three correlation refs. User text
//     and DOM are never captured here.
//   - It is debounced + capped per page so an error STORM (a render loop firing
//     hundreds of unhandledrejections) files at most a handful of sessions, not
//     one per error.
//   - Every network call is best-effort: a failed create/finalize must never
//     re-throw into the error path that triggered it (that would mask the
//     original crash or loop).
//
// Wired from three client error surfaces (see main.tsx + client.ts):
//   1. the React root error boundary (reportTraceCapture from the fallback),
//   2. window.onunhandledrejection (installTraceCaptureHandlers),
//   3. a 5xx hook inside the API client (reportServer5xx).

import { Sentry } from '@/instrument'
import { createCaptureSession, finalizeCaptureSession } from '@/lib/api/capture-sessions'
import { currentCaptureRoutePath } from '@/lib/capture-session'
import { getBuildSha, nextRequestId } from '@/lib/api/client'
import { readLiveWorkflowAnchor } from '@/lib/live-workflow-anchor'

/** Where the error came from — recorded in the trace payload for triage. */
export type TraceCaptureOrigin = 'error_boundary' | 'unhandledrejection' | 'window_error' | 'api_5xx'

export type TraceCaptureInput = {
  origin: TraceCaptureOrigin
  /** Error constructor name (e.g. "TypeError"), best-effort. */
  errorName?: string
  /** Human message — TRUNCATED + treated as non-PII diagnostic text. */
  message?: string
  /** Sentry event id when the boundary already reported one. */
  sentryEventId?: string
  /** HTTP status for the api_5xx origin. */
  status?: number
  /** API path for the api_5xx origin (path only, never the body). */
  path?: string
  /** API request id for the api_5xx origin (the per-request correlation id). */
  apiRequestId?: string | null
}

// --- storm guards -----------------------------------------------------------
// Per-page caps so a render loop can't spam the triage queue. Module state is
// fine: the SPA is single-page and a reload (e.g. the stale-chunk recovery)
// resets everything, which is the correct behaviour after a deploy.
const MAX_SESSIONS_PER_PAGE = 5
const DEBOUNCE_MS = 4_000
const MESSAGE_MAX_LEN = 280

let filedCount = 0
let lastFiledAtMs = 0
// De-dupe identical errors (same origin+name+message) within the debounce
// window so the SAME crash firing twice in a frame files once.
let lastSignature: string | null = null

function now(): number {
  return Date.now()
}

function signatureOf(input: TraceCaptureInput): string {
  return [input.origin, input.errorName ?? '', input.message ?? '', input.status ?? '', input.path ?? ''].join('|')
}

function truncate(value: string | undefined, max = MESSAGE_MAX_LEN): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** Read the active sentry-trace header, or null when no trace is live. */
function readSentryTrace(): string | null {
  try {
    const data = Sentry.getTraceData?.()
    const value = data?.['sentry-trace']
    return typeof value === 'string' && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

/**
 * Whether this report should be filed given the per-page cap + debounce +
 * dedupe. Pure aside from reading/writing the module guards.
 */
function shouldFile(input: TraceCaptureInput): boolean {
  if (filedCount >= MAX_SESSIONS_PER_PAGE) return false
  const ts = now()
  const signature = signatureOf(input)
  // Same error within the debounce window → drop (the storm case).
  if (signature === lastSignature && ts - lastFiledAtMs < DEBOUNCE_MS) return false
  return true
}

/**
 * File ONE headless trace-mode capture session for a client error. Returns the
 * finalized work_item id (or null when skipped / failed). Always resolves —
 * never throws — so callers on the error path stay safe.
 */
export async function reportTraceCapture(input: TraceCaptureInput): Promise<string | null> {
  if (typeof window === 'undefined') return null
  if (!shouldFile(input)) return null

  // Latch the guards BEFORE the await so a synchronous burst can't slip past
  // the cap while the first create is in flight.
  filedCount += 1
  lastFiledAtMs = now()
  lastSignature = signatureOf(input)

  const requestId = nextRequestId()
  const routePath = currentCaptureRoutePath()
  const anchor = readLiveWorkflowAnchor()
  const sentryTrace = readSentryTrace()
  const buildSha = getBuildSha()

  // Diagnostics only — NO user text, NO media. The metadata is what makes the
  // session traceable: the live workflow anchor, the sentry trace, and the
  // request id all line up with the server-side correlation surfaces.
  const metadata: Record<string, unknown> = {
    surface: 'trace_auto_capture',
    capture_profile: 'trace',
    origin: input.origin,
    route_path: routePath,
    ...(input.errorName ? { error_name: input.errorName } : {}),
    ...(truncate(input.message) ? { error_message: truncate(input.message) } : {}),
    ...(input.sentryEventId ? { sentry_event_id: input.sentryEventId } : {}),
    ...(input.status ? { http_status: input.status } : {}),
    ...(input.path ? { api_path: input.path } : {}),
    ...(input.apiRequestId ? { api_request_id: input.apiRequestId } : {}),
    ...(anchor
      ? { workflow_event_ref: anchor.eventRef, workflow_name: anchor.workflowName, entity_id: anchor.entityId }
      : {}),
    ...(sentryTrace ? { sentry_trace: sentryTrace } : {}),
    ...(buildSha ? { app_build_sha: buildSha } : {}),
    request_id: requestId,
  }

  const captureSessionId = uuid()
  try {
    await createCaptureSession({
      capture_session_id: captureSessionId,
      mode: 'trace',
      route_path: routePath,
      device_kind: inferDeviceKind(),
      platform: readPlatform(),
      viewport: readViewport(),
      ...(buildSha ? { app_build_sha: buildSha } : {}),
      metadata,
      // trace mode is structural-only: no media artifacts, no DOM, no audio.
      consent_scope: { surface: 'trace_auto_capture', streams: [], artifacts: {}, event_classes: ['trace'] },
    })
  } catch {
    // The session never opened — nothing to finalize. Roll back the count so a
    // transient API blip doesn't permanently burn the page budget.
    filedCount = Math.max(0, filedCount - 1)
    return null
  }

  try {
    const finalize = await finalizeCaptureSession(captureSessionId, {
      title: traceTitle(input),
      summary: traceSummary(input, { routePath, anchor: anchor?.eventRef ?? null, requestId }),
      severity: input.status && input.status >= 500 ? 'high' : 'normal',
      lane: 'triage',
      category: 'trace_auto_capture',
      ...(routePath ? { route_path: routePath } : {}),
      client_request_id: `trace_auto:${captureSessionId}`,
    })
    return finalize.work_item.id
  } catch {
    return null
  }
}

function traceTitle(input: TraceCaptureInput): string {
  switch (input.origin) {
    case 'api_5xx':
      return `Auto-filed: API ${input.status ?? '5xx'} on ${input.path ?? 'request'}`
    case 'unhandledrejection':
      return `Auto-filed: unhandled rejection${input.errorName ? ` (${input.errorName})` : ''}`
    case 'window_error':
      return `Auto-filed: uncaught error${input.errorName ? ` (${input.errorName})` : ''}`
    default:
      return `Auto-filed: client error${input.errorName ? ` (${input.errorName})` : ''}`
  }
}

function traceSummary(
  input: TraceCaptureInput,
  refs: { routePath: string; anchor: string | null; requestId: string },
): string {
  const lines: string[] = []
  lines.push('Headless trace-mode capture (no consent / no media; diagnostics only).')
  if (truncate(input.message)) lines.push(`Error: ${truncate(input.message)}`)
  if (refs.routePath) lines.push(`Route: ${refs.routePath}`)
  if (refs.anchor) lines.push(`Workflow anchor: ${refs.anchor}`)
  if (input.apiRequestId) lines.push(`API request id: ${input.apiRequestId}`)
  lines.push(`Capture request id: ${refs.requestId}`)
  return lines.join('\n')
}

// --- global handlers --------------------------------------------------------

let installed = false

/**
 * Install window-level handlers for unhandled promise rejections and uncaught
 * errors. Idempotent. Returns an uninstall function (mostly for tests).
 */
export function installTraceCaptureHandlers(): () => void {
  if (typeof window === 'undefined' || installed) return () => undefined
  installed = true

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason
    const errorName = reason instanceof Error ? reason.name : undefined
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : undefined
    void reportTraceCapture({
      origin: 'unhandledrejection',
      ...(errorName ? { errorName } : {}),
      ...(message ? { message } : {}),
    })
  }
  const onError = (event: ErrorEvent) => {
    const errorName = event.error instanceof Error ? event.error.name : undefined
    const message = event.message || (event.error instanceof Error ? event.error.message : undefined)
    void reportTraceCapture({
      origin: 'window_error',
      ...(errorName ? { errorName } : {}),
      ...(message ? { message } : {}),
    })
  }

  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('error', onError)

  return () => {
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('error', onError)
    installed = false
  }
}

/** 5xx hook for the API client — fire-and-forget. */
export function reportServer5xx(args: {
  status: number
  path: string
  method: string
  requestId: string | null
}): void {
  if (args.status < 500) return
  // Don't recurse on the trace-capture endpoints themselves.
  if (args.path.startsWith('/api/capture-sessions')) return
  void reportTraceCapture({
    origin: 'api_5xx',
    status: args.status,
    path: args.path,
    apiRequestId: args.requestId,
    message: `${args.method} ${args.path} → ${args.status}`,
  })
}

/** Test-only — reset the per-page storm guards. */
export function __resetTraceCaptureForTests(): void {
  filedCount = 0
  lastFiledAtMs = 0
  lastSignature = null
  installed = false
}

// --- small environment readers (mirrors the feedback dock, kept local) ------

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0')
}

function inferDeviceKind(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
}

function readPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  return navigator.platform || 'unknown'
}

function readViewport(): string {
  if (typeof window === 'undefined') return 'unknown'
  return `${window.innerWidth}x${window.innerHeight}`
}
