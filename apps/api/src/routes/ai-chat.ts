import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'

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

  // v0 ack: no LLM response yet. The widget's chat-widget.ts machine
  // displays the staged message; this endpoint confirms the durable
  // write. A follow-up wires the actual LLM dispatch (likely via the
  // mesh counsel-of-models registry's operator_assistant class, which
  // names Claude Haiku as the primary lane).
  ctx.sendJson(202, {
    status: 'staged',
    audit_event_id: audit.id,
    response_pending: true,
    followup_hint: 'v0 stages the message; LLM response will land via a future audit_events row.',
  })
  return true
}
