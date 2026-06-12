import type http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { Capability } from '@sitelayer/domain'
import type { ProjectEventEnvelope, WorkRequest } from '@operator/projectkit'
import {
  buildConcernSnapshot,
  buildProjectEventEnvelope,
  buildProjectEventSnapshot,
  buildWorkRequestSnapshot,
} from '@sitelayer/projectkit-bridge'
import type { ActiveCompany } from '../auth-types.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { buildCaptureArtifactStorageKey, type BlueprintStorage } from '../storage.js'
import { AGENT_FEED_TOKENS_ENV, insertAgentFeedConcernTx, parseAgentFeedTokens } from './agent-feed.js'

export type OpsDiagnosticStatus = 'ok' | 'degraded' | 'unavailable' | 'error' | 'unauthorized'

export type OpsDiagnosticComponent = {
  key: string
  label: string
  status: OpsDiagnosticStatus
  detail: string
  latency_ms: number | null
  facts: Record<string, string | number | boolean | null>
}

export type OpsOnsiteDiagnosticActionKey =
  | 'capture_field_context'
  | 'capture_desktop_context'
  | 'route_support_packet'
  | 'dispatch_agent_review'

export type OpsOnsiteDiagnosticAction = {
  key: OpsOnsiteDiagnosticActionKey
  label: string
  enabled: boolean
  reason: string
}

export type OpsOnsiteDiagnosticSessionPlan = {
  status: 'ready' | 'limited' | 'blocked'
  control_level: 'observe' | 'capture' | 'route'
  recommended_entry: OpsOnsiteDiagnosticActionKey
  can_capture_desktop: boolean
  can_route_work: boolean
  can_dispatch_agent_review: boolean
  blockers: string[]
  actions: OpsOnsiteDiagnosticAction[]
}

export type OpsOnsiteDiagnosticAuditEvent = {
  id: string
  at: string
  actor_user_id: string | null
  type: 'session.started' | 'action.requested'
  action_key?: OpsOnsiteDiagnosticActionKey
  effect: 'audit_only'
  summary: string
}

export type OpsOnsiteDiagnosticSessionRecord = {
  id: string
  state: 'active'
  created_at: string
  expires_at: string
  operator_user_id: string | null
  label: string | null
  intent: OpsOnsiteDiagnosticActionKey | null
  plan: OpsOnsiteDiagnosticSessionPlan
  audit_events: OpsOnsiteDiagnosticAuditEvent[]
  agent_feed_deliveries?: OpsOnsiteDiagnosticAgentFeedDelivery[]
  desktop_evidence?: OpsOnsiteDiagnosticDesktopEvidenceResult | null
}

export type OpsOnsiteDiagnosticSessionCreateResponse = {
  schema: 'sitelayer.ops_diagnostic_session.v1'
  session: OpsOnsiteDiagnosticSessionRecord
  control_token: string
}

export type OpsOnsiteDiagnosticSessionActionResponse = {
  schema: 'sitelayer.ops_diagnostic_session_action.v1'
  session: OpsOnsiteDiagnosticSessionRecord
  accepted_action: {
    key: OpsOnsiteDiagnosticActionKey
    effect: 'audit_only'
    desktop_evidence?: OpsOnsiteDiagnosticDesktopEvidenceResult
    capture_route?: OpsOnsiteDiagnosticCaptureRouteResult
    agent_feed?: OpsOnsiteDiagnosticAgentFeedResult
  }
}

export type OpsOnsiteDiagnosticCaptureRouteResult = {
  request_ref: string
  delivery_id: string
  status: 'accepted' | 'failed' | 'not_configured'
  http_status: number | null
  routed: boolean | null
  accepted: number | null
  error: string | null
}

export type OpsOnsiteDiagnosticAgentFeedResult = {
  audience: string
  concern_ref: string
  queued: boolean
  id: string | null
}

export type OpsOnsiteDiagnosticDesktopEvidenceResult = {
  capture_session_id: string | null
  artifact_id: string | null
  storage_key: string | null
  file_path: string | null
  status: 'attached' | 'failed' | 'not_configured'
  content_type: string | null
  byte_size: number | null
  error: string | null
}

export type OpsOnsiteDiagnosticAgentFeedDelivery = {
  action_key: OpsOnsiteDiagnosticActionKey
  audience: string
  concern_ref: string
  status: 'pending' | 'claimed' | 'succeeded' | 'failed' | 'cancelled'
  queued_at: string
  claimed_at: string | null
  completed_at: string | null
  callback_status: string | null
  callback_error: string | null
  stale: boolean
}

export type OpsDiagnosticsResponse = {
  schema: 'sitelayer.ops_diagnostics.v1'
  generated_at: string
  status: OpsDiagnosticStatus
  summary: {
    total: number
    ok: number
    degraded: number
    unavailable: number
    error: number
  }
  components: OpsDiagnosticComponent[]
  onsite_session: OpsOnsiteDiagnosticSessionPlan
}

export type OpsDiagnosticsRouteCtx = {
  requireCapability: (capability: Capability) => Promise<boolean>
  sendJson: (status: number, body: unknown) => void
  company?: ActiveCompany
  storage?: BlueprintStorage
  buildSha?: string
  readBody?: () => Promise<Record<string, unknown>>
  getCurrentUserId?: () => string
  fetchImpl?: typeof fetch
}

type ProbeResult = {
  status: OpsDiagnosticStatus
  latency_ms: number | null
  http_status: number | null
  body: unknown
  error: string | null
}

type OpsDiagnosticsBuildOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  gatewayDiagnosticsUrl?: string
  screenCaptureUrl?: string
  captureRouterUrl?: string
  agentFeedTokensEnv?: string | undefined
  diagnosticAgentAudience?: string | null | undefined
}

const DEFAULT_TIMEOUT_MS = 900
const SESSION_TTL_MS = 60 * 60 * 1000
const MAX_ACTIVE_SESSIONS = 100
const APP_ISSUE_VIEW: Capability = 'app_issue.view'
const APP_ISSUE_CAPTURE: Capability = 'app_issue.capture'
// Optional agent-feed lane for routed onsite actions. Unset means audit-only.
const OPS_DIAGNOSTIC_AGENT_AUDIENCE_ENV = 'SITELAYER_OPS_DIAGNOSTIC_AGENT_AUDIENCE'
const OPS_DESKTOP_EVIDENCE_CONSENT_VERSION = 'ops-diagnostic-desktop-v1'
const OPS_DESKTOP_EVIDENCE_DEFAULT_SECONDS = 20
const OPS_DESKTOP_EVIDENCE_DEFAULT_TIMEOUT_MS = 7500
const OPS_DESKTOP_EVIDENCE_RETENTION_DAYS = 14

export type StoredOnsiteDiagnosticSession = OpsOnsiteDiagnosticSessionRecord & {
  control_token?: string
  control_token_hash?: string
}

const onsiteDiagnosticSessions = new Map<string, StoredOnsiteDiagnosticSession>()
const AGENT_FEED_DELIVERY_STALE_MS = 15 * 60 * 1000

export async function handleOpsDiagnosticsRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: OpsDiagnosticsRouteCtx,
): Promise<boolean> {
  if (url.pathname === '/api/ops/diagnostics') {
    if (req.method !== 'GET') {
      ctx.sendJson(405, { error: 'method not allowed' })
      return true
    }
    if (!(await ctx.requireCapability(APP_ISSUE_VIEW))) return true

    const response = await buildOpsDiagnostics(diagnosticsOptions(ctx))
    ctx.sendJson(200, response)
    return true
  }

  if (url.pathname === '/api/ops/diagnostics/sessions') {
    if (req.method === 'GET') {
      if (!(await ctx.requireCapability(APP_ISSUE_VIEW))) return true
      const sessions = await listOnsiteDiagnosticSessions(ctx)
      ctx.sendJson(200, {
        schema: 'sitelayer.ops_diagnostic_sessions.v1',
        sessions,
      })
      return true
    }
    if (req.method === 'POST') {
      if (!(await ctx.requireCapability(APP_ISSUE_CAPTURE))) return true
      const body = await readRequestBody(ctx)
      if (!body.ok) {
        ctx.sendJson(400, { error: body.error })
        return true
      }
      const diagnostics = await buildOpsDiagnostics(diagnosticsOptions(ctx))
      const created = await createOnsiteDiagnosticSession(ctx, {
        body: body.value,
        plan: diagnostics.onsite_session,
        actorUserId: ctx.getCurrentUserId?.() ?? null,
      })
      ctx.sendJson(201, {
        schema: 'sitelayer.ops_diagnostic_session.v1',
        session: publicSession(created.session),
        control_token: created.controlToken,
      } satisfies OpsOnsiteDiagnosticSessionCreateResponse)
      return true
    }
    ctx.sendJson(405, { error: 'method not allowed' })
    return true
  }

  const sessionActionMatch = url.pathname.match(/^\/api\/ops\/diagnostics\/sessions\/([^/]+)\/actions$/)
  if (sessionActionMatch) {
    if (req.method !== 'POST') {
      ctx.sendJson(405, { error: 'method not allowed' })
      return true
    }
    if (!(await ctx.requireCapability(APP_ISSUE_CAPTURE))) return true
    const session = await lookupSession(ctx, sessionActionMatch[1] ?? '')
    if (!session.ok) {
      ctx.sendJson(session.status, { error: session.error })
      return true
    }
    const body = await readRequestBody(ctx)
    if (!body.ok) {
      ctx.sendJson(400, { error: body.error })
      return true
    }
    const actionResult = await recordOnsiteDiagnosticAction(
      ctx,
      session.value,
      body.value,
      ctx.getCurrentUserId?.() ?? null,
    )
    if (!actionResult.ok) {
      ctx.sendJson(
        actionResult.status,
        actionResult.reason
          ? { error: actionResult.error, reason: actionResult.reason }
          : { error: actionResult.error },
      )
      return true
    }
    ctx.sendJson(202, actionResult.value)
    return true
  }

  const sessionMatch = url.pathname.match(/^\/api\/ops\/diagnostics\/sessions\/([^/]+)$/)
  if (sessionMatch) {
    if (req.method !== 'GET') {
      ctx.sendJson(405, { error: 'method not allowed' })
      return true
    }
    if (!(await ctx.requireCapability(APP_ISSUE_VIEW))) return true
    const session = await lookupSession(ctx, sessionMatch[1] ?? '')
    if (!session.ok) {
      ctx.sendJson(session.status, { error: session.error })
      return true
    }
    ctx.sendJson(200, { schema: 'sitelayer.ops_diagnostic_session.v1', session: publicSession(session.value) })
    return true
  }

  return false
}

function diagnosticsOptions(ctx: OpsDiagnosticsRouteCtx): OpsDiagnosticsBuildOptions {
  const options: OpsDiagnosticsBuildOptions = {
    timeoutMs: readTimeoutMs(),
    gatewayDiagnosticsUrl: firstNonEmpty(
      process.env.SITELAYER_OPS_GATEWAY_DIAGNOSTICS_URL,
      process.env.CONSOLE_GATEWAY_DIAGNOSTICS_URL,
      'http://127.0.0.1:4356/api/diagnostics',
    ),
    screenCaptureUrl: firstNonEmpty(process.env.SITELAYER_OPS_SCREEN_CAPTURE_URL, 'http://127.0.0.1:4357'),
    captureRouterUrl: firstNonEmpty(process.env.SITELAYER_OPS_CAPTURE_ROUTER_URL, 'http://127.0.0.1:8814'),
    agentFeedTokensEnv: process.env[AGENT_FEED_TOKENS_ENV],
    diagnosticAgentAudience: process.env[OPS_DIAGNOSTIC_AGENT_AUDIENCE_ENV],
  }
  if (ctx.fetchImpl) options.fetchImpl = ctx.fetchImpl
  return options
}

export async function buildOpsDiagnostics(opts: OpsDiagnosticsBuildOptions = {}): Promise<OpsDiagnosticsResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const gatewayDiagnosticsUrl = trimTrailingSlash(opts.gatewayDiagnosticsUrl ?? '')
  const screenCaptureUrl = trimTrailingSlash(opts.screenCaptureUrl ?? '')
  const captureRouterUrl = trimTrailingSlash(opts.captureRouterUrl ?? '')

  const [gatewayProbe, screenProbe, routerProbe] = await Promise.all([
    probeJson(gatewayDiagnosticsUrl, { fetchImpl, timeoutMs }),
    probeJson(screenCaptureUrl ? `${screenCaptureUrl}/api/screen/status` : '', { fetchImpl, timeoutMs }),
    probeJson(captureRouterUrl ? `${captureRouterUrl}/health` : '', { fetchImpl, timeoutMs }),
  ])

  const components = [
    summarizeGatewayDiagnostics(gatewayProbe),
    summarizeScreenCapture(screenProbe),
    summarizeCaptureRouter(routerProbe),
    summarizeAgentFeedRouting(opts.diagnosticAgentAudience, opts.agentFeedTokensEnv),
  ]
  const summary = {
    total: components.length,
    ok: components.filter((c) => c.status === 'ok').length,
    degraded: components.filter((c) => c.status === 'degraded').length,
    unavailable: components.filter((c) => c.status === 'unavailable' || c.status === 'unauthorized').length,
    error: components.filter((c) => c.status === 'error').length,
  }
  return {
    schema: 'sitelayer.ops_diagnostics.v1',
    generated_at: new Date().toISOString(),
    status: summary.error > 0 || summary.unavailable > 0 ? 'degraded' : summary.degraded > 0 ? 'degraded' : 'ok',
    summary,
    components,
    onsite_session: buildOnsiteDiagnosticSessionPlan(components),
  }
}

async function listOnsiteDiagnosticSessions(ctx: OpsDiagnosticsRouteCtx): Promise<OpsOnsiteDiagnosticSessionRecord[]> {
  if (ctx.company) return listPersistentOnsiteDiagnosticSessions(ctx.company.id)
  pruneExpiredSessions()
  return Array.from(onsiteDiagnosticSessions.values()).map(publicSession)
}

async function createOnsiteDiagnosticSession(
  ctx: OpsDiagnosticsRouteCtx,
  opts: {
    body: Record<string, unknown>
    plan: OpsOnsiteDiagnosticSessionPlan
    actorUserId: string | null
  },
): Promise<{ session: StoredOnsiteDiagnosticSession; controlToken: string }> {
  if (ctx.company) return createPersistentOnsiteDiagnosticSession(ctx.company.id, opts)
  const session = createMemoryOnsiteDiagnosticSession(opts)
  if (!session.control_token) throw new Error('memory diagnostic session missing control token')
  return { session, controlToken: session.control_token }
}

function createMemoryOnsiteDiagnosticSession(opts: {
  body: Record<string, unknown>
  plan: OpsOnsiteDiagnosticSessionPlan
  actorUserId: string | null
}): StoredOnsiteDiagnosticSession {
  pruneExpiredSessions()
  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS)
  const requestedIntent = actionKeyValue(opts.body.intent)
  const intent =
    requestedIntent && actionEnabled(opts.plan, requestedIntent) ? requestedIntent : opts.plan.recommended_entry
  const id = `opsdiag_${randomUUID().replace(/-/g, '').slice(0, 18)}`
  const session: StoredOnsiteDiagnosticSession = {
    id,
    state: 'active',
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    operator_user_id: opts.actorUserId,
    label: boundedString(opts.body.label, 80),
    intent,
    plan: opts.plan,
    audit_events: [
      {
        id: `event_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
        at: createdAt.toISOString(),
        actor_user_id: opts.actorUserId,
        type: 'session.started',
        effect: 'audit_only',
        summary: `Started onsite diagnostic session with ${opts.plan.control_level} control.`,
      },
    ],
    control_token: randomUUID(),
  }
  onsiteDiagnosticSessions.set(id, session)
  pruneOldestSessions()
  return session
}

async function createPersistentOnsiteDiagnosticSession(
  companyId: string,
  opts: {
    body: Record<string, unknown>
    plan: OpsOnsiteDiagnosticSessionPlan
    actorUserId: string | null
  },
): Promise<{ session: StoredOnsiteDiagnosticSession; controlToken: string }> {
  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS)
  const requestedIntent = actionKeyValue(opts.body.intent)
  const intent =
    requestedIntent && actionEnabled(opts.plan, requestedIntent) ? requestedIntent : opts.plan.recommended_entry
  const label = boundedString(opts.body.label, 80)
  const controlToken = randomUUID()
  const controlTokenHash = hashControlToken(controlToken)
  const sessionId = randomUUID()
  const eventId = randomUUID()
  const event: OpsOnsiteDiagnosticAuditEvent = {
    id: eventId,
    at: createdAt.toISOString(),
    actor_user_id: opts.actorUserId,
    type: 'session.started',
    effect: 'audit_only',
    summary: `Started onsite diagnostic session with ${opts.plan.control_level} control.`,
  }

  const session = await withMutationTx(companyId, async (client: PoolClient) => {
    await client.query(
      `insert into ops_diagnostic_sessions (
         id, company_id, operator_user_id, label, intent, plan, control_token_hash, state, expires_at, created_at, updated_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'active', $8, $9, $9)`,
      [
        sessionId,
        companyId,
        opts.actorUserId,
        label,
        intent,
        JSON.stringify(opts.plan),
        controlTokenHash,
        expiresAt.toISOString(),
        createdAt.toISOString(),
      ],
    )
    await client.query(
      `insert into ops_diagnostic_session_events (
         id, company_id, session_id, actor_user_id, event_type, action_key, effect, summary, created_at
       ) values ($1, $2, $3, $4, $5, null, 'audit_only', $6, $7)`,
      [eventId, companyId, sessionId, opts.actorUserId, event.type, event.summary, createdAt.toISOString()],
    )
    return {
      id: sessionId,
      state: 'active' as const,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      operator_user_id: opts.actorUserId,
      label,
      intent,
      plan: opts.plan,
      audit_events: [event],
      control_token_hash: controlTokenHash,
    }
  })

  return { session, controlToken }
}

async function recordOnsiteDiagnosticAction(
  ctx: OpsDiagnosticsRouteCtx,
  session: StoredOnsiteDiagnosticSession,
  body: Record<string, unknown>,
  actorUserId: string | null,
): Promise<
  | { ok: true; value: OpsOnsiteDiagnosticSessionActionResponse }
  | { ok: false; status: number; error: string; reason?: string }
> {
  const token = boundedString(body.control_token, 200)
  if (!token || !controlTokenMatches(session, token)) return { ok: false, status: 403, error: 'invalid control token' }

  const actionKey = actionKeyValue(body.action_key)
  if (!actionKey) return { ok: false, status: 400, error: 'action_key is required' }
  const action = session.plan.actions.find((candidate) => candidate.key === actionKey)
  if (!action) return { ok: false, status: 400, error: 'unknown action_key' }
  if (!action.enabled) return { ok: false, status: 409, error: 'action is not available', reason: action.reason }

  if (ctx.company) {
    const persisted = await recordPersistentOnsiteDiagnosticAction(
      ctx.company.id,
      session,
      actionKey,
      action.label,
      actorUserId,
    )
    if (!persisted) return { ok: false, status: 404, error: 'diagnostic session not found' }
    const options = diagnosticsOptions(ctx)
    const [desktopEvidence, captureRoute] = await Promise.all([
      captureOnsiteDesktopEvidence(ctx, options, {
        session: persisted.session,
        event: persisted.event,
        actionKey,
        actorUserId,
      }),
      deliverOnsiteDiagnosticCaptureRoute(options, {
        session: persisted.session,
        event: persisted.event,
        actionKey,
        actionLabel: action.label,
        actorUserId,
      }),
    ])
    return {
      ok: true,
      value: {
        schema: 'sitelayer.ops_diagnostic_session_action.v1',
        session: publicSession(sessionWithDesktopEvidence(persisted.session, desktopEvidence)),
        accepted_action: {
          key: actionKey,
          effect: 'audit_only',
          ...(desktopEvidence ? { desktop_evidence: desktopEvidence } : {}),
          ...(captureRoute ? { capture_route: captureRoute } : {}),
          ...(persisted.agentFeed ? { agent_feed: persisted.agentFeed } : {}),
        },
      },
    }
  }

  const event = recordMemoryOnsiteDiagnosticAction(session, actionKey, action.label, actorUserId)
  const captureRoute = await deliverOnsiteDiagnosticCaptureRoute(diagnosticsOptions(ctx), {
    session,
    event,
    actionKey,
    actionLabel: action.label,
    actorUserId,
  })
  return {
    ok: true,
    value: {
      schema: 'sitelayer.ops_diagnostic_session_action.v1',
      session: publicSession(session),
      accepted_action: {
        key: actionKey,
        effect: 'audit_only',
        ...(captureRoute ? { capture_route: captureRoute } : {}),
      },
    },
  }
}

function recordMemoryOnsiteDiagnosticAction(
  session: StoredOnsiteDiagnosticSession,
  actionKey: OpsOnsiteDiagnosticActionKey,
  actionLabel: string,
  actorUserId: string | null,
): OpsOnsiteDiagnosticAuditEvent {
  const at = new Date().toISOString()
  const event: OpsOnsiteDiagnosticAuditEvent = {
    id: `event_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
    at,
    actor_user_id: actorUserId,
    type: 'action.requested',
    action_key: actionKey,
    effect: 'audit_only',
    summary: `Requested ${actionLabel}.`,
  }
  session.audit_events.push(event)
  return event
}

async function recordPersistentOnsiteDiagnosticAction(
  companyId: string,
  session: StoredOnsiteDiagnosticSession,
  actionKey: OpsOnsiteDiagnosticActionKey,
  actionLabel: string,
  actorUserId: string | null,
): Promise<{
  session: StoredOnsiteDiagnosticSession
  event: OpsOnsiteDiagnosticAuditEvent
  agentFeed: OpsOnsiteDiagnosticAgentFeedResult | null
} | null> {
  const at = new Date().toISOString()
  const event: OpsOnsiteDiagnosticAuditEvent = {
    id: randomUUID(),
    at,
    actor_user_id: actorUserId,
    type: 'action.requested',
    action_key: actionKey,
    effect: 'audit_only',
    summary: `Requested ${actionLabel}.`,
  }
  const result = await withMutationTx(companyId, async (client: PoolClient) => {
    const update = await client.query(
      `update ops_diagnostic_sessions
          set updated_at = $3
        where company_id = $1 and id = $2::uuid and state = 'active' and expires_at > $3`,
      [companyId, session.id, at],
    )
    if (update.rowCount !== 1) return null
    await client.query(
      `insert into ops_diagnostic_session_events (
         id, company_id, session_id, actor_user_id, event_type, action_key, effect, summary, created_at
       ) values ($1, $2, $3, $4, $5, $6, 'audit_only', $7, $8)`,
      [event.id, companyId, session.id, actorUserId, event.type, actionKey, event.summary, at],
    )
    const agentFeed = await enqueueOnsiteDiagnosticConcernTx(client, {
      companyId,
      session,
      event,
      actionKey,
      actionLabel,
      actorUserId,
      requestedAt: at,
    })
    const deliveries = await listPersistentAgentFeedDeliveries(client, companyId, session.id)
    return { agentFeed, deliveries }
  })
  if (!result) return null
  return {
    session: {
      ...session,
      audit_events: [...session.audit_events, event],
      agent_feed_deliveries: result.deliveries,
    },
    event,
    agentFeed: result.agentFeed,
  }
}

async function enqueueOnsiteDiagnosticConcernTx(
  client: PoolClient,
  args: {
    companyId: string
    session: StoredOnsiteDiagnosticSession
    event: OpsOnsiteDiagnosticAuditEvent
    actionKey: OpsOnsiteDiagnosticActionKey
    actionLabel: string
    actorUserId: string | null
    requestedAt: string
  },
): Promise<OpsOnsiteDiagnosticAgentFeedResult | null> {
  if (!routesToAgentFeed(args.actionKey)) return null
  const audience = opsDiagnosticAgentAudience()
  if (!audience) return null
  const concernRef = `opsdiag:${args.session.id}:${args.actionKey}`
  // Routed through the validated @sitelayer/projectkit-bridge builder (the
  // single place the published contract is assembled + enforced — the
  // conformance ratchet in apps/api/src/projectkit-concern.test.ts bans
  // hand-rolled snapshot literals). Ref-only dispatch: no work item exists, so
  // concernRef carries the producer-stable idempotency key. kind defaults to
  // 'execute'; severity maps 1:1 onto the published priority vocabulary.
  const concern = buildConcernSnapshot({
    concernRef,
    title: `${args.actionLabel} for onsite diagnostics`,
    summary: `Operator requested ${args.actionLabel} from Mobile Ops.`,
    severity: args.actionKey === 'dispatch_agent_review' ? 'high' : 'normal',
    audience,
    assignee: audience,
    sourceEventRef: `ops_diagnostic_session:${args.session.id}`,
    dispatchedAt: args.requestedAt,
    acceptance: [
      'Inspect the onsite diagnostic session plan and blockers.',
      'Return a callback with the next phone-safe operator action or a clear reason no action is possible.',
    ],
    inputs: onsiteDiagnosticExecutorInputs(args),
  })
  const id = await insertAgentFeedConcernTx(client, {
    companyId: args.companyId,
    audience,
    concern,
  })
  return { audience, concern_ref: concernRef, queued: Boolean(id), id }
}

function routesToAgentFeed(actionKey: OpsOnsiteDiagnosticActionKey): boolean {
  return actionKey === 'route_support_packet' || actionKey === 'dispatch_agent_review'
}

function routedAgentFeedConcernRefs(sessionId: string): string[] {
  return (['route_support_packet', 'dispatch_agent_review'] satisfies OpsOnsiteDiagnosticActionKey[]).map(
    (actionKey) => `opsdiag:${sessionId}:${actionKey}`,
  )
}

function routesToCaptureRouter(actionKey: OpsOnsiteDiagnosticActionKey): boolean {
  return (
    actionKey === 'capture_desktop_context' ||
    actionKey === 'route_support_packet' ||
    actionKey === 'dispatch_agent_review'
  )
}

async function deliverOnsiteDiagnosticCaptureRoute(
  opts: OpsDiagnosticsBuildOptions,
  args: {
    session: StoredOnsiteDiagnosticSession
    event: OpsOnsiteDiagnosticAuditEvent
    actionKey: OpsOnsiteDiagnosticActionKey
    actionLabel: string
    actorUserId: string | null
  },
): Promise<OpsOnsiteDiagnosticCaptureRouteResult | null> {
  if (!routesToCaptureRouter(args.actionKey)) return null
  const routerUrl = trimTrailingSlash(opts.captureRouterUrl ?? '')
  const fallbackRequestRef = `opsdiag:${args.session.id}:${args.actionKey}`
  let envelope: ProjectEventEnvelope
  try {
    envelope = buildOnsiteDiagnosticCaptureEnvelope(args)
  } catch (err) {
    return {
      request_ref: fallbackRequestRef,
      delivery_id: `${fallbackRequestRef}:${args.event.id}`,
      status: 'failed',
      http_status: null,
      routed: null,
      accepted: null,
      error: err instanceof Error ? err.message : 'capture route envelope build failed',
    }
  }
  const workRequest = objectValue(envelope.events[0]?.payload)?.work_request as WorkRequest | undefined
  const requestRef = typeof workRequest?.request_ref === 'string' ? workRequest.request_ref : fallbackRequestRef
  const deliveryId = envelope.delivery_id ?? requestRef
  if (!routerUrl) {
    return {
      request_ref: requestRef,
      delivery_id: deliveryId,
      status: 'not_configured',
      http_status: null,
      routed: null,
      accepted: null,
      error: 'capture router is not configured',
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${routerUrl}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    })
    const body = await response.json().catch(() => null)
    const bodyObject = objectValue(body)
    const routed = booleanValue(bodyObject?.routed)
    const accepted = numberValue(bodyObject?.accepted)
    const error = statusValue(bodyObject?.error) ?? statusValue(bodyObject?.reason)
    return {
      request_ref: requestRef,
      delivery_id: deliveryId,
      status: response.ok && routed !== false ? 'accepted' : 'failed',
      http_status: response.status,
      routed,
      accepted,
      error: response.ok ? error : (error ?? `HTTP ${response.status}`),
    }
  } catch (err) {
    const error =
      err instanceof Error && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof Error
          ? err.message
          : 'capture router delivery failed'
    return {
      request_ref: requestRef,
      delivery_id: deliveryId,
      status: 'failed',
      http_status: null,
      routed: null,
      accepted: null,
      error,
    }
  } finally {
    clearTimeout(timer)
  }
}

type OpsDiagnosticsTxRunner = <T>(companyId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>

async function captureOnsiteDesktopEvidence(
  ctx: OpsDiagnosticsRouteCtx,
  opts: OpsDiagnosticsBuildOptions,
  args: {
    session: StoredOnsiteDiagnosticSession
    event: OpsOnsiteDiagnosticAuditEvent
    actionKey: OpsOnsiteDiagnosticActionKey
    actorUserId: string | null
  },
  runTx: OpsDiagnosticsTxRunner = withMutationTx,
): Promise<OpsOnsiteDiagnosticDesktopEvidenceResult | null> {
  if (args.actionKey !== 'capture_desktop_context') return null
  const companyId = ctx.company?.id
  if (!companyId || !ctx.storage) {
    return desktopEvidenceResult('not_configured', 'company storage is not available')
  }
  const screenCaptureUrl = trimTrailingSlash(opts.screenCaptureUrl ?? '')
  if (!screenCaptureUrl) return desktopEvidenceResult('not_configured', 'screen capture is not configured')

  const captureSeconds = readBoundedIntegerEnv(
    'SITELAYER_OPS_DESKTOP_EVIDENCE_SECONDS',
    OPS_DESKTOP_EVIDENCE_DEFAULT_SECONDS,
    5,
    120,
  )
  const downloaded = await downloadDesktopEvidenceClip(screenCaptureUrl, {
    fetchImpl: opts.fetchImpl ?? fetch,
    timeoutMs: readBoundedIntegerEnv(
      'SITELAYER_OPS_DESKTOP_EVIDENCE_TIMEOUT_MS',
      OPS_DESKTOP_EVIDENCE_DEFAULT_TIMEOUT_MS,
      1000,
      30000,
    ),
    captureSeconds,
  })
  if (!downloaded.ok) return desktopEvidenceResult('failed', downloaded.error)

  const captureSessionId = randomUUID()
  const fileName = `ops-diagnostic-desktop-${args.event.id}.mp4`
  const storageKey = buildCaptureArtifactStorageKey(companyId, captureSessionId, fileName)
  const contentHash = createHash('sha256').update(downloaded.bytes).digest('hex')
  const now = new Date()
  const retentionExpiresAt = new Date(now.getTime() + OPS_DESKTOP_EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  try {
    await ctx.storage.put(storageKey, downloaded.bytes, downloaded.contentType)
    const artifactId = await runTx(companyId, async (client) => {
      await insertOpsDesktopCaptureSessionTx(client, {
        companyId,
        captureSessionId,
        actorUserId: args.actorUserId,
        buildSha: ctx.buildSha ?? null,
        now,
        retentionExpiresAt,
        session: args.session,
        event: args.event,
        captureSeconds,
      })
      const artifact = await client.query<{ id: string }>(
        `insert into capture_artifacts (
           company_id, capture_session_id, kind, storage_key, uri, content_type,
           byte_size, content_hash, duration_ms, pii_level, access_policy,
           metadata, retention_expires_at, redaction_version
         ) values (
           $1, $2::uuid, 'video', $3, null, $4,
           $5, $6, $7, 'private', 'support_only',
           $8::jsonb, $9::timestamptz, 'capture-session-v1'
         )
         returning id::text as id`,
        [
          companyId,
          captureSessionId,
          storageKey,
          downloaded.contentType,
          downloaded.bytes.length,
          contentHash,
          captureSeconds * 1000,
          JSON.stringify({
            source: 'ops_diagnostic_desktop_capture',
            ops_diagnostic_session_id: args.session.id,
            action_event_id: args.event.id,
            requested_action: args.actionKey,
            requested_by: args.actorUserId,
            capture_seconds: captureSeconds,
            screen_capture_endpoint: '/api/screen/clip/file',
          }),
          retentionExpiresAt.toISOString(),
        ],
      )
      await client.query(`update capture_sessions set last_seen_at = now() where id = $1::uuid and company_id = $2`, [
        captureSessionId,
        companyId,
      ])
      return artifact.rows[0]?.id ?? null
    })
    return {
      capture_session_id: captureSessionId,
      artifact_id: artifactId,
      storage_key: storageKey,
      file_path: artifactId ? captureArtifactFilePath(captureSessionId, artifactId) : null,
      status: 'attached',
      content_type: downloaded.contentType,
      byte_size: downloaded.bytes.length,
      error: null,
    }
  } catch (err) {
    return desktopEvidenceResult('failed', err instanceof Error ? err.message : 'desktop evidence attach failed')
  }
}

async function insertOpsDesktopCaptureSessionTx(
  client: PoolClient,
  args: {
    companyId: string
    captureSessionId: string
    actorUserId: string | null
    buildSha: string | null
    now: Date
    retentionExpiresAt: Date
    session: StoredOnsiteDiagnosticSession
    event: OpsOnsiteDiagnosticAuditEvent
    captureSeconds: number
  },
): Promise<void> {
  await client.query(
    `insert into capture_sessions (
       id, company_id, actor_user_id, mode, status, route_path, device_kind,
       platform, viewport, app_build_sha, consent_version,
       consent_actor_kind, consent_actor_ref, consent_authority, consent_scope,
       consented_at, metadata, started_at, last_seen_at, stopped_at,
       retention_expires_at
     ) values (
       $1::uuid, $2, $3, 'desktop', 'stopped', '/ops', 'desktop',
       'screen-capture', null, $4, $5,
       $6, $7, $8, $9::jsonb,
       $10::timestamptz, $11::jsonb, $10::timestamptz, $10::timestamptz, $10::timestamptz,
       $12::timestamptz
     )`,
    [
      args.captureSessionId,
      args.companyId,
      args.actorUserId,
      args.buildSha,
      OPS_DESKTOP_EVIDENCE_CONSENT_VERSION,
      args.actorUserId ? 'user' : null,
      args.actorUserId,
      'authenticated_company_user',
      JSON.stringify({
        mode: 'desktop',
        route_path: '/ops',
        screen_video: true,
        streams: ['screen_video'],
        artifacts: { video: true },
      }),
      args.now.toISOString(),
      JSON.stringify({
        source: 'ops_diagnostic_desktop_capture',
        ops_diagnostic_session_id: args.session.id,
        action_event_id: args.event.id,
        capture_seconds: args.captureSeconds,
      }),
      args.retentionExpiresAt.toISOString(),
    ],
  )
}

type DownloadedDesktopEvidenceClip = { ok: true; bytes: Buffer; contentType: string } | { ok: false; error: string }

async function downloadDesktopEvidenceClip(
  screenCaptureUrl: string,
  opts: { fetchImpl: typeof fetch; timeoutMs: number; captureSeconds: number },
): Promise<DownloadedDesktopEvidenceClip> {
  let clipUrl: URL
  try {
    clipUrl = new URL(`${screenCaptureUrl}/api/screen/clip/file`)
  } catch {
    return { ok: false, error: 'screen capture URL is invalid' }
  }
  clipUrl.searchParams.set('since', String(opts.captureSeconds))
  clipUrl.searchParams.set('format', 'mp4')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const response = await opts.fetchImpl(clipUrl, {
      headers: { accept: 'video/mp4, application/octet-stream' },
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, error: `screen capture HTTP ${response.status}` }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length <= 0) return { ok: false, error: 'screen capture returned an empty clip' }
    return { ok: true, bytes, contentType: normalizedContentType(response.headers.get('content-type'), 'video/mp4') }
  } catch (err) {
    const error =
      err instanceof Error && err.name === 'AbortError'
        ? 'screen capture timeout'
        : err instanceof Error
          ? err.message
          : 'screen capture fetch failed'
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

function desktopEvidenceResult(
  status: OpsOnsiteDiagnosticDesktopEvidenceResult['status'],
  error: string | null,
): OpsOnsiteDiagnosticDesktopEvidenceResult {
  return {
    capture_session_id: null,
    artifact_id: null,
    storage_key: null,
    file_path: null,
    status,
    content_type: null,
    byte_size: null,
    error,
  }
}

function captureArtifactFilePath(captureSessionId: string, artifactId: string): string {
  return `/api/capture-sessions/${encodeURIComponent(captureSessionId)}/artifacts/${encodeURIComponent(artifactId)}/file`
}

function normalizedContentType(value: string | null, fallback: string): string {
  const clean = value?.split(';')[0]?.trim().toLowerCase()
  return clean || fallback
}

function readBoundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

export async function __captureOnsiteDesktopEvidenceForTests(
  ctx: OpsDiagnosticsRouteCtx,
  opts: OpsDiagnosticsBuildOptions,
  args: {
    session: StoredOnsiteDiagnosticSession
    event: OpsOnsiteDiagnosticAuditEvent
    actionKey: OpsOnsiteDiagnosticActionKey
    actorUserId: string | null
  },
  runTx: OpsDiagnosticsTxRunner,
): Promise<OpsOnsiteDiagnosticDesktopEvidenceResult | null> {
  return captureOnsiteDesktopEvidence(ctx, opts, args, runTx)
}

/**
 * The flat executor-facing context for an onsite diagnostic action — travels
 * as the agent-feed Concern's `inputs` and as the routed WorkRequest's
 * `payload` (and its embedded Concern's `inputs`).
 */
function onsiteDiagnosticExecutorInputs(args: {
  session: StoredOnsiteDiagnosticSession
  event: OpsOnsiteDiagnosticAuditEvent
  actionKey: OpsOnsiteDiagnosticActionKey
  actorUserId: string | null
}): Record<string, unknown> {
  return {
    ops_diagnostic_session_id: args.session.id,
    action_event_id: args.event.id,
    requested_action: args.actionKey,
    requested_by: args.actorUserId,
    plan_status: args.session.plan.status,
    control_level: args.session.plan.control_level,
    recommended_entry: args.session.plan.recommended_entry,
    can_capture_desktop: args.session.plan.can_capture_desktop,
    can_route_work: args.session.plan.can_route_work,
    can_dispatch_agent_review: args.session.plan.can_dispatch_agent_review,
    blockers: args.session.plan.blockers,
    ready_actions: args.session.plan.actions.filter((action) => action.enabled).map((action) => action.key),
  }
}

function buildOnsiteDiagnosticCaptureEnvelope(args: {
  session: StoredOnsiteDiagnosticSession
  event: OpsOnsiteDiagnosticAuditEvent
  actionKey: OpsOnsiteDiagnosticActionKey
  actionLabel: string
  actorUserId: string | null
}): ProjectEventEnvelope {
  const requestedAt = args.event.at
  const requestRef = `opsdiag:${args.session.id}:${args.actionKey}`
  const deliveryId = `${requestRef}:${args.event.id}`
  const executorInputs = onsiteDiagnosticExecutorInputs(args)
  // All three contract shapes are assembled by the validated
  // @sitelayer/projectkit-bridge builders (each throws on a contract
  // violation — the bridge is the only module stamping CONTRACT_VERSION).
  const workRequest = buildWorkRequestSnapshot({
    concernRef: requestRef,
    title: `${args.actionLabel} for onsite diagnostics`,
    summary: `Operator requested ${args.actionLabel} from Mobile Ops.`,
    severity: args.actionKey === 'dispatch_agent_review' ? 'high' : 'normal',
    intent: onsiteActionWorkIntent(args.actionKey),
    route: '/ops',
    entityType: 'ops_diagnostic_session',
    entityId: args.session.id,
    sourceEventRef: `ops_diagnostic_session:${args.session.id}`,
    sensitivity: 'internal',
    acceptance: onsiteActionAcceptance(args.actionKey),
    dispatchedAt: requestedAt,
    inputs: executorInputs,
    payload: executorInputs,
  })

  const event = buildProjectEventSnapshot({
    eventType: `sitelayer.ops_diagnostic.${args.actionKey}.requested`,
    occurredAt: requestedAt,
    domain: 'workflow_event',
    outcome: 'requested',
    environment: process.env.APP_TIER ?? process.env.NODE_ENV ?? 'unknown',
    sourceSurface: 'mobile_ops',
    routePath: '/ops',
    actorKind: 'operator',
    principalId: args.actorUserId,
    entityKind: 'ops_diagnostic_session',
    entityId: args.session.id,
    action: args.actionKey,
    summary: `Operator requested ${args.actionLabel} from Mobile Ops.`,
    sensitivity: 'internal',
    redactionStatus: 'summary_only',
    payload: { work_request: workRequest },
  })

  return buildProjectEventEnvelope({
    emittedAt: requestedAt,
    producer: { name: 'sitelayer.ops-diagnostics' },
    deliveryId,
    events: [event],
  })
}

function onsiteActionWorkIntent(actionKey: OpsOnsiteDiagnosticActionKey): string {
  if (actionKey === 'dispatch_agent_review') return 'review'
  if (actionKey === 'route_support_packet') return 'investigate'
  return 'capture-followup'
}

function onsiteActionAcceptance(actionKey: OpsOnsiteDiagnosticActionKey): string[] {
  if (actionKey === 'capture_desktop_context') {
    return [
      'Inspect available screen-capture context for the onsite diagnostic session.',
      'Return the shortest phone-safe next step, or explain why no desktop evidence is available.',
    ]
  }
  if (actionKey === 'route_support_packet') {
    return [
      'Inspect the onsite diagnostic session plan and blockers.',
      'Route the relevant support packet or explain which prerequisite is missing.',
    ]
  }
  return [
    'Inspect the onsite diagnostic session plan and blockers.',
    'Return a callback with the next phone-safe operator action or a clear reason no action is possible.',
  ]
}

function actionKeyFromConcernRef(concernRef: string): OpsOnsiteDiagnosticActionKey | null {
  const actionKey = concernRef.split(':').at(-1)
  return actionKeyValue(actionKey)
}

function agentFeedDeliveryFromRow(
  row: PersistentAgentFeedDeliveryRow,
  nowMs = Date.now(),
): OpsOnsiteDiagnosticAgentFeedDelivery | null {
  const actionKey = actionKeyFromConcernRef(row.concern_ref)
  const status = agentFeedDeliveryStatus(row.status)
  if (!actionKey || !status) return null
  const queuedAt = isoString(row.created_at)
  const claimedAt = row.claimed_at ? isoString(row.claimed_at) : null
  const completedAt = row.completed_at ? isoString(row.completed_at) : null
  const callback = objectValue(row.callback)
  const staleBase = Date.parse(claimedAt ?? queuedAt)
  const stale =
    (status === 'pending' || status === 'claimed') &&
    Number.isFinite(staleBase) &&
    nowMs - staleBase > AGENT_FEED_DELIVERY_STALE_MS
  return {
    action_key: actionKey,
    audience: row.audience,
    concern_ref: row.concern_ref,
    status,
    queued_at: queuedAt,
    claimed_at: claimedAt,
    completed_at: completedAt,
    callback_status: statusValue(callback?.status),
    callback_error: statusValue(callback?.error) ?? statusValue(callback?.error_code),
    stale,
  }
}

function agentFeedDeliveryStatus(value: string): OpsOnsiteDiagnosticAgentFeedDelivery['status'] | null {
  return value === 'pending' ||
    value === 'claimed' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : null
}

function opsDiagnosticAgentAudience(): string | null {
  return boundedString(process.env[OPS_DIAGNOSTIC_AGENT_AUDIENCE_ENV], 80)
}

async function lookupSession(
  ctx: OpsDiagnosticsRouteCtx,
  id: string,
): Promise<{ ok: true; value: StoredOnsiteDiagnosticSession } | { ok: false; status: number; error: string }> {
  if (ctx.company) return lookupPersistentSession(ctx.company.id, id)
  pruneExpiredSessions()
  const session = onsiteDiagnosticSessions.get(id)
  if (!session) return { ok: false, status: 404, error: 'diagnostic session not found' }
  return { ok: true, value: session }
}

async function lookupPersistentSession(
  companyId: string,
  id: string,
): Promise<{ ok: true; value: StoredOnsiteDiagnosticSession } | { ok: false; status: number; error: string }> {
  if (!isUuid(id)) return { ok: false, status: 404, error: 'diagnostic session not found' }
  const session = await withCompanyClient(companyId, async (client: PoolClient) => {
    const result = await client.query<PersistentSessionRow>(
      `select id, operator_user_id, label, intent, plan, control_token_hash, state, expires_at, created_at
         from ops_diagnostic_sessions
        where company_id = $1 and id = $2::uuid and state = 'active' and expires_at > now()
        limit 1`,
      [companyId, id],
    )
    const row = result.rows[0]
    if (!row) return null
    const events = await listPersistentEvents(client, companyId, row.id)
    const deliveries = await listPersistentAgentFeedDeliveries(client, companyId, row.id)
    const desktopEvidence = await latestPersistentDesktopEvidence(client, companyId, row.id)
    return persistentSessionFromRow(row, events, deliveries, desktopEvidence)
  })
  if (!session) return { ok: false, status: 404, error: 'diagnostic session not found' }
  return { ok: true, value: session }
}

async function listPersistentOnsiteDiagnosticSessions(companyId: string): Promise<OpsOnsiteDiagnosticSessionRecord[]> {
  return withCompanyClient(companyId, async (client: PoolClient) => {
    const result = await client.query<PersistentSessionRow>(
      `select id, operator_user_id, label, intent, plan, control_token_hash, state, expires_at, created_at
         from ops_diagnostic_sessions
        where company_id = $1 and state = 'active' and expires_at > now()
        order by created_at desc
        limit 20`,
      [companyId],
    )
    const sessions: OpsOnsiteDiagnosticSessionRecord[] = []
    for (const row of result.rows) {
      const events = await listPersistentEvents(client, companyId, row.id)
      const deliveries = await listPersistentAgentFeedDeliveries(client, companyId, row.id)
      const desktopEvidence = await latestPersistentDesktopEvidence(client, companyId, row.id)
      sessions.push(publicSession(persistentSessionFromRow(row, events, deliveries, desktopEvidence)))
    }
    return sessions
  })
}

type PersistentSessionRow = {
  id: string
  operator_user_id: string | null
  label: string | null
  intent: string | null
  plan: unknown
  control_token_hash: string
  state: string
  expires_at: string | Date
  created_at: string | Date
}

type PersistentEventRow = {
  id: string
  actor_user_id: string | null
  event_type: string
  action_key: string | null
  effect: string
  summary: string
  created_at: string | Date
}

type PersistentAgentFeedDeliveryRow = {
  id: string
  audience: string
  concern_ref: string
  status: string
  callback: unknown
  claimed_at: string | Date | null
  completed_at: string | Date | null
  created_at: string | Date
}

type PersistentDesktopEvidenceRow = {
  capture_session_id: string
  artifact_id: string
  storage_key: string | null
  content_type: string | null
  byte_size: string | number | null
}

async function listPersistentEvents(
  client: PoolClient,
  companyId: string,
  sessionId: string,
): Promise<OpsOnsiteDiagnosticAuditEvent[]> {
  const result = await client.query<PersistentEventRow>(
    `select id, actor_user_id, event_type, action_key, effect, summary, created_at
       from ops_diagnostic_session_events
      where company_id = $1 and session_id = $2::uuid
      order by created_at asc`,
    [companyId, sessionId],
  )
  return result.rows.map((row) => {
    const actionKey = actionKeyValue(row.action_key)
    return {
      id: row.id,
      at: isoString(row.created_at),
      actor_user_id: row.actor_user_id,
      type: row.event_type === 'action.requested' ? 'action.requested' : 'session.started',
      ...(actionKey ? { action_key: actionKey } : {}),
      effect: 'audit_only',
      summary: row.summary,
    }
  })
}

async function listPersistentAgentFeedDeliveries(
  client: PoolClient,
  companyId: string,
  sessionId: string,
): Promise<OpsOnsiteDiagnosticAgentFeedDelivery[]> {
  const refs = routedAgentFeedConcernRefs(sessionId)
  const result = await client.query<PersistentAgentFeedDeliveryRow>(
    `select id, audience, concern_ref, status, callback, claimed_at, completed_at, created_at
       from agent_feed_concerns
      where company_id = $1 and concern_ref = any($2::text[])
      order by created_at asc, id asc`,
    [companyId, refs],
  )
  return result.rows
    .map((row) => agentFeedDeliveryFromRow(row))
    .filter((delivery): delivery is OpsOnsiteDiagnosticAgentFeedDelivery => Boolean(delivery))
}

function persistentSessionFromRow(
  row: PersistentSessionRow,
  events: OpsOnsiteDiagnosticAuditEvent[],
  deliveries: OpsOnsiteDiagnosticAgentFeedDelivery[] = [],
  desktopEvidence: OpsOnsiteDiagnosticDesktopEvidenceResult | null = null,
): StoredOnsiteDiagnosticSession {
  return {
    id: row.id,
    state: 'active',
    created_at: isoString(row.created_at),
    expires_at: isoString(row.expires_at),
    operator_user_id: row.operator_user_id,
    label: row.label,
    intent: actionKeyValue(row.intent),
    plan: row.plan as OpsOnsiteDiagnosticSessionPlan,
    audit_events: events,
    agent_feed_deliveries: deliveries,
    ...(desktopEvidence ? { desktop_evidence: desktopEvidence } : {}),
    control_token_hash: row.control_token_hash,
  }
}

function publicSession(session: StoredOnsiteDiagnosticSession): OpsOnsiteDiagnosticSessionRecord {
  const { control_token: _controlToken, control_token_hash: _controlTokenHash, ...rest } = session
  return { ...rest, agent_feed_deliveries: rest.agent_feed_deliveries ?? [] }
}

async function latestPersistentDesktopEvidence(
  client: PoolClient,
  companyId: string,
  sessionId: string,
): Promise<OpsOnsiteDiagnosticDesktopEvidenceResult | null> {
  const result = await client.query<PersistentDesktopEvidenceRow>(
    `select s.id::text as capture_session_id,
            a.id::text as artifact_id,
            a.storage_key,
            a.content_type,
            a.byte_size::text as byte_size
       from capture_artifacts a
       join capture_sessions s
         on s.company_id = a.company_id
        and s.id = a.capture_session_id
      where a.company_id = $1
        and a.deleted_at is null
        and a.storage_key is not null
        and a.metadata->>'source' = 'ops_diagnostic_desktop_capture'
        and (
          s.metadata->>'ops_diagnostic_session_id' = $2
          or a.metadata->>'ops_diagnostic_session_id' = $2
        )
        and (a.retention_expires_at is null or a.retention_expires_at > now())
        and (s.retention_expires_at is null or s.retention_expires_at > now())
      order by a.created_at desc, a.id desc
      limit 1`,
    [companyId, sessionId],
  )
  return desktopEvidenceFromRow(result.rows[0] ?? null)
}

function desktopEvidenceFromRow(
  row: PersistentDesktopEvidenceRow | null,
): OpsOnsiteDiagnosticDesktopEvidenceResult | null {
  if (!row?.capture_session_id || !row.artifact_id) return null
  return {
    capture_session_id: row.capture_session_id,
    artifact_id: row.artifact_id,
    storage_key: row.storage_key,
    file_path: captureArtifactFilePath(row.capture_session_id, row.artifact_id),
    status: 'attached',
    content_type: row.content_type,
    byte_size: numberFromUnknown(row.byte_size),
    error: null,
  }
}

function sessionWithDesktopEvidence(
  session: StoredOnsiteDiagnosticSession,
  desktopEvidence: OpsOnsiteDiagnosticDesktopEvidenceResult | null,
): StoredOnsiteDiagnosticSession {
  if (desktopEvidence?.status !== 'attached') return session
  return { ...session, desktop_evidence: desktopEvidence }
}

async function readRequestBody(
  ctx: OpsDiagnosticsRouteCtx,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  if (!ctx.readBody) return { ok: true, value: {} }
  try {
    const body = await ctx.readBody()
    return { ok: true, value: objectValue(body) ?? {} }
  } catch {
    return { ok: false, error: 'invalid request body' }
  }
}

function actionEnabled(plan: OpsOnsiteDiagnosticSessionPlan, key: OpsOnsiteDiagnosticActionKey): boolean {
  return plan.actions.some((action) => action.key === key && action.enabled)
}

function actionKeyValue(value: unknown): OpsOnsiteDiagnosticActionKey | null {
  return value === 'capture_field_context' ||
    value === 'capture_desktop_context' ||
    value === 'route_support_packet' ||
    value === 'dispatch_agent_review'
    ? value
    : null
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, maxLength)
}

function hashControlToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function controlTokenMatches(session: StoredOnsiteDiagnosticSession, token: string): boolean {
  if (session.control_token) return token === session.control_token
  if (session.control_token_hash) return hashControlToken(token) === session.control_token_hash
  return false
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function pruneExpiredSessions(nowMs = Date.now()): void {
  for (const [id, session] of onsiteDiagnosticSessions) {
    if (Date.parse(session.expires_at) <= nowMs) onsiteDiagnosticSessions.delete(id)
  }
}

function pruneOldestSessions(): void {
  if (onsiteDiagnosticSessions.size <= MAX_ACTIVE_SESSIONS) return
  const ordered = Array.from(onsiteDiagnosticSessions.values()).sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  )
  for (const session of ordered.slice(0, onsiteDiagnosticSessions.size - MAX_ACTIVE_SESSIONS)) {
    onsiteDiagnosticSessions.delete(session.id)
  }
}

export function __resetOpsDiagnosticSessionsForTests(): void {
  onsiteDiagnosticSessions.clear()
}

export function __agentFeedDeliveryFromRowForTests(
  row: {
    id: string
    audience: string
    concern_ref: string
    status: string
    callback: unknown
    claimed_at: string | Date | null
    completed_at: string | Date | null
    created_at: string | Date
  },
  nowMs = Date.now(),
): OpsOnsiteDiagnosticAgentFeedDelivery | null {
  return agentFeedDeliveryFromRow(row, nowMs)
}

export function __desktopEvidenceFromRowForTests(
  row: {
    capture_session_id: string
    artifact_id: string
    storage_key: string | null
    content_type: string | null
    byte_size: string | number | null
  } | null,
): OpsOnsiteDiagnosticDesktopEvidenceResult | null {
  return desktopEvidenceFromRow(row)
}

function summarizeGatewayDiagnostics(probe: ProbeResult): OpsDiagnosticComponent {
  const body = objectValue(probe.body)
  if (probe.status !== 'ok') {
    return baseComponent('gateway', 'Console Gateway', probe, probe.error ?? statusDetail(probe))
  }
  const components = objectValue(body?.components)
  const mesh = objectValue(components?.mesh)
  const browserBridge = objectValue(components?.browser_bridge)
  const voice = objectValue(components?.voice)
  const captureRouter = objectValue(components?.capture_router)
  const summary = objectValue(body?.summary)
  const gatewayStatus = statusValue(body?.status)
  const degradedChildren = [mesh, browserBridge, voice, captureRouter].filter((component) => {
    const status = statusValue(component?.status)
    return status && status !== 'ok'
  }).length
  return {
    key: 'gateway',
    label: 'Console Gateway',
    status: gatewayStatus === 'ok' && degradedChildren === 0 ? 'ok' : 'degraded',
    detail:
      gatewayStatus === 'ok' && degradedChildren === 0
        ? 'Gateway diagnostics are green.'
        : `${degradedChildren} gateway subcheck${degradedChildren === 1 ? '' : 's'} need attention.`,
    latency_ms: probe.latency_ms,
    facts: {
      mesh: statusValue(mesh?.status) ?? null,
      browser_bridge: statusValue(browserBridge?.status) ?? null,
      voice: statusValue(voice?.status) ?? null,
      capture_router: statusValue(captureRouter?.status) ?? null,
      ok_checks: numberValue(summary?.ok),
      total_checks: numberValue(summary?.total),
    },
  }
}

function summarizeScreenCapture(probe: ProbeResult): OpsDiagnosticComponent {
  const body = objectValue(probe.body)
  if (probe.status !== 'ok') {
    return baseComponent('screen_capture', 'Screen Capture', probe, probe.error ?? statusDetail(probe))
  }
  const monitors = Array.isArray(body?.monitors) ? body.monitors : []
  const recording = body?.recording === true
  const focusAgeSeconds = numberValue(body?.focus_current_age_seconds)
  const retentionMinutes =
    monitors.length > 0 ? Math.max(...monitors.map((m) => numberValue(objectValue(m)?.retention_minutes) ?? 0)) : null
  return {
    key: 'screen_capture',
    label: 'Screen Capture',
    status: recording && monitors.length > 0 ? 'ok' : 'degraded',
    detail: recording
      ? `${monitors.length} monitor${monitors.length === 1 ? '' : 's'} recording.`
      : 'Screen recording is not confirmed.',
    latency_ms: probe.latency_ms,
    facts: {
      recording,
      monitor_count: monitors.length,
      retention_minutes: retentionMinutes,
      focus_age_seconds: focusAgeSeconds,
      local_storage_only: body?.local_storage_only === true,
    },
  }
}

function summarizeCaptureRouter(probe: ProbeResult): OpsDiagnosticComponent {
  const body = objectValue(probe.body)
  if (probe.status !== 'ok') {
    return baseComponent('capture_router', 'Capture Router', probe, probe.error ?? statusDetail(probe))
  }
  const ok = body?.ok === true
  const sinks = Array.isArray(body?.sinks) ? body.sinks.filter((sink): sink is string => typeof sink === 'string') : []
  const agentEnabled = body?.agentSinkEnabled === true
  const linearEnabled = body?.linear === true
  return {
    key: 'capture_router',
    label: 'Capture Router',
    status: ok ? 'ok' : 'degraded',
    detail: ok
      ? `${sinks.length ? sinks.join(', ') : 'no'} sink${sinks.length === 1 ? '' : 's'} active.`
      : 'Capture router did not report healthy.',
    latency_ms: probe.latency_ms,
    facts: {
      sinks: sinks.join(',') || null,
      agent_sink_enabled: agentEnabled,
      linear_enabled: linearEnabled,
      durable_side_effect_claims: numberValue(body?.durableSideEffectClaims),
    },
  }
}

function summarizeAgentFeedRouting(
  audienceRaw: string | null | undefined,
  tokensRaw: string | undefined,
): OpsDiagnosticComponent {
  const audience = boundedString(audienceRaw, 80)
  const tokens = parseAgentFeedTokens(tokensRaw)
  const audienceCount = tokens?.size ?? 0
  const audienceHasToken = Boolean(audience && tokens?.has(audience))

  if (!audience) {
    return agentFeedComponent(
      'degraded',
      'No onsite diagnostic agent audience configured; routed actions will stay audit-only.',
      false,
      Boolean(tokens),
      audienceHasToken,
      audienceCount,
    )
  }

  if (!tokens) {
    return agentFeedComponent(
      'degraded',
      'Agent feed tokens are not configured or invalid.',
      true,
      false,
      audienceHasToken,
      audienceCount,
    )
  }

  if (!audienceHasToken) {
    return agentFeedComponent(
      'degraded',
      'Configured onsite diagnostic audience has no agent-feed token.',
      true,
      true,
      false,
      audienceCount,
    )
  }

  return agentFeedComponent(
    'ok',
    'Onsite diagnostic audience has an agent-feed token.',
    true,
    true,
    true,
    audienceCount,
  )
}

function agentFeedComponent(
  status: OpsDiagnosticStatus,
  detail: string,
  audienceConfigured: boolean,
  tokensConfigured: boolean,
  audienceHasToken: boolean,
  audienceCount: number,
): OpsDiagnosticComponent {
  return {
    key: 'agent_feed',
    label: 'Agent Feed',
    status,
    detail,
    latency_ms: null,
    facts: {
      audience_configured: audienceConfigured,
      tokens_configured: tokensConfigured,
      audience_has_token: audienceHasToken,
      audience_count: audienceCount,
    },
  }
}

function baseComponent(key: string, label: string, probe: ProbeResult, detail: string): OpsDiagnosticComponent {
  return {
    key,
    label,
    status: probe.status,
    detail,
    latency_ms: probe.latency_ms,
    facts: {
      http_status: probe.http_status,
    },
  }
}

function buildOnsiteDiagnosticSessionPlan(
  components: readonly OpsDiagnosticComponent[],
): OpsOnsiteDiagnosticSessionPlan {
  const gateway = componentByKey(components, 'gateway')
  const screenCapture = componentByKey(components, 'screen_capture')
  const captureRouter = componentByKey(components, 'capture_router')
  const agentFeed = componentByKey(components, 'agent_feed')
  const gatewayOk = gateway?.status === 'ok'
  const screenOk = screenCapture?.status === 'ok' && screenCapture.facts.recording === true
  const routerOk = captureRouter?.status === 'ok'
  const routerHasSink = typeof captureRouter?.facts.sinks === 'string' && captureRouter.facts.sinks.length > 0
  const agentFeedReady = agentFeed?.status === 'ok' && agentFeed.facts.audience_has_token === true
  const canRouteWork = routerOk && routerHasSink && agentFeedReady
  const canDispatchAgentReview = gatewayOk && canRouteWork
  const blockers = [
    ...componentBlockers(gateway),
    ...componentBlockers(screenCapture),
    ...componentBlockers(captureRouter),
    ...componentBlockers(agentFeed),
    ...(routerOk && !routerHasSink ? ['Capture router is healthy but has no active sink.'] : []),
  ]

  const actions: OpsOnsiteDiagnosticAction[] = [
    {
      key: 'capture_field_context',
      label: 'Capture field context',
      enabled: true,
      reason: 'Phone capture can still create a work item.',
    },
    {
      key: 'capture_desktop_context',
      label: 'Attach desktop evidence',
      enabled: screenOk,
      reason: screenOk ? 'Screen capture is recording.' : 'Screen capture is not ready.',
    },
    {
      key: 'route_support_packet',
      label: 'Route support packet',
      enabled: canRouteWork,
      reason: canRouteWork
        ? 'Capture router has an active sink and an agent-feed audience is ready.'
        : routerOk && routerHasSink
          ? 'Agent feed is not ready for routed work.'
          : 'Capture router cannot accept routed work.',
    },
    {
      key: 'dispatch_agent_review',
      label: 'Dispatch agent review',
      enabled: canDispatchAgentReview,
      reason: canDispatchAgentReview
        ? 'Gateway, capture router, and agent feed are ready.'
        : 'Gateway, capture router, and agent feed are not all ready.',
    },
  ]

  const controlLevel: OpsOnsiteDiagnosticSessionPlan['control_level'] = canDispatchAgentReview
    ? 'route'
    : screenOk || canRouteWork
      ? 'capture'
      : 'observe'
  const status: OpsOnsiteDiagnosticSessionPlan['status'] =
    canDispatchAgentReview && screenOk ? 'ready' : blockers.length >= 2 ? 'blocked' : 'limited'
  const recommendedEntry: OpsOnsiteDiagnosticActionKey =
    canDispatchAgentReview && screenOk
      ? 'dispatch_agent_review'
      : screenOk
        ? 'capture_desktop_context'
        : canRouteWork
          ? 'route_support_packet'
          : 'capture_field_context'

  return {
    status,
    control_level: controlLevel,
    recommended_entry: recommendedEntry,
    can_capture_desktop: screenOk,
    can_route_work: canRouteWork,
    can_dispatch_agent_review: canDispatchAgentReview,
    blockers,
    actions,
  }
}

function componentByKey(
  components: readonly OpsDiagnosticComponent[],
  key: string,
): OpsDiagnosticComponent | undefined {
  return components.find((component) => component.key === key)
}

function componentBlockers(component: OpsDiagnosticComponent | undefined): string[] {
  if (!component || component.status === 'ok') return []
  return [`${component.label}: ${component.detail}`]
}

async function probeJson(url: string, opts: { fetchImpl: typeof fetch; timeoutMs: number }): Promise<ProbeResult> {
  if (!url) return { status: 'unavailable', latency_ms: null, http_status: null, body: null, error: 'not configured' }
  const controller = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const response = await opts.fetchImpl(url, { signal: controller.signal })
    const latency = Date.now() - started
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'unauthorized', latency_ms: latency, http_status: response.status, body, error: 'unauthorized' }
    }
    if (!response.ok) {
      return {
        status: response.status === 404 ? 'unavailable' : 'error',
        latency_ms: latency,
        http_status: response.status,
        body,
        error: `HTTP ${response.status}`,
      }
    }
    return { status: 'ok', latency_ms: latency, http_status: response.status, body, error: null }
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof Error
          ? err.message
          : 'fetch failed'
    return { status: 'unavailable', latency_ms: Date.now() - started, http_status: null, body: null, error: message }
  } finally {
    clearTimeout(timer)
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) return value.trim()
  }
  return ''
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function readTimeoutMs(): number {
  const parsed = Number(process.env.SITELAYER_OPS_DIAGNOSTICS_TIMEOUT_MS)
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.max(250, Math.min(5000, Math.floor(parsed)))
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function statusValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function statusDetail(probe: ProbeResult): string {
  if (probe.status === 'unavailable')
    return probe.http_status ? `Unavailable: HTTP ${probe.http_status}.` : 'Unavailable.'
  if (probe.status === 'unauthorized') return 'Unauthorized.'
  if (probe.status === 'error') return probe.http_status ? `Error: HTTP ${probe.http_status}.` : 'Probe failed.'
  return 'Probe pending.'
}
