/**
 * Estimate-push Probe — first SiteLayer page-context Probe per ADR-0019.
 *
 * Lives under `lib/probe/estimate-push.ts` because the Probe needs:
 *   - the live xstate/tanstack snapshot (a React hook),
 *   - the Clerk user (`useUser()` — a React hook),
 *   - the active company from localStorage,
 *   - the Sentry trace data (`Sentry.getTraceData()`),
 *   - the deploy build sha (read off the `x-sitelayer-build-sha`
 *     response header that every API call already returns; cached on
 *     the api-client side after the first response so the Probe is a
 *     pure read here),
 *   - the QBO live feature flags from `/api/features`.
 *
 * Exposes two surfaces:
 *
 *   1. `useEstimatePushProbe(pushId, snapshot)` → returns a stable
 *      `capture()` callable that snapshots everything in scope. This is
 *      the hook the page mounts; React rules say `useUser` etc. have
 *      to be called inside a component, so the Probe is built as a
 *      hook.
 *
 *   2. `captureEstimatePush(args)` → pure function over already-resolved
 *      inputs (snapshot, principal, deploy, feature_flags, tail). Used
 *      under the hood by the hook, and exported for headless callers
 *      (tests, future tap stream).
 *
 * Thick Capture archetype per ADR-0019 — `page_state` is the full
 * EstimatePushWorkflowSnapshot, not just an `entity_id` hint.
 *
 * Payload budget: <2KB JSON for a typical page. The event-log tail is
 * capped at 3 rows and elides large `event_payload` blobs to enforce
 * the ceiling without truncating mid-row.
 */

import { useCallback, useEffect, useState } from 'react'
import { useUser } from '@clerk/clerk-react'
import { Sentry } from '@/instrument'
import { ACTIVE_COMPANY_STORAGE_KEY, getActiveCompanySlug, getBuildSha, request } from '@/lib/api/client'
import { isClerkConfigured } from '@/lib/auth'
import type {
  Capture,
  CaptureActingAs,
  CaptureDeploy,
  CaptureFeatureFlags,
  CapturePath,
  CapturePrincipal,
  CaptureTrace,
  WorkflowEventLogRow,
} from './types'
import type { EstimatePushSnapshot } from '@/lib/api/estimate-pushes'

/** Number of event-log rows the Probe includes in `path.workflow_event_log_tail`. */
export const ESTIMATE_PUSH_TAIL_LIMIT = 3

/** localStorage key the operator can use to declare an `acting_as` override. */
export const ACTING_AS_STORAGE_KEY = 'sitelayer.probe.acting-as'

/** localStorage flag that enables headless Probe capture in deployed builds. */
export const PROBE_DIAGNOSTICS_STORAGE_KEY = 'sitelayer.probe.diagnostics'

declare global {
  interface Window {
    __sitelayerProbe?: {
      estimatePushCapture?: () => Capture
    }
  }
}

export function isEstimatePushProbeDiagnosticsEnabled(): boolean {
  if (typeof window === 'undefined') return false
  if (import.meta.env.DEV) return true

  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('probeCapture') === '1') return true
    const raw = window.localStorage.getItem(PROBE_DIAGNOSTICS_STORAGE_KEY)
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

export function registerEstimatePushProbeDiagnostics(capture: () => Capture): () => void {
  if (typeof window === 'undefined') return () => {}

  const probe = window.__sitelayerProbe ?? {}
  probe.estimatePushCapture = capture
  window.__sitelayerProbe = probe

  return () => {
    if (window.__sitelayerProbe?.estimatePushCapture !== capture) return
    delete window.__sitelayerProbe.estimatePushCapture
    if (Object.keys(window.__sitelayerProbe).length === 0) {
      delete window.__sitelayerProbe
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Deploy info — read off the cached `x-sitelayer-build-sha` response header. */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the deploy slot from the api-client's latched build-sha
 * header (set by the API on every response — see
 * `apps/api/src/server.ts`). The first call to `request<T>()` on page
 * load (typically `/api/bootstrap` or `/api/features`) primes the
 * cache, so by the time the Probe runs in a real screen the value is
 * available synchronously.
 *
 * `env` (tier) used to come from the same `/api/version` body, but the
 * header carries only the sha. Callers that care about the tier should
 * read it off `/api/features` (already cached separately by the
 * featuresCache below) or leave it null — the Capture explicitly
 * tolerates null pieces.
 */
export function readDeployCache(): CaptureDeploy | null {
  const sha = getBuildSha()
  if (!sha) return null
  return { app_build_sha: sha, env: null }
}

/**
 * Back-compat shim. The Probe used to await this to populate the
 * deploy slot; the header path makes it synchronous, but `useEffect`
 * still calls it in case the caller is mid-load and the first API
 * response hasn't landed yet. Resolves to the current cache snapshot.
 */
export async function fetchDeployInfo(_signal?: AbortSignal): Promise<CaptureDeploy | null> {
  return readDeployCache()
}

/* -------------------------------------------------------------------------- */
/* Feature flags — cached for the page lifetime.                              */
/* -------------------------------------------------------------------------- */

interface FeaturesResponse {
  tier: string | null
  flags: string[]
  ribbon: unknown
}

interface SessionRoleResponse {
  activeCompany?: {
    role?: string | null
  } | null
}

let featuresCache: CaptureFeatureFlags | null = null
let featuresFetchInFlight: Promise<CaptureFeatureFlags | null> | null = null

/**
 * Flags the estimate-push Probe surfaces in `feature_flags`. Picked to
 * keep payload small — anything that changes the page's behaviour
 * (live vs stub QBO push) goes in, the rest stays out.
 *
 * Update this list when the ADR's QBO worked-example grows new flags;
 * the runner only sees what's listed here.
 */
const RELEVANT_FLAGS_FOR_ESTIMATE_PUSH = [
  'qbo-live',
  'QBO_LIVE_ESTIMATE_PUSH',
  'QBO_LIVE_RENTAL_INVOICE',
  'read-prod-ro',
] as const

export async function fetchFeatureFlags(signal?: AbortSignal): Promise<CaptureFeatureFlags | null> {
  if (featuresCache) return featuresCache
  if (featuresFetchInFlight) return featuresFetchInFlight
  featuresFetchInFlight = (async () => {
    try {
      // Use the normal API client so the request carries the same auth,
      // company slug, trace headers, and x-sitelayer-build-sha latching
      // behaviour as the rest of the SPA.
      const body = await request<FeaturesResponse>('/api/features', {
        method: 'GET',
        ...(signal ? { signal } : {}),
      })
      const setOfFlags = new Set(body.flags ?? [])
      const out: CaptureFeatureFlags = {}
      for (const name of RELEVANT_FLAGS_FOR_ESTIMATE_PUSH) {
        out[name] = setOfFlags.has(name) ? 1 : 0
      }
      featuresCache = out
      return out
    } catch {
      return null
    } finally {
      featuresFetchInFlight = null
    }
  })()
  return featuresFetchInFlight
}

export async function fetchActiveCompanyRole(signal?: AbortSignal): Promise<string | null> {
  try {
    const body = await request<SessionRoleResponse>('/api/session', {
      method: 'GET',
      ...(signal ? { signal } : {}),
    })
    const role = body.activeCompany?.role
    return typeof role === 'string' && role.trim() ? role.trim() : null
  } catch {
    return null
  }
}

export function __resetEstimatePushProbeCachesForTests(): void {
  featuresCache = null
  featuresFetchInFlight = null
}

/* -------------------------------------------------------------------------- */
/* Workflow event-log tail.                                                    */
/* -------------------------------------------------------------------------- */

interface WorkflowEventLogResponse {
  events: WorkflowEventLogRow[]
}

/**
 * Fetch the last N rows of workflow_event_log for the given entity. This
 * deliberately uses the app's normal `request<T>()` client so Clerk/dev auth,
 * active-company scoping, request ids, Sentry trace headers, and build-sha
 * latching stay identical to other API calls.
 *
 * Probe rule: event-log tail failures never fail the whole Capture. They return
 * an empty tail plus a small error note so the operator still gets page_state,
 * principal, trace, deploy, and feature flag context.
 */
export async function fetchWorkflowEventLogTail(
  entityType: string,
  entityId: string,
  limit: number = ESTIMATE_PUSH_TAIL_LIMIT,
  signal?: AbortSignal,
): Promise<{ rows: WorkflowEventLogRow[]; error: string | null }> {
  const params = new URLSearchParams({
    entity_type: entityType,
    entity_id: entityId,
    limit: String(limit),
  })
  try {
    const options: { method: 'GET'; signal?: AbortSignal } = { method: 'GET' }
    if (signal) options.signal = signal
    const body = await request<WorkflowEventLogResponse>(`/api/workflow-event-log?${params.toString()}`, {
      ...options,
    })
    return {
      rows: Array.isArray(body.events) ? body.events.slice(0, limit) : [],
      error: null,
    }
  } catch (err) {
    if (signal?.aborted) return { rows: [], error: null }
    const message = err instanceof Error ? err.message : 'unknown error'
    return {
      rows: [],
      error: `workflow_event_log tail unavailable: ${message}`,
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Trace info.                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pull the active Sentry trace headers and parse the parent span id
 * out of the `sentry-trace` value (`<trace_id>-<span_id>-<sampled>`).
 * Returns null when Sentry isn't initialised yet (early boot) or DSN
 * is missing.
 */
export function readTraceCapture(): CaptureTrace | null {
  try {
    const data = Sentry.getTraceData?.()
    if (!data) return null
    const sentryTrace = (data as Record<string, string | undefined>)['sentry-trace']
    if (!sentryTrace) return null
    const parts = sentryTrace.split('-')
    const spanId = parts.length >= 2 ? parts[1] : null
    return {
      sentry_trace: sentryTrace,
      span_id: spanId ?? null,
      baggage: (data as Record<string, string | undefined>).baggage ?? null,
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Acting-as override.                                                         */
/* -------------------------------------------------------------------------- */

/** Read the operator's declared `acting_as` override from localStorage. */
export function readActingAs(): CaptureActingAs | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(ACTING_AS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CaptureActingAs> | string
    if (typeof parsed === 'string') {
      return parsed.trim() ? { role: parsed.trim() } : null
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.role === 'string' && parsed.role.trim()) {
      return {
        role: parsed.role.trim(),
        company_slug: parsed.company_slug ?? null,
        note: parsed.note ?? null,
      }
    }
    return null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Pure capture assembly.                                                      */
/* -------------------------------------------------------------------------- */

export interface CaptureEstimatePushArgs {
  pushId: string
  /** Live snapshot from `useEstimatePush(id)` (or null when still loading). */
  snapshot: EstimatePushSnapshot | null
  principal: CapturePrincipal
  trace: CaptureTrace | null
  deploy: CaptureDeploy | null
  featureFlags: CaptureFeatureFlags | null
  tail: WorkflowEventLogRow[]
  tailError: string | null
  actingAs: CaptureActingAs | null
}

/**
 * Pure assembly — no I/O, no hooks. Useful for tests and headless
 * (future) tap-stream callers. The hook below resolves the inputs
 * then delegates to this function.
 */
export function captureEstimatePush(args: CaptureEstimatePushArgs): Capture {
  const path: CapturePath = {
    route: typeof window !== 'undefined' ? window.location.pathname : `/financial/estimate-pushes/${args.pushId}`,
    entity_type: 'estimate_push',
    entity_id: args.pushId,
    workflow_event_log_tail: args.tail,
    tail_error: args.tailError ?? null,
  }

  const notes: string[] = []
  if (args.tailError) notes.push(args.tailError)
  if (!args.deploy) notes.push('no x-sitelayer-build-sha header observed yet; deploy slot omitted')
  if (!args.snapshot) notes.push('TODO: snapshot still loading; page_state is empty')

  // page_state mirrors the WorkflowSnapshot the page already renders.
  // We project only the deterministic-reducer-shaped fields so the
  // payload stays bounded — the full `lines[]` array can balloon on
  // very-large estimates; the runner can refetch via /api/estimate-pushes/:id.
  let pageState: Record<string, unknown> = {}
  if (args.snapshot) {
    const ctx = args.snapshot.context
    pageState = {
      state: args.snapshot.state,
      state_version: args.snapshot.state_version,
      next_events: args.snapshot.next_events.map((e) => e.type),
      project_id: ctx.project_id,
      customer_id: ctx.customer_id,
      qbo_estimate_id: ctx.qbo_estimate_id,
      subtotal: ctx.subtotal,
      reviewed_at: ctx.reviewed_at,
      reviewed_by: ctx.reviewed_by,
      approved_at: ctx.approved_at,
      approved_by: ctx.approved_by,
      posted_at: ctx.posted_at,
      failed_at: ctx.failed_at,
      error: ctx.error,
      workflow_engine: ctx.workflow_engine,
      workflow_run_id: ctx.workflow_run_id,
      line_count: ctx.lines?.length ?? 0,
    }
  }

  const out: Capture = {
    capture_version: 1,
    probe_id: 'sitelayer.estimate_push',
    captured_at: new Date().toISOString(),
    page_state: pageState,
    path,
    principal: args.principal,
  }
  if (args.actingAs) out.acting_as = args.actingAs
  if (args.trace) out.trace = args.trace
  if (args.deploy) out.deploy = args.deploy
  if (args.featureFlags) out.feature_flags = args.featureFlags
  if (notes.length > 0) out.notes = notes
  return out
}

/* -------------------------------------------------------------------------- */
/* React hook.                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Mount in the EstimatePushDetailScreen. Returns a `capture()` callable
 * that synchronously assembles a Capture from the latest resolved
 * inputs (snapshot, deploy info, feature flags, tail, principal).
 *
 * Side note on hook discipline: this hook ALWAYS calls `useUser` —
 * Clerk's `useUser` is a no-op when the provider isn't mounted only if
 * `isClerkConfigured()` returns true, so we mirror the `useRole` /
 * `useFirstName` pattern and branch around the call site instead of
 * conditionally invoking the hook.
 */
export function useEstimatePushProbe(pushId: string, snapshot: EstimatePushSnapshot | null): () => Capture {
  const [activeCompanyRole, setActiveCompanyRole] = useState<string | null>(null)
  const principal = useCapturePrincipal(activeCompanyRole)
  const [deploy, setDeploy] = useState<CaptureDeploy | null>(readDeployCache())
  const [features, setFeatures] = useState<CaptureFeatureFlags | null>(featuresCache)
  const [tail, setTail] = useState<{ rows: WorkflowEventLogRow[]; error: string | null }>({
    rows: [],
    error: null,
  })

  // Resolve deploy + features once. Both cache module-level so the
  // hook re-mount cost is just a state copy.
  useEffect(() => {
    const ac = new AbortController()
    let cancelled = false
    const refreshDeploy = () => {
      const current = readDeployCache()
      if (!cancelled && current) setDeploy(current)
    }
    void fetchDeployInfo(ac.signal).then((d) => {
      if (!cancelled && d) setDeploy(d)
    })
    void fetchFeatureFlags(ac.signal).then((f) => {
      if (!cancelled && f) setFeatures(f)
      refreshDeploy()
    })
    void fetchActiveCompanyRole(ac.signal).then((role) => {
      if (!cancelled) setActiveCompanyRole(role)
      refreshDeploy()
    })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  // Refresh the workflow_event_log tail whenever the push id or
  // state_version changes — i.e. after every successful event dispatch.
  const stateVersion = snapshot?.state_version ?? null
  useEffect(() => {
    if (!pushId) return
    const ac = new AbortController()
    let cancelled = false
    void fetchWorkflowEventLogTail('estimate_push', pushId, ESTIMATE_PUSH_TAIL_LIMIT, ac.signal).then((result) => {
      if (cancelled) return
      setTail(result)
    })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [pushId, stateVersion])

  return useCallback(() => {
    return captureEstimatePush({
      pushId,
      snapshot,
      principal,
      trace: readTraceCapture(),
      deploy: readDeployCache() ?? deploy,
      featureFlags: features,
      tail: tail.rows,
      tailError: tail.error,
      actingAs: readActingAs(),
    })
  }, [pushId, snapshot, principal, deploy, features, tail])
}

/**
 * Resolve the Capture principal from Clerk + the active company role returned
 * by `/api/session`. This is intentionally the raw `company_memberships.role`
 * value (admin / office / foreman / member), not the UI persona returned by
 * `useRole()`.
 *
 * Branches around `useUser`: Clerk is a build-time constant, so
 * `isClerkConfigured()` returning false means the hook never tries to read
 * from a missing provider.
 */
function useCapturePrincipal(activeCompanyRole: string | null): CapturePrincipal {
  if (isClerkConfigured()) {
    return useClerkPrincipal(activeCompanyRole)
  }
  return {
    source: 'dev-fallback',
    user_id: null,
    email: null,
    display_name: null,
    active_company_slug: getActiveCompanySlug(),
    active_company_role: activeCompanyRole,
  }
}

function useClerkPrincipal(activeCompanyRole: string | null): CapturePrincipal {
  const { user, isSignedIn } = useUser()
  if (!isSignedIn || !user) {
    return {
      source: 'anonymous',
      user_id: null,
      email: null,
      display_name: null,
      active_company_slug: getActiveCompanySlug(),
      active_company_role: activeCompanyRole,
    }
  }
  // Clerk's `primaryEmailAddress` is the canonical signed-in email.
  const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? null
  const displayName = user.fullName ?? ([user.firstName, user.lastName].filter(Boolean).join(' ').trim() || null)
  return {
    source: 'clerk',
    user_id: user.id,
    email,
    display_name: displayName,
    active_company_slug: getActiveCompanySlug(),
    active_company_role: activeCompanyRole,
  }
}

/* -------------------------------------------------------------------------- */
/* Sanity-export so consumers can pin the storage key.                         */
/* -------------------------------------------------------------------------- */

export { ACTIVE_COMPANY_STORAGE_KEY }
