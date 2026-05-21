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
