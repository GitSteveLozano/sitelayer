import type http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { isValidUuid } from '../http-utils.js'
import { dispatchChatResponseToMesh } from '../mesh-dispatcher.js'

/**
 * POST /api/ai/chat — operator-context chat staging endpoint.
 *
 * Consumer of the browser-bridge operator-context handshake (see
 * digital-ontology/operator-context-handshake-design.md and the
 * operator-context-chat-widget branch). The widget sets
 * window.__operatorContext from the gateway packet, the operator types a
 * message, this endpoint receives:
 *
 *   { messages: ChatWidgetMessage[], operatorContext: ContextPacket }
 *
 * v0 scope is "log and ack" — the message is written to audit_events
 * for traceability + future LLM-response dispatch. There is NO LLM call
 * in this CL; that wiring lives in a follow-up that consumes the
 * mesh counsel-of-models registry. The widget's chat-widget.ts machine
 * already stages drafts locally; this endpoint persists them so the
 * operator can audit what was asked when.
 *
 * Admin-only at v0 — the widget is rendered exclusively when
 * window.__operatorContext is populated (which only happens for the
 * operator's personal browser profile per rule 12), but defense-in-depth
 * requires server-side role check too.
 */

export type AiChatRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

interface IncomingMessage {
  id?: string
  role?: string
  body?: string
  packet_generated_at?: string
}

interface IncomingPacket {
  subject?: string
  generated_at?: string
  origin?: string
  current_focus?: {
    label?: string
    confidence?: number
  }
  origin_context?: {
    project?: string
    label?: string
    repo_branch?: string | null
  }
}

interface IncomingBody {
  messages?: IncomingMessage[]
  operatorContext?: IncomingPacket
}

interface AuditEventRow {
  id: string
}

const MAX_MESSAGES_PER_REQUEST = 8
const MAX_BODY_BYTES = 4000

function pickLatestOperatorMessage(messages: IncomingMessage[] | undefined): IncomingMessage | null {
  if (!Array.isArray(messages) || !messages.length) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'operator' && typeof m.body === 'string' && m.body.trim()) {
      return m
    }
  }
  return null
}

function looksLikeRegisteredOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  // The control-plane gateway only mints packets for these hosts (see
  // console/gateway/routes/operator-context.js ORIGIN_REGISTRY). Defense
  // in depth: refuse anything else.
  if (origin === 'sitelayer.sandolab.xyz') return true
  if (/\.preview\.sitelayer\.sandolab\.xyz$/.test(origin)) return true
  return false
}

export async function handleAiChatRoutes(req: http.IncomingMessage, url: URL, ctx: AiChatRouteCtx): Promise<boolean> {
  // GET /api/ai/chat/:audit_event_id/response — poll for the LLM
  // response that a downstream worker (mesh keeper or sitelayer-local
  // dispatcher) will eventually write as a sibling audit_events row.
  // The widget's chat-widget machine consumes this to flip a staged
  // message into 'responded'. Returns 200 when a response row exists,
  // 202 when staged but no response yet, 404 when the audit_event_id
  // doesn't exist for this company.
  const responseMatch = url.pathname.match(/^\/api\/ai\/chat\/([^/]+)\/response$/)
  if (req.method === 'GET' && responseMatch) {
    return handleAiChatResponsePoll(ctx, responseMatch[1]!)
  }

  // POST /api/ai/chat/:audit_event_id/respond — webhook the mesh-side
  // subscription-CLI runner POSTs its generated chat response to.
  // Bearer-authed via SITELAYER_CHAT_WEBHOOK_TOKEN. Public per the
  // dispatcher's prompt — the runner reaches us at SITELAYER_PUBLIC_BASE.
  const respondMatch = url.pathname.match(/^\/api\/ai\/chat\/([^/]+)\/respond$/)
  if (req.method === 'POST' && respondMatch) {
    return handleAiChatRespondWebhook(req, ctx, respondMatch[1]!)
  }

  if (!(req.method === 'POST' && url.pathname === '/api/ai/chat')) return false

  if (!ctx.requireRole(['admin'])) return true

  let body: IncomingBody
  try {
    body = (await ctx.readBody()) as IncomingBody
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return true
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    ctx.sendJson(400, { error: 'messages array is required and non-empty' })
    return true
  }
  if (body.messages.length > MAX_MESSAGES_PER_REQUEST) {
    ctx.sendJson(400, {
      error: `messages capped at ${MAX_MESSAGES_PER_REQUEST}; trim history before sending`,
    })
    return true
  }

  const latest = pickLatestOperatorMessage(body.messages)
  if (!latest || !latest.body) {
    ctx.sendJson(400, { error: 'no operator-role message with body found' })
    return true
  }
  if (latest.body.length > MAX_BODY_BYTES) {
    ctx.sendJson(413, {
      error: `message body exceeds ${MAX_BODY_BYTES} chars; trim before sending`,
    })
    return true
  }

  const packet = body.operatorContext
  if (!packet || !looksLikeRegisteredOrigin(packet.origin)) {
    ctx.sendJson(400, {
      error: 'operatorContext.origin missing or not in the registered allowlist',
    })
    return true
  }

  // Persist as audit_events so the operator's recent activity surface and
  // any future LLM-response dispatcher can pick this up.
  const auditPayload = {
    chat_message: {
      role: 'operator',
      body: latest.body,
      message_id: typeof latest.id === 'string' ? latest.id : null,
      packet_generated_at: typeof latest.packet_generated_at === 'string' ? latest.packet_generated_at : null,
    },
    operator_context: {
      origin: packet.origin,
      project: packet.origin_context?.project ?? null,
      focus_label: packet.current_focus?.label ?? null,
      focus_confidence: typeof packet.current_focus?.confidence === 'number' ? packet.current_focus.confidence : null,
      repo_branch: packet.origin_context?.repo_branch ?? null,
      generated_at: packet.generated_at ?? null,
    },
  }

  const audit = await withMutationTx(async (client: PoolClient) => {
    const result = await client.query<AuditEventRow>(
      `insert into audit_events
         (company_id, actor_user_id, actor_role, entity_type, entity_id, action, before, after)
       values ($1, $2, 'admin', 'ai_chat', null, 'stage_message', null, $3)
       returning id`,
      [ctx.company.id, ctx.currentUserId, JSON.stringify(auditPayload)],
    )
    const row = result.rows[0]
    if (!row) return null
    await recordMutationLedger(client, {
      companyId: ctx.company.id,
      entityType: 'ai_chat',
      entityId: row.id,
      action: 'stage_message',
      row: { id: row.id, ...auditPayload },
      actorUserId: ctx.currentUserId,
    })
    return row
  })

  if (!audit) {
    ctx.sendJson(500, { error: 'failed to persist chat message' })
    return true
  }

  // Path A (subscription-CLI only, no metered API key): enqueue a mesh
  // task that an existing Claude/Codex CLI runner picks up and uses to
  // POST the response back to /api/ai/chat/:audit_event_id/respond.
  // See digital-ontology/operator-action-triage-2026-05-21.md §5.
  //
  // Best-effort: if mesh is unreachable we still return 202 staged so
  // the widget shows the message persisted; the operator can re-dispatch
  // manually or the planned mesh-side keeper picks up unhandled audit
  // rows on its next tick.
  const dispatch = await dispatchChatResponseToMesh({
    auditEventId: audit.id,
    companyId: ctx.company.id,
    message: latest.body,
    operatorContext: auditPayload.operator_context,
  })

  ctx.sendJson(202, {
    status: 'staged',
    audit_event_id: audit.id,
    response_pending: true,
    mesh_task_id: dispatch.ok ? dispatch.mesh_task_id : null,
    dispatch_error: dispatch.ok ? null : dispatch.error,
    followup_hint:
      'Subscription-CLI dispatch enqueued. Widget should poll GET /api/ai/chat/:audit_event_id/response; mesh CLI runner writes the respond_message audit row via the webhook.',
  })
  return true
}

interface ResponseRow {
  id: string
  after: unknown
  created_at: Date | string
}

/**
 * Handles GET /api/ai/chat/:audit_event_id/response. Returns:
 *   200 + { status: 'responded', response_audit_event_id, body, raw }
 *     when a sibling audit_events row exists with action='respond_message'
 *     whose after.parent_audit_event_id matches the staged message id;
 *   202 + { status: 'staged', response_pending: true } when the staged
 *     message exists but no response has been written yet;
 *   404 when no staged message exists for this company.
 *
 * The response-writer (mesh keeper or sitelayer-local dispatcher) is
 * intentionally out-of-band: this endpoint is a pure read surface so
 * the widget polling loop works regardless of which dispatch path
 * actually wins.
 */
async function handleAiChatResponsePoll(ctx: AiChatRouteCtx, rawId: string): Promise<boolean> {
  if (!ctx.requireRole(['admin'])) return true
  const auditId = String(rawId || '').trim()
  if (!isValidUuid(auditId)) {
    ctx.sendJson(400, { error: 'audit_event_id must be a valid uuid' })
    return true
  }

  // 1. Confirm the staged message exists for this company. The route
  //    refuses to leak cross-company chat state — both the original
  //    stage_message row AND any response row are company-scoped.
  const staged = await withCompanyClient(ctx.company.id, (c) =>
    c.query<{ id: string }>(
      `select id from audit_events
        where company_id = $1
          and id = $2
          and entity_type = 'ai_chat'
          and action = 'stage_message'
        limit 1`,
      [ctx.company.id, auditId],
    ),
  )
  if (!staged.rows.length) {
    ctx.sendJson(404, { error: 'staged chat message not found for this company' })
    return true
  }

  // 2. Look for the sibling response. The response writer is expected
  //    to insert an audit_events row with action='respond_message' and
  //    after.parent_audit_event_id = <auditId>. The (companyId, action)
  //    index keeps this cheap; the parent-id match is in-memory because
  //    after is JSONB and the parent pointer lives inside it.
  const responses = await withCompanyClient(ctx.company.id, (c) =>
    c.query<ResponseRow>(
      `select id, after, created_at
         from audit_events
        where company_id = $1
          and entity_type = 'ai_chat'
          and action = 'respond_message'
          and after->>'parent_audit_event_id' = $2
        order by created_at desc
        limit 1`,
      [ctx.company.id, auditId],
    ),
  )
  if (!responses.rows.length) {
    ctx.sendJson(202, {
      status: 'staged',
      audit_event_id: auditId,
      response_pending: true,
      followup_hint:
        'No response audit_events row yet. The response writer (mesh keeper or sitelayer dispatcher) inserts an audit_events row with action=respond_message + after.parent_audit_event_id = staged id; this endpoint flips to 200 once that lands.',
    })
    return true
  }

  const row = responses.rows[0]!
  const after = (row.after ?? {}) as Record<string, unknown>
  const body = typeof after.body === 'string' ? after.body : null
  ctx.sendJson(200, {
    status: 'responded',
    audit_event_id: auditId,
    response_audit_event_id: row.id,
    body,
    raw: after,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  })
  return true
}

interface WebhookBody {
  body?: string
  model?: string
}

/**
 * Handles POST /api/ai/chat/:audit_event_id/respond. The mesh-side
 * subscription-CLI runner POSTs here with the generated response. We
 * land a sibling audit_events row with action='respond_message' +
 * after.parent_audit_event_id, which the widget's polling GET
 * endpoint then surfaces.
 *
 * Auth: Bearer token from env SITELAYER_CHAT_WEBHOOK_TOKEN. The mesh
 * task prompt instructs the runner to use $SITELAYER_CHAT_WEBHOOK_TOKEN;
 * mesh sets that env on the runner via the standard secret-injection
 * path. No body-signing yet (operator can rotate token if needed).
 *
 * Company scoping: the audit_event_id maps to exactly one company via
 * the staged audit_events row. The webhook does not accept a company
 * from the caller — it derives it from the staged row so a leaked token
 * can't write responses against the wrong company.
 */
async function handleAiChatRespondWebhook(
  req: http.IncomingMessage,
  ctx: AiChatRouteCtx,
  rawId: string,
): Promise<boolean> {
  const expected = process.env.SITELAYER_CHAT_WEBHOOK_TOKEN?.trim() || ''
  if (!expected) {
    ctx.sendJson(503, { error: 'webhook disabled (SITELAYER_CHAT_WEBHOOK_TOKEN not configured)' })
    return true
  }
  const authHeader =
    typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : ''
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!presented) {
    ctx.sendJson(401, { error: 'missing bearer token' })
    return true
  }
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    ctx.sendJson(401, { error: 'invalid bearer token' })
    return true
  }

  const auditId = String(rawId || '').trim()
  if (!isValidUuid(auditId)) {
    ctx.sendJson(400, { error: 'audit_event_id must be a valid uuid' })
    return true
  }

  let body: WebhookBody
  try {
    body = (await ctx.readBody()) as WebhookBody
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return true
  }
  const responseBody = typeof body.body === 'string' ? body.body.trim() : ''
  if (!responseBody) {
    ctx.sendJson(400, { error: 'body field is required and non-empty' })
    return true
  }
  if (responseBody.length > 8000) {
    ctx.sendJson(413, { error: 'response body exceeds 8000 chars; trim before sending' })
    return true
  }
  const model = typeof body.model === 'string' ? body.model.slice(0, 200) : ''

  // Resolve the staged row to find its company_id. The runner can hit
  // us from anywhere; we trust the audit_event_id lookup, not the
  // runner's claim about which company this belongs to.
  const staged = await ctx.pool.query<{ id: string; company_id: string }>(
    `select id, company_id from audit_events
      where id = $1
        and entity_type = 'ai_chat'
        and action = 'stage_message'
      limit 1`,
    [auditId],
  )
  if (!staged.rows.length) {
    ctx.sendJson(404, { error: 'staged chat message not found for this audit_event_id' })
    return true
  }
  const stagedRow = staged.rows[0]!

  const respondPayload = {
    body: responseBody,
    model,
    parent_audit_event_id: auditId,
    responded_at: new Date().toISOString(),
  }

  const responseAudit = await withMutationTx(async (client: PoolClient) => {
    const result = await client.query<AuditEventRow>(
      `insert into audit_events
         (company_id, actor_user_id, actor_role, entity_type, entity_id, action, before, after)
       values ($1, $2, 'agent', 'ai_chat', null, 'respond_message', null, $3)
       returning id`,
      [stagedRow.company_id, null, JSON.stringify(respondPayload)],
    )
    const row = result.rows[0]
    if (!row) return null
    await recordMutationLedger(client, {
      companyId: stagedRow.company_id,
      entityType: 'ai_chat',
      entityId: row.id,
      action: 'respond_message',
      row: { id: row.id, ...respondPayload },
      actorUserId: null,
    })
    return row
  })

  if (!responseAudit) {
    ctx.sendJson(500, { error: 'failed to persist response audit row' })
    return true
  }

  ctx.sendJson(201, {
    status: 'recorded',
    response_audit_event_id: responseAudit.id,
    parent_audit_event_id: auditId,
  })
  return true
}
