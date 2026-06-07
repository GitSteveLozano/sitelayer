// mesh-dispatcher.ts — sitelayer → mesh task hand-off for operator-context
// chat responses.
//
// Constraint (operator, 2026-05-21): every LLM call goes through a
// subscription CLI. No metered API keys. This module enqueues a mesh
// task whose execution_context contains the operator's message + the
// operator-context packet + a webhook URL where the CLI runner can
// POST the generated response back to sitelayer.
//
// The mesh-side counsel-of-models registry routes the task to the
// "operator_assistant" class (primary lane: Claude). The CLI runner
// receives the prompt + writes its result by hitting the webhook
// at POST /api/ai/chat/:audit_event_id/respond on this sitelayer
// instance, which lands the response as a sibling audit_events row
// that the widget's poll endpoint picks up.
//
// Design doc: digital-ontology/operator-action-triage-2026-05-21.md §5
// (revised: Path A only, Path B rejected for violating subscription-
// only doctrine).

interface DispatchInput {
  auditEventId: string
  companyId: string
  message: string
  operatorContext: {
    origin?: string | undefined
    project?: string | null | undefined
    focus_label?: string | null | undefined
    focus_confidence?: number | null | undefined
    repo_branch?: string | null | undefined
    generated_at?: string | null | undefined
  }
}

export interface MeshDispatchResult {
  ok: boolean
  mesh_task_id?: string
  error?: string
}

const DEFAULT_TIMEOUT_MS = 3000

/**
 * Single feature gate for the in-app operator AI chat.
 *
 * The chat's only response path is a hand-off to the operator's private
 * mesh (`MESH_API_URL`, reachable ONLY inside Taylor's Tailnet) plus a
 * shared-secret callback webhook (`SITELAYER_CHAT_WEBHOOK_TOKEN`). A
 * sitelayer instance with no mesh access (a fresh owner, any non-operator
 * deployment) has neither, so every staged message would otherwise hang
 * for ~60s and the operator could only re-poll into the same dead end.
 *
 * To make that cleanly feature-flaggable OFF we resolve a single boolean:
 *
 *   - `AI_CHAT_ENABLED` is the explicit override. `0`/`false`/`off`/`no`
 *     forces the chat OFF even when mesh env is present; `1`/`true`/`on`/
 *     `yes` forces it ON (the route still surfaces a calm dispatch error
 *     if the mesh hand-off later fails, but it is "configured").
 *   - When `AI_CHAT_ENABLED` is unset, a non-empty `MESH_API_URL` is
 *     treated as the implicit enable signal (preserves current behavior
 *     for the operator's own deployment, which sets it).
 *
 * Disabled ⇒ the route answers a structured "AI chat not configured"
 * (no audit row, no doomed poll loop, no repeated error logs) and the web
 * widget hides its composer.
 */
export function isAiChatEnabled(): boolean {
  const explicit = process.env.AI_CHAT_ENABLED?.trim().toLowerCase()
  if (explicit !== undefined && explicit !== '') {
    if (explicit === '0' || explicit === 'false' || explicit === 'off' || explicit === 'no') return false
    if (explicit === '1' || explicit === 'true' || explicit === 'on' || explicit === 'yes') return true
    // Unrecognized value: fall through to the implicit env signal rather
    // than guessing — a typo shouldn't silently force the chat on.
  }
  return Boolean(process.env.MESH_API_URL?.trim())
}

function buildChatPrompt(input: DispatchInput, webhookUrl: string): string {
  const ctx = input.operatorContext
  return [
    `You are responding to an operator-context chat message staged in sitelayer.`,
    ``,
    `Operator context:`,
    `- origin: ${ctx.origin ?? 'unknown'}`,
    `- project: ${ctx.project ?? 'unknown'}`,
    `- focus: ${ctx.focus_label ?? 'unknown'} (confidence ${ctx.focus_confidence ?? 'unknown'})`,
    `- branch: ${ctx.repo_branch ?? 'unknown'}`,
    `- packet generated_at: ${ctx.generated_at ?? 'unknown'}`,
    ``,
    `Operator's message:`,
    `> ${input.message.replace(/\n/g, '\n> ')}`,
    ``,
    `Write a concise, grounded response. Keep it under 600 chars unless the operator clearly needs more.`,
    ``,
    `When done, POST your response body to ${webhookUrl} with header`,
    `Authorization: Bearer $SITELAYER_CHAT_WEBHOOK_TOKEN (provided by mesh)`,
    `Body: {"body": "<your response>", "model": "<model id you used>"}`,
    `On 200 / 201 / 202: complete the task.`,
    `On 4xx: fail_task with the response body (operator will see in audit log).`,
  ].join('\n')
}

/**
 * Enqueue a mesh task to generate the chat response via subscription
 * CLI. Returns the mesh task ID on success. Does NOT wait for the
 * response — the widget polls the GET endpoint separately.
 *
 * Mesh API URL comes from `MESH_API_URL` env. The webhook target URL
 * comes from `SITELAYER_PUBLIC_BASE` env so the runner (which lives on
 * a worker host, NOT inside sitelayer's Caddy) can reach us via the
 * public hostname. Both env vars are required in production.
 */
export async function dispatchChatResponseToMesh(input: DispatchInput): Promise<MeshDispatchResult> {
  const meshApi = process.env.MESH_API_URL?.trim() || ''
  if (!meshApi) {
    return { ok: false, error: 'MESH_API_URL not configured' }
  }
  const publicBase = process.env.SITELAYER_PUBLIC_BASE?.trim() || ''
  if (!publicBase) {
    return { ok: false, error: 'SITELAYER_PUBLIC_BASE not configured' }
  }

  const webhookUrl = `${publicBase.replace(/\/+$/, '')}/api/ai/chat/${input.auditEventId}/respond`
  const prompt = buildChatPrompt(input, webhookUrl)

  const body = {
    subject: `Operator chat response (${input.operatorContext.project ?? 'unknown'})`,
    description: prompt,
    project_name: 'sitelayer',
    priority: 'A',
    requested_model: 'claude',
    auto_dispatch: true,
    tags: 'auto:operator-chat-response:sitelayer',
    created_by: `sitelayer:audit:${input.auditEventId}`,
    execution_context: {
      project_hint: 'sitelayer',
      operator_chat: {
        audit_event_id: input.auditEventId,
        company_id: input.companyId,
        webhook_url: webhookUrl,
        operator_context: input.operatorContext,
      },
    },
  }

  return postMeshTask(meshApi, body)
}

/**
 * POST a task body to mesh `/api/tasks`, returning the task id. Shared by the
 * operator-chat and voice-intent dispatchers so the abort-timeout + error
 * shaping live in one place.
 */
async function postMeshTask(meshApi: string, body: unknown): Promise<MeshDispatchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(`${meshApi.replace(/\/+$/, '')}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, error: `mesh /api/tasks ${response.status}: ${text.slice(0, 200)}` }
    }
    const json = (await response.json()) as { id?: number | string }
    if (!json.id) {
      return { ok: false, error: 'mesh response missing task id' }
    }
    return { ok: true, mesh_task_id: String(json.id) }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'mesh dispatch failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

interface VoiceIntentDispatchInput {
  /** The voice_project_intent audit_events row id the runner reports back against. */
  intentId: string
  /** The (untrusted) speech transcript to parse. Already length-capped by the route. */
  transcript: string
  /** Wrapped, injection-defended transcript block (from wrapUntrusted). */
  untrustedBlock: string
  /** Existing company customer roster names, so the model can match instead of always proposing-new. */
  customerNames: string[]
  /** Valid division codes on this company's projects (e.g. D1..D5). */
  divisionCodes: string[]
}

/**
 * Build the parse prompt for the mesh CLI runner. The (untrusted) transcript is
 * embedded as a clearly-delimited DATA block via wrapUntrusted at the call site;
 * the JSON contract below is mirrored by the server-side parser
 * (routes/voice-intent.ts parseProposedFields) so the wire shape has one source
 * of truth.
 */
function buildVoiceIntentPrompt(input: VoiceIntentDispatchInput, webhookUrl: string): string {
  const roster = input.customerNames.length
    ? input.customerNames.map((n) => `- ${n}`).join('\n')
    : '(no existing customers on file)'
  const divisions = input.divisionCodes.length ? input.divisionCodes.join(', ') : 'D1, D2, D3, D4, D5'
  return [
    `You are parsing a spoken instruction to PRE-FILL (never create) a new construction project in sitelayer.`,
    `Extract structured fields from the operator's speech. A human will review and edit every field before`,
    `anything is created — your job is a best-effort proposal, not a commitment.`,
    ``,
    `Existing customers on file (match against these by name when the speech clearly refers to one;`,
    `otherwise propose a NEW customer — never invent a match):`,
    roster,
    ``,
    `Valid division codes: ${divisions}.`,
    ``,
    input.untrustedBlock,
    ``,
    `Return ONLY a single JSON object (no prose, no markdown fence) with this exact shape:`,
    `{`,
    `  "name": string | null,                // proposed project name, or null if not stated`,
    `  "customer": {`,
    `    "match": "existing" | "new",        // "existing" only if it clearly matches a name above`,
    `    "name": string | null               // the matched existing name, or the proposed new customer name`,
    `  },`,
    `  "divisions": string[]                  // free-text division/trade names heard (e.g. ["scaffold","concrete"])`,
    `}`,
    `Use null / [] for anything not stated. Do not include any field not listed above.`,
    ``,
    `When done, POST the JSON to ${webhookUrl} with header`,
    `Authorization: Bearer $SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN (provided by mesh)`,
    `Body: {"fields": <the JSON object above>, "model": "<model id you used>"}`,
    `On 200 / 201 / 202: complete the task. On 4xx: fail_task with the response body.`,
  ].join('\n')
}

/**
 * Enqueue a mesh task to parse a voice transcript into proposed project fields
 * via the subscription-CLI path. Mirrors dispatchChatResponseToMesh: best-effort,
 * does NOT wait for the parse — the web polls the GET endpoint separately, and
 * the runner posts its JSON back to the voice-intent respond webhook.
 *
 * Same env contract as the chat path: MESH_API_URL (mesh task target) +
 * SITELAYER_PUBLIC_BASE (the public hostname the off-host runner posts back to).
 */
export async function dispatchVoiceIntentToMesh(input: VoiceIntentDispatchInput): Promise<MeshDispatchResult> {
  const meshApi = process.env.MESH_API_URL?.trim() || ''
  if (!meshApi) {
    return { ok: false, error: 'MESH_API_URL not configured' }
  }
  const publicBase = process.env.SITELAYER_PUBLIC_BASE?.trim() || ''
  if (!publicBase) {
    return { ok: false, error: 'SITELAYER_PUBLIC_BASE not configured' }
  }

  const webhookUrl = `${publicBase.replace(/\/+$/, '')}/api/projects/voice-intent/${input.intentId}/respond`
  const prompt = buildVoiceIntentPrompt(input, webhookUrl)

  const body = {
    subject: `Voice → project-setup parse (sitelayer)`,
    description: prompt,
    project_name: 'sitelayer',
    priority: 'A',
    requested_model: 'claude',
    auto_dispatch: true,
    tags: 'auto:voice-project-intent:sitelayer',
    created_by: `sitelayer:voice-intent:${input.intentId}`,
    execution_context: {
      project_hint: 'sitelayer',
      voice_project_intent: {
        intent_id: input.intentId,
        webhook_url: webhookUrl,
      },
    },
  }

  return postMeshTask(meshApi, body)
}
