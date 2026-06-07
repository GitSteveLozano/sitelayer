import type http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { PermissionAction } from '@sitelayer/domain'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { isValidUuid, parseJsonBody } from '../http-utils.js'
import { dispatchVoiceIntentToMesh, isAiChatEnabled } from '../mesh-dispatcher.js'
import { wrapUntrusted } from '../untrusted-content.js'

/**
 * Voice-driven project setup (v1) — voice PROPOSES, the human CONFIRMS.
 *
 * The new-project flow can capture a spoken transcript ("new project called
 * Maple Ridge for Acme, scaffold and concrete divisions") in the browser via
 * the Web Speech API. This route turns that transcript into a set of *proposed*
 * project fields the form pre-fills; it NEVER creates a project. The mandatory
 * confirm step is the existing POST /api/projects, tapped by the human after
 * reviewing/editing the prefill.
 *
 * AI path: identical to the operator-context chat — the transcript is handed to
 * the operator's private mesh (MESH_API_URL, Tailnet-only) via a subscription-
 * CLI task; there is NO new LLM client or key. The mesh CLI runner POSTs the
 * parsed JSON back to the respond webhook below, and the web polls the GET
 * endpoint until the parse lands.
 *
 * Gating (identical to the create-project path PLUS the AI gate):
 *   - role: admin/office, then the create_project named-action permission;
 *   - AI: isAiChatEnabled() (MESH_API_URL / AI_CHAT_ENABLED). When AI is
 *     disabled the route returns the SAME calm 200 {status:'disabled'} shape the
 *     ai-chat path uses — no audit row, no dispatch — so a non-operator instance
 *     no-ops cleanly and the web hides the mic.
 *
 * Untrusted input: the transcript is user speech, treated as untrusted content
 * and wrapped via the shared wrapUntrusted() injection-defense before it reaches
 * the model prompt.
 */

const VoiceIntentBodySchema = z
  .object({
    transcript: z.string().optional(),
  })
  .loose()

const VoiceIntentRespondBodySchema = z
  .object({
    // The runner posts the parsed fields here. Permissive: the server-side
    // parser (parseProposedFields) re-validates and shapes everything, so the
    // wire schema only asserts the top-level container exists.
    fields: z.unknown().optional(),
    model: z.string().nullish(),
  })
  .loose()

export type VoiceIntentRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  requirePermission: (action: PermissionAction, opts?: { amountCents?: number; otHours?: number }) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

interface AuditEventRow {
  id: string
}

// Mirror the operator-chat caps: a single spoken instruction is short, so the
// transcript cap is tighter than the chat-message cap. Roster lookup is bounded
// so a huge customer list can't bloat the prompt.
const MAX_TRANSCRIPT_BYTES = 1200
const MAX_ROSTER_NAMES = 200
const VALID_DIVISION_CODES = ['D1', 'D2', 'D3', 'D4', 'D5'] as const

/**
 * The proposed-fields shape the web pre-fills the form with. This is what the
 * GET poll endpoint returns once the parse lands. `customer.match` lets the UI
 * decide whether to attempt the dedup link ('existing') or treat it as a fresh
 * customer name ('new'); the human can override either way before Create.
 */
export interface ProposedProjectFields {
  name: string | null
  customer: { match: 'existing' | 'new'; name: string | null }
  divisions: string[]
  division_code: string | null
}

/**
 * Parse + shape the model's JSON back into the proposed-fields contract. Defends
 * against any shape the runner might emit (missing keys, wrong types, extra
 * fields): only the documented fields survive, strings are trimmed + capped,
 * and divisions are de-duped. `division_code` is a best-effort map from the
 * heard free-text division names onto a valid Dn code, surfaced as a SUGGESTION
 * only (the form's division <select> still defaults to D4 and the human picks).
 *
 * Exported for the dispatcher's prompt to stay in sync and for unit testing.
 */
export function parseProposedFields(raw: unknown): ProposedProjectFields {
  const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>

  const name = trimToNull(obj.name, 200)

  const customerObj = obj.customer && typeof obj.customer === 'object' ? (obj.customer as Record<string, unknown>) : {}
  const customerName = trimToNull(customerObj.name, 200)
  const match = customerObj.match === 'existing' ? 'existing' : 'new'

  const divisionsRaw = Array.isArray(obj.divisions) ? obj.divisions : []
  const seen = new Set<string>()
  const divisions: string[] = []
  for (const d of divisionsRaw) {
    const v = trimToNull(d, 80)
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    divisions.push(v)
    if (divisions.length >= 12) break
  }

  return {
    name,
    customer: { match, name: customerName },
    divisions,
    division_code: suggestDivisionCode(divisions),
  }
}

function trimToNull(value: unknown, cap: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim().slice(0, cap)
  return t.length > 0 ? t : null
}

/**
 * Best-effort map of heard trade/division words onto a valid Dn code. Pure
 * keyword heuristic — deliberately NOT an LLM call (the suggestion is a UI nicety
 * and the human picks the real division). Returns null when nothing matches so
 * the form keeps its own default.
 */
const DIVISION_KEYWORDS: ReadonlyArray<{ code: (typeof VALID_DIVISION_CODES)[number]; words: string[] }> = [
  { code: 'D1', words: ['demo', 'demolition', 'site', 'sitework', 'earth', 'excavat'] },
  { code: 'D2', words: ['concrete', 'foundation', 'masonry', 'rebar', 'slab'] },
  { code: 'D3', words: ['scaffold', 'scaffolding', 'shoring', 'frame', 'framing', 'steel'] },
  { code: 'D4', words: ['drywall', 'finish', 'paint', 'interior', 'taping'] },
  { code: 'D5', words: ['roof', 'roofing', 'exterior', 'cladding', 'siding'] },
]

function suggestDivisionCode(divisions: string[]): string | null {
  for (const phrase of divisions) {
    const lower = phrase.toLowerCase()
    for (const { code, words } of DIVISION_KEYWORDS) {
      if (words.some((w) => lower.includes(w))) return code
    }
  }
  return null
}

export async function handleVoiceIntentRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: VoiceIntentRouteCtx,
): Promise<boolean> {
  // GET /api/projects/voice-intent/:id — poll for the parsed fields. Returns
  // 200 {status:'parsed', proposed} once the runner has written the response
  // row, 202 {status:'pending'} while staged, 404 when the staged row doesn't
  // exist for this company.
  const pollMatch = url.pathname.match(/^\/api\/projects\/voice-intent\/([^/]+)$/)
  if (req.method === 'GET' && pollMatch) {
    return handleVoiceIntentPoll(ctx, pollMatch[1]!)
  }

  // POST /api/projects/voice-intent/:id/respond — the mesh CLI runner posts the
  // parsed JSON here. Bearer-authed via SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN.
  const respondMatch = url.pathname.match(/^\/api\/projects\/voice-intent\/([^/]+)\/respond$/)
  if (req.method === 'POST' && respondMatch) {
    return handleVoiceIntentRespondWebhook(req, ctx, respondMatch[1]!)
  }

  // POST /api/projects/voice-intent — stage a transcript + dispatch the parse.
  if (!(req.method === 'POST' && url.pathname === '/api/projects/voice-intent')) return false

  // Capability/role gating identical to POST /api/projects (admin/office + the
  // create_project named action). Defense in depth: the mic is also UI-gated.
  if (!ctx.requireRole(['admin', 'office'])) return true
  if (!ctx.requirePermission('create_project')) return true

  // AI gate: the only parse path is the mesh hand-off. When AI isn't configured
  // (no mesh access — fresh owner / non-operator instance) we return the SAME
  // calm 200 {status:'disabled'} shape the ai-chat path uses. No audit row, no
  // dispatch — the web hides the mic and the create-project flow is unchanged.
  if (!isAiChatEnabled()) {
    ctx.sendJson(200, {
      status: 'disabled',
      ai_chat_enabled: false,
      reason: 'Voice project setup is not configured on this deployment.',
    })
    return true
  }

  let raw: Record<string, unknown>
  try {
    raw = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return true
  }
  const parsed = parseJsonBody(VoiceIntentBodySchema, raw)
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return true
  }
  const transcript = (parsed.value.transcript ?? '').trim()
  if (!transcript) {
    ctx.sendJson(400, { error: 'transcript is required and non-empty' })
    return true
  }
  if (transcript.length > MAX_TRANSCRIPT_BYTES) {
    ctx.sendJson(413, {
      error: `transcript exceeds ${MAX_TRANSCRIPT_BYTES} chars; shorten before sending`,
    })
    return true
  }

  // Pull the company customer roster so the model can MATCH an existing
  // customer instead of always proposing-new. Bounded.
  const rosterResult = await withCompanyClient(ctx.company.id, (c) =>
    c.query<{ name: string }>(
      `select name from customers
        where company_id = $1 and deleted_at is null
        order by name asc
        limit $2`,
      [ctx.company.id, MAX_ROSTER_NAMES],
    ),
  )
  const customerNames = rosterResult.rows.map((r) => r.name).filter((n): n is string => typeof n === 'string')

  // Persist the staged transcript to audit_events so the parse is auditable and
  // the respond webhook + poll can resolve it. The transcript is UNTRUSTED user
  // speech — record it as data, wrap it for the prompt below.
  const stagePayload = {
    voice_intent: {
      transcript,
      origin: 'project-new',
    },
  }
  const staged = await withMutationTx(async (client: PoolClient) => {
    const result = await client.query<AuditEventRow>(
      `insert into audit_events
         (company_id, actor_user_id, actor_role, entity_type, entity_id, action, before, after)
       values ($1, $2, $3, 'voice_project_intent', null, 'stage_transcript', null, $4)
       returning id`,
      [ctx.company.id, ctx.currentUserId, ctx.company.role, JSON.stringify(stagePayload)],
    )
    const row = result.rows[0]
    if (!row) return null
    await recordMutationLedger(client, {
      companyId: ctx.company.id,
      entityType: 'voice_project_intent',
      entityId: row.id,
      action: 'stage_transcript',
      row: { id: row.id, ...stagePayload },
      actorUserId: ctx.currentUserId,
    })
    return row
  })

  if (!staged) {
    ctx.sendJson(500, { error: 'failed to persist voice transcript' })
    return true
  }

  // The transcript is untrusted user speech — wrap it as a delimited DATA block
  // with the shared injection-defense preamble before it reaches the prompt.
  const untrustedLines = wrapUntrusted([{ label: 'Operator speech transcript', body: transcript }])

  const dispatch = await dispatchVoiceIntentToMesh({
    intentId: staged.id,
    transcript,
    untrustedBlock: untrustedLines.join('\n'),
    customerNames,
    divisionCodes: [...VALID_DIVISION_CODES],
  })

  ctx.sendJson(202, {
    status: 'staged',
    voice_intent_id: staged.id,
    response_pending: true,
    mesh_task_id: dispatch.ok ? dispatch.mesh_task_id : null,
    dispatch_error: dispatch.ok ? null : dispatch.error,
    followup_hint:
      'Voice parse enqueued. Poll GET /api/projects/voice-intent/:id; the mesh CLI runner writes the parsed fields back via the respond webhook.',
  })
  return true
}

interface ResponseRow {
  id: string
  after: unknown
  created_at: Date | string
}

/**
 * GET /api/projects/voice-intent/:id — read-only poll surface. Same role gate
 * as the stage path. Company-scoped both ways so a leaked id can't surface
 * another tenant's transcript or parse.
 */
async function handleVoiceIntentPoll(ctx: VoiceIntentRouteCtx, rawId: string): Promise<boolean> {
  if (!ctx.requireRole(['admin', 'office'])) return true
  const intentId = String(rawId || '').trim()
  if (!isValidUuid(intentId)) {
    ctx.sendJson(400, { error: 'voice_intent_id must be a valid uuid' })
    return true
  }

  const staged = await withCompanyClient(ctx.company.id, (c) =>
    c.query<{ id: string }>(
      `select id from audit_events
        where company_id = $1
          and id = $2
          and entity_type = 'voice_project_intent'
          and action = 'stage_transcript'
        limit 1`,
      [ctx.company.id, intentId],
    ),
  )
  if (!staged.rows.length) {
    ctx.sendJson(404, { error: 'staged voice intent not found for this company' })
    return true
  }

  const responses = await withCompanyClient(ctx.company.id, (c) =>
    c.query<ResponseRow>(
      `select id, after, created_at
         from audit_events
        where company_id = $1
          and entity_type = 'voice_project_intent'
          and action = 'parse_result'
          and after->>'parent_intent_id' = $2
        order by created_at desc
        limit 1`,
      [ctx.company.id, intentId],
    ),
  )
  if (!responses.rows.length) {
    ctx.sendJson(202, {
      status: 'pending',
      voice_intent_id: intentId,
      response_pending: true,
      followup_hint:
        'No parse result yet. The mesh CLI runner posts the parsed fields to the respond webhook; this endpoint flips to 200 once that lands.',
    })
    return true
  }

  const row = responses.rows[0]!
  const after = (row.after ?? {}) as Record<string, unknown>
  ctx.sendJson(200, {
    status: 'parsed',
    voice_intent_id: intentId,
    parse_audit_event_id: row.id,
    proposed: after.proposed ?? null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  })
  return true
}

interface WebhookBody {
  fields?: unknown
  model?: string
}

/**
 * POST /api/projects/voice-intent/:id/respond — the mesh CLI runner posts the
 * parsed JSON here. Bearer-authed via SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN
 * (timing-safe compare). Company is derived from the staged row, never the
 * caller, so a leaked token can't write a parse against the wrong tenant.
 *
 * The posted `fields` are re-validated + shaped by parseProposedFields before
 * persistence — the model output is itself untrusted, so the server pins the
 * proposed-fields contract rather than trusting the runner's JSON verbatim.
 */
async function handleVoiceIntentRespondWebhook(
  req: http.IncomingMessage,
  ctx: VoiceIntentRouteCtx,
  rawId: string,
): Promise<boolean> {
  const expected = process.env.SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN?.trim() || ''
  if (!expected) {
    ctx.sendJson(503, { error: 'webhook disabled (SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN not configured)' })
    return true
  }
  const authHeader = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : ''
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

  const intentId = String(rawId || '').trim()
  if (!isValidUuid(intentId)) {
    ctx.sendJson(400, { error: 'voice_intent_id must be a valid uuid' })
    return true
  }

  let raw: Record<string, unknown>
  try {
    raw = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return true
  }
  const parsedBody = parseJsonBody(VoiceIntentRespondBodySchema, raw)
  if (!parsedBody.ok) {
    ctx.sendJson(400, { error: parsedBody.error })
    return true
  }
  const body = parsedBody.value as WebhookBody
  const proposed = parseProposedFields(body.fields)
  const model = typeof body.model === 'string' ? body.model.slice(0, 200) : ''

  // Resolve the staged row to find its company_id. Trust the id lookup, not the
  // runner's claim about which company this belongs to.
  const staged = await ctx.pool.query<{ id: string; company_id: string }>(
    `select id, company_id from audit_events
      where id = $1
        and entity_type = 'voice_project_intent'
        and action = 'stage_transcript'
      limit 1`,
    [intentId],
  )
  if (!staged.rows.length) {
    ctx.sendJson(404, { error: 'staged voice intent not found for this voice_intent_id' })
    return true
  }
  const stagedRow = staged.rows[0]!

  const resultPayload = {
    proposed,
    model,
    parent_intent_id: intentId,
    parsed_at: new Date().toISOString(),
  }

  const resultAudit = await withMutationTx(async (client: PoolClient) => {
    const result = await client.query<AuditEventRow>(
      `insert into audit_events
         (company_id, actor_user_id, actor_role, entity_type, entity_id, action, before, after)
       values ($1, $2, 'agent', 'voice_project_intent', null, 'parse_result', null, $3)
       returning id`,
      [stagedRow.company_id, null, JSON.stringify(resultPayload)],
    )
    const row = result.rows[0]
    if (!row) return null
    await recordMutationLedger(client, {
      companyId: stagedRow.company_id,
      entityType: 'voice_project_intent',
      entityId: row.id,
      action: 'parse_result',
      row: { id: row.id, ...resultPayload },
      actorUserId: null,
    })
    return row
  })

  if (!resultAudit) {
    ctx.sendJson(500, { error: 'failed to persist parse result' })
    return true
  }

  ctx.sendJson(201, {
    status: 'recorded',
    parse_audit_event_id: resultAudit.id,
    parent_intent_id: intentId,
  })
  return true
}
