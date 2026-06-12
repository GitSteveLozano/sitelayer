import type http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { Capability } from '@sitelayer/domain'
import type { ActiveCompany } from '../auth-types.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'

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
  }
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

const DEFAULT_TIMEOUT_MS = 900
const SESSION_TTL_MS = 60 * 60 * 1000
const MAX_ACTIVE_SESSIONS = 100
const APP_ISSUE_VIEW: Capability = 'app_issue.view'
const APP_ISSUE_CAPTURE: Capability = 'app_issue.capture'

type StoredOnsiteDiagnosticSession = OpsOnsiteDiagnosticSessionRecord & {
  control_token?: string
  control_token_hash?: string
}

const onsiteDiagnosticSessions = new Map<string, StoredOnsiteDiagnosticSession>()

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

function diagnosticsOptions(ctx: OpsDiagnosticsRouteCtx): Parameters<typeof buildOpsDiagnostics>[0] {
  const options: Parameters<typeof buildOpsDiagnostics>[0] = {
    timeoutMs: readTimeoutMs(),
    gatewayDiagnosticsUrl: firstNonEmpty(
      process.env.SITELAYER_OPS_GATEWAY_DIAGNOSTICS_URL,
      process.env.CONSOLE_GATEWAY_DIAGNOSTICS_URL,
      'http://127.0.0.1:4356/api/diagnostics',
    ),
    screenCaptureUrl: firstNonEmpty(process.env.SITELAYER_OPS_SCREEN_CAPTURE_URL, 'http://127.0.0.1:4357'),
    captureRouterUrl: firstNonEmpty(process.env.SITELAYER_OPS_CAPTURE_ROUTER_URL, 'http://127.0.0.1:8814'),
  }
  if (ctx.fetchImpl) options.fetchImpl = ctx.fetchImpl
  return options
}

export async function buildOpsDiagnostics(
  opts: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    gatewayDiagnosticsUrl?: string
    screenCaptureUrl?: string
    captureRouterUrl?: string
  } = {},
): Promise<OpsDiagnosticsResponse> {
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
    return {
      ok: true,
      value: {
        schema: 'sitelayer.ops_diagnostic_session_action.v1',
        session: publicSession(persisted),
        accepted_action: { key: actionKey, effect: 'audit_only' },
      },
    }
  }

  recordMemoryOnsiteDiagnosticAction(session, actionKey, action.label, actorUserId)
  return {
    ok: true,
    value: {
      schema: 'sitelayer.ops_diagnostic_session_action.v1',
      session: publicSession(session),
      accepted_action: { key: actionKey, effect: 'audit_only' },
    },
  }
}

function recordMemoryOnsiteDiagnosticAction(
  session: StoredOnsiteDiagnosticSession,
  actionKey: OpsOnsiteDiagnosticActionKey,
  actionLabel: string,
  actorUserId: string | null,
): void {
  const at = new Date().toISOString()
  session.audit_events.push({
    id: `event_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
    at,
    actor_user_id: actorUserId,
    type: 'action.requested',
    action_key: actionKey,
    effect: 'audit_only',
    summary: `Requested ${actionLabel}.`,
  })
}

async function recordPersistentOnsiteDiagnosticAction(
  companyId: string,
  session: StoredOnsiteDiagnosticSession,
  actionKey: OpsOnsiteDiagnosticActionKey,
  actionLabel: string,
  actorUserId: string | null,
): Promise<StoredOnsiteDiagnosticSession | null> {
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
  const updated = await withMutationTx(companyId, async (client: PoolClient) => {
    const update = await client.query(
      `update ops_diagnostic_sessions
          set updated_at = $3
        where company_id = $1 and id = $2::uuid and state = 'active' and expires_at > $3`,
      [companyId, session.id, at],
    )
    if (update.rowCount !== 1) return false
    await client.query(
      `insert into ops_diagnostic_session_events (
         id, company_id, session_id, actor_user_id, event_type, action_key, effect, summary, created_at
       ) values ($1, $2, $3, $4, $5, $6, 'audit_only', $7, $8)`,
      [event.id, companyId, session.id, actorUserId, event.type, actionKey, event.summary, at],
    )
    return true
  })
  if (!updated) return null
  return { ...session, audit_events: [...session.audit_events, event] }
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
    return persistentSessionFromRow(row, events)
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
      sessions.push(publicSession(persistentSessionFromRow(row, events)))
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

function persistentSessionFromRow(
  row: PersistentSessionRow,
  events: OpsOnsiteDiagnosticAuditEvent[],
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
    control_token_hash: row.control_token_hash,
  }
}

function publicSession(session: StoredOnsiteDiagnosticSession): OpsOnsiteDiagnosticSessionRecord {
  const { control_token: _controlToken, control_token_hash: _controlTokenHash, ...rest } = session
  return rest
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
  const gatewayOk = gateway?.status === 'ok'
  const screenOk = screenCapture?.status === 'ok' && screenCapture.facts.recording === true
  const routerOk = captureRouter?.status === 'ok'
  const routerHasSink = typeof captureRouter?.facts.sinks === 'string' && captureRouter.facts.sinks.length > 0
  const canRouteWork = routerOk && routerHasSink
  const canDispatchAgentReview = gatewayOk && canRouteWork
  const blockers = [
    ...componentBlockers(gateway),
    ...componentBlockers(screenCapture),
    ...componentBlockers(captureRouter),
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
      reason: canRouteWork ? 'Capture router has an active sink.' : 'Capture router cannot accept routed work.',
    },
    {
      key: 'dispatch_agent_review',
      label: 'Dispatch agent review',
      enabled: canDispatchAgentReview,
      reason: canDispatchAgentReview ? 'Gateway and routing are ready.' : 'Gateway and routing are not both ready.',
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

function statusDetail(probe: ProbeResult): string {
  if (probe.status === 'unavailable')
    return probe.http_status ? `Unavailable: HTTP ${probe.http_status}.` : 'Unavailable.'
  if (probe.status === 'unauthorized') return 'Unauthorized.'
  if (probe.status === 'error') return probe.http_status ? `Error: HTTP ${probe.http_status}.` : 'Probe failed.'
  return 'Probe pending.'
}
