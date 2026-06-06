import type http from 'node:http'
import type { Pool } from 'pg'
import type { AppTier } from '@sitelayer/config'
import { createLogger } from '@sitelayer/logger'
import type { ActiveCompany } from '../auth-types.js'
import { authorizeDebugTraceRequest } from '../debug-trace.js'
import { withCompanyClient } from '../mutation-tx.js'
import {
  loadEntityBracket,
  replayView,
  resolveAnchor,
  type ResolvedAnchor,
  type ResolvedAnchorCapture,
} from '../anchor-resolve.js'

const logger = createLogger('api:anchors')

/**
 * Statechart-anchor lookup surface — step 5 of the follow-ons.
 *
 *   GET /api/anchors/:eventRef            (single anchor)
 *   GET /api/anchors/:eventRef?to=<ref>   (from/to anchor pair → clip/still range)
 *
 * Given the one-string transition anchor a frontend trace + the server
 * forwarder both stamp (`workflow_event:<name>:<digest>:<version>`), resolve:
 *   - the workflow_event_log row(s) that transition produced,
 *   - the linked capture_session + its durable artifacts,
 *   - the recorder timeline mark(s) (capture_session_events with the event_ref
 *     in payload — written by the frontend on each commit, step 3),
 *   - the sentry_trace stamped on the event-log row, and
 *   - the deterministic replay.ts result over the entity's full event bracket
 *     (applyEventLog re-runs the reducer and reports the first divergence).
 *
 * With a `to` anchor on the SAME workflow+entity, also resolve the audio/screen
 * artifact SUB-RANGE between the two recorder marks (a clip) — or, when from ==
 * to, a single mark frame (a still). This is a read-only RANGE-SELECTION wrapper
 * over the existing capture artifacts + rrweb replay player, NOT a new capture
 * pipeline.
 *
 * Auth: this is the incident-tracking surface, so it is gated like
 * /api/debug/traces/:id — Bearer DEBUG_TRACE_TOKEN, prod-gated unless
 * DEBUG_ALLOW_PROD=1. It also runs after the standard active-company resolution
 * and reads strictly company-scoped via withCompanyClient.
 */

export type AnchorRouteCtx = {
  pool: Pool
  company: ActiveCompany
  tier: AppTier
  requestId: string
  req: http.IncomingMessage
  url: URL
  sendJson: (status: number, body: unknown) => void
  setHeader: (name: string, value: string) => void
}

function captureSessionView(capture: ResolvedAnchorCapture | null) {
  if (!capture) return null
  return {
    id: capture.session.id,
    mode: capture.session.mode,
    status: capture.session.status,
    route_path: capture.session.route_path,
    started_at: capture.session.started_at,
    last_seen_at: capture.session.last_seen_at,
    stopped_at: capture.session.stopped_at,
    artifacts: capture.artifacts.map((row) => ({
      id: row.id,
      kind: row.kind,
      content_type: row.content_type,
      byte_size: row.byte_size,
      duration_ms: row.duration_ms,
      pii_level: row.pii_level,
      access_policy: row.access_policy,
      created_at: row.created_at,
      // The authed file route the existing rrweb replay player + media panel use.
      file_url: `/api/capture-sessions/${capture.session_id}/artifacts/${row.id}/file`,
    })),
  }
}

/**
 * Compute the clip/still artifact sub-range between two marks on the same
 * workflow+entity. Read-only range selection: it returns the occurred_at window
 * and the media artifacts that fall on the recorded session(s), leaving the
 * actual frame extraction to the existing rrweb replay player which already
 * seeks by timestamp.
 */
function buildRange(
  from: ResolvedAnchor,
  to: ResolvedAnchor,
  fromCapture: ReturnType<typeof captureSessionView>,
  toCapture: ReturnType<typeof captureSessionView>,
) {
  const fromMark = from.marks[0] ?? null
  const toMark = to.marks[0] ?? null
  const fromAt = fromMark?.occurred_at ?? from.applied_at
  const toAt = toMark?.occurred_at ?? to.applied_at
  const fromMs = Date.parse(fromAt)
  const toMs = Date.parse(toAt)
  const ordered = Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs <= toMs
  const startAt = ordered ? fromAt : toAt
  const endAt = ordered ? toAt : fromAt
  const isStill = from.event_ref === to.event_ref
  const sameSession = from.capture_session_id !== null && from.capture_session_id === to.capture_session_id
  // Media artifacts (audio / screen video / rrweb) the range plays over. Use the
  // from-anchor's session when both marks share it, else surface both.
  const mediaKinds = new Set(['audio', 'video', 'rrweb', 'repro_bracket'])
  const sessionForMedia = sameSession ? fromCapture : (fromCapture ?? toCapture)
  const media = (sessionForMedia?.artifacts ?? []).filter((a) => mediaKinds.has(a.kind))
  return {
    kind: isStill ? 'still' : 'clip',
    same_session: sameSession,
    duration_ms: ordered ? Math.max(0, toMs - fromMs) : null,
    start_at: startAt,
    end_at: endAt,
    from: { event_ref: from.event_ref, occurred_at: fromAt, has_mark: Boolean(fromMark) },
    to: { event_ref: to.event_ref, occurred_at: toAt, has_mark: Boolean(toMark) },
    capture_session_id: sameSession ? from.capture_session_id : null,
    media_artifacts: media,
  }
}

function anchorIdFromPath(pathname: string): string | null {
  const prefix = '/api/anchors/'
  if (!pathname.startsWith(prefix)) return null
  const raw = pathname.slice(prefix.length)
  if (!raw || raw.includes('/')) return null
  return decodeURIComponent(raw)
}

export async function handleAnchorRoutes(ctx: AnchorRouteCtx): Promise<boolean> {
  const { req, url, requestId, sendJson, company, tier } = ctx
  if (req.method !== 'GET' || !url.pathname.startsWith('/api/anchors/')) {
    return false
  }

  // Incident-tracking surface — gated exactly like /api/debug/traces/:id.
  const authResult = authorizeDebugTraceRequest({
    debugToken: process.env.DEBUG_TRACE_TOKEN,
    tier,
    allowProd: process.env.DEBUG_ALLOW_PROD,
    authorizationHeader: req.headers['authorization'],
    requestId,
  })
  if (!authResult.ok) {
    if (authResult.authenticate) {
      ctx.setHeader('www-authenticate', 'Bearer realm="sitelayer-debug"')
    }
    sendJson(authResult.status, authResult.body)
    return true
  }

  const fromRef = anchorIdFromPath(url.pathname)
  if (!fromRef) {
    sendJson(400, { error: 'invalid anchor', request_id: requestId })
    return true
  }
  const toRefRaw = url.searchParams.get('to')
  const toRef = toRefRaw ? toRefRaw.trim() : null

  logger.info({ scope: 'anchor_lookup', from: fromRef, to: toRef }, 'anchor lookup')

  try {
    // Run the company-scoped reads inside one read-only tx (binds
    // app.company_id for RLS), then project + replay outside it. The shared
    // anchor-resolve helpers take the bound client so the same logic also runs
    // in-process inside the capture-session finalize mutation tx.
    const resolved = await withCompanyClient(company.id, async (c) => {
      const fromResolved = await resolveAnchor(c, company.id, fromRef)
      if (!fromResolved.ok) return { fromResolved, fromBracket: null, toResolved: null }
      const fromBracket = await loadEntityBracket(
        c,
        company.id,
        fromResolved.row.workflow_name,
        fromResolved.row.entity_type,
        fromResolved.row.entity_id,
      )
      const toResolved = toRef ? await resolveAnchor(c, company.id, toRef) : null
      return { fromResolved, fromBracket, toResolved }
    })

    const { fromResolved, fromBracket } = resolved
    if (!fromResolved.ok) {
      sendJson(fromResolved.status, { error: fromResolved.error, request_id: requestId })
      return true
    }

    // Single-anchor lookup.
    if (!toRef) {
      sendJson(200, {
        request_id: requestId,
        anchor: fromResolved.anchor,
        capture_session: captureSessionView(fromResolved.capture),
        replay: replayView(fromBracket!),
      })
      return true
    }

    // From/to pair → resolve the second anchor and the clip/still range.
    const toResolved = resolved.toResolved!
    if (!toResolved.ok) {
      sendJson(toResolved.status, { error: `to: ${toResolved.error}`, request_id: requestId })
      return true
    }

    const sameStream =
      fromResolved.row.workflow_name === toResolved.row.workflow_name &&
      fromResolved.row.entity_type === toResolved.row.entity_type &&
      fromResolved.row.entity_id === toResolved.row.entity_id
    if (!sameStream) {
      sendJson(409, {
        error: 'from and to anchors must be on the same workflow + entity',
        request_id: requestId,
      })
      return true
    }

    const fromCaptureView = captureSessionView(fromResolved.capture)
    const toCaptureView = captureSessionView(toResolved.capture)
    sendJson(200, {
      request_id: requestId,
      from: fromResolved.anchor,
      to: toResolved.anchor,
      from_capture_session: fromCaptureView,
      to_capture_session: toCaptureView,
      range: buildRange(fromResolved.anchor, toResolved.anchor, fromCaptureView, toCaptureView),
      replay: replayView(fromBracket!),
    })
    return true
  } catch (err) {
    logger.error({ err, scope: 'anchor_lookup' }, 'anchor lookup failed')
    const message = err instanceof Error ? err.message : 'anchor lookup failed'
    if (/invalid input syntax for type uuid/i.test(message)) {
      sendJson(400, { error: 'anchor entity is not a uuid', request_id: requestId })
      return true
    }
    sendJson(500, { error: message, request_id: requestId })
    return true
  }
}
