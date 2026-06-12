import type { Pool, PoolClient } from 'pg'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'

export interface ContextWorkDispatchPayload {
  payload_version?: string | null
  work_item_id: string
  support_packet_id?: string | null
  capture_session_id?: string | null
  title?: string | null
  summary?: string | null
  route?: string | null
  entity_type?: string | null
  entity_id?: string | null
  reversibility_window_seconds?: number | null
  status?: string | null
  lane?: string | null
  support_packet?: unknown
  work_request_brief?: unknown
  agent_brief_markdown?: string | null
  // ADDITIVE projectkit seam: a first-class @operator/projectkit WorkRequest
  // (with the originating Concern embedded) carried next to the
  // context_work_dispatch.v1 fields by the API enqueuer
  // (apps/api/src/routes/work-requests.ts buildDispatchPayload). The worker
  // forwards it untouched into the mesh dispatch body so a subscriber other
  // than mesh could route off the published projectkit shape. Optional +
  // opaque here so in-flight outbox rows without it stay valid.
  dispatch_request?: unknown
  callback?: {
    path?: string | null
    url?: string | null
    token?: string | null
    token_type?: string | null
    expires_at?: string | null
  } | null
}

// Mesh round-trips a numeric reversibility window per task (mesh migration 261).
// Sitelayer's authoritative value is the column on context_work_items
// (sitelayer migration 093); if the payload omits it we fall back to the
// 24h default to stay backward-compatible with in-flight outbox rows.
const DEFAULT_REVERSIBILITY_WINDOW_SECONDS = 86_400
export const CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION = 'sitelayer.context_work_dispatch.v1'

// Mesh routing for the sitelayer implementation lane. Registered in
// control-plane mesh as:
//   - steerer_workflow_id: 'sitelayer_implementation_fan'
//     (claude/sonnet primary, sequential fan, code-work tier)
//   - counsel_class: 'sitelayer_implementation'
//     (claude/sonnet primary, NOT haiku — operator_assistant is the
//     wrong tier for code work).
// See ~/projects/control-plane/mesh/core/steerer_workflows.go and
// counsel_of_models_registry.go (commit 00edbfe1, branch
// mesh-sitelayer-routing). Day-1 Capability Foundation piece B of
// docs/PROVING_GROUND_PLAN.md: without this wiring the registry
// entries are dead weight and lane=agent tasks still land in
// operator_assistant -> Claude Haiku.
export const SITELAYER_IMPLEMENTATION_STEERER_WORKFLOW_ID = 'sitelayer_implementation_fan'
export const SITELAYER_IMPLEMENTATION_COUNSEL_CLASS = 'sitelayer_implementation'

export function createContextWorkDispatchRunner(deps: { pool: Pool }) {
  const { pool } = deps

  return async function drainContextWorkDispatch(companyId: string): Promise<AgentDrainSummary> {
    if (!workRequestDispatchUrl()) {
      return { processed: 0, insightsCreated: 0, failed: 0 }
    }
    return drainAgentMutations<ContextWorkDispatchPayload>(
      pool,
      'dispatch_mesh_work_request',
      companyId,
      'context_work_dispatch',
      processContextWorkDispatch,
    )
  }
}

async function processContextWorkDispatch(
  client: PoolClient,
  companyId: string,
  payload: ContextWorkDispatchPayload,
): Promise<{ insightsCreated: number }> {
  const workItemId = payload.work_item_id
  if (!workItemId) throw new Error('context work dispatch missing work_item_id')
  const payloadVersion = cleanString(payload.payload_version)
  if (payloadVersion && payloadVersion !== CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION) {
    throw new Error(`unsupported context work dispatch payload_version: ${payloadVersion}`)
  }
  const callbackTokenType = cleanString(payload.callback?.token_type)
  if (callbackTokenType && callbackTokenType !== 'scoped_bearer') {
    throw new Error(`unsupported context work dispatch callback token_type: ${callbackTokenType}`)
  }
  const captureSessionId = cleanString(payload.capture_session_id)

  const dispatchUrl = workRequestDispatchUrl()
  if (!dispatchUrl) {
    throw new Error('PROJECTKIT_WORK_REQUEST_DISPATCH_URL is not configured')
  }

  const gate = await client.query<{ status: string }>(
    `select status
       from context_work_items
      where company_id = $1 and id = $2
      for update`,
    [companyId, workItemId],
  )
  const status = gate.rows[0]?.status
  if (!status) throw new Error(`context work item not found: ${workItemId}`)
  if (status === 'resolved' || status === 'wont_do' || status === 'reversed') {
    await client.query(
      `insert into context_handoff_events (
         company_id, work_item_id, event_type, actor_kind, actor_ref,
         source_system, payload, metadata, idempotency_key, capture_session_id,
         redaction_version
       ) values ($1, $2, 'agent.dispatch_cancel_requested', 'system', 'sitelayer-worker',
         'sitelayer', $3::jsonb, $4::jsonb, $5, $6::uuid, 'context-handoff-v1')
       on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing`,
      [
        companyId,
        workItemId,
        JSON.stringify({ skipped: true, reason: 'terminal_work_item', status }),
        JSON.stringify({ dispatch_surface: 'projectkit', dispatch_adapter: 'mesh' }),
        `context_work_item:dispatch_skip_terminal:${workItemId}`,
        captureSessionId,
      ],
    )
    return { insightsCreated: 0 }
  }

  const response = await fetch(dispatchUrl, {
    method: 'POST',
    headers: buildDispatchHeaders(),
    body: JSON.stringify(buildMeshDispatchBody(companyId, payload)),
  })
  const responseText = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(`mesh work dispatch failed: ${response.status} ${responseText.slice(0, 240)}`)
  }
  const meshTaskId = extractMeshTaskId(responseText)

  await client.query(
    `insert into context_handoff_events (
       company_id, work_item_id, event_type, actor_kind, actor_ref,
       source_system, payload, metadata, idempotency_key, capture_session_id,
       redaction_version
     ) values ($1, $2, 'agent.dispatch_acknowledged', 'system', 'sitelayer-worker',
       'mesh', $3::jsonb, $4::jsonb, $5, $6::uuid, 'context-handoff-v1')
     on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      companyId,
      workItemId,
      JSON.stringify({
        status: response.status,
        mesh_task_id: meshTaskId,
        response: responseText ? responseText.slice(0, 1000) : null,
      }),
      JSON.stringify({ dispatch_surface: 'projectkit', dispatch_adapter: 'mesh' }),
      `context_work_item:dispatch_mesh_ack:${workItemId}`,
      captureSessionId,
    ],
  )
  await client.query(
    `update context_work_items
        set status = 'agent_running',
            lane = case when $3 = 'both' then 'both' else 'agent' end,
            updated_at = now()
      where company_id = $1 and id = $2`,
    [companyId, workItemId, payload.lane],
  )

  return { insightsCreated: 0 }
}

function extractMeshTaskId(responseText: string): string | null {
  if (!responseText) return null
  try {
    const parsed = JSON.parse(responseText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const value = record.task_id ?? record.id ?? record.taskId
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  } catch {
    return null
  }
  return null
}

function buildMeshDispatchBody(companyId: string, payload: ContextWorkDispatchPayload): Record<string, unknown> {
  const payloadVersion = cleanString(payload.payload_version) ?? CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION
  const callbackTokenType = cleanString(payload.callback?.token_type) ?? 'scoped_bearer'
  const callback = payload.callback ? { ...payload.callback, token_type: callbackTokenType } : null
  const contextHandoff = {
    payload_version: payloadVersion,
    version: 'context-handoff-v1',
    source_system: 'sitelayer',
    company_id: companyId,
    work_item_id: payload.work_item_id,
    support_packet_id: payload.support_packet_id ?? null,
    capture_session_id: payload.capture_session_id ?? null,
    title: payload.title ?? null,
    summary: payload.summary ?? null,
    route: payload.route ?? null,
    entity_type: payload.entity_type ?? null,
    entity_id: payload.entity_id ?? null,
    support_packet: payload.support_packet ?? null,
    work_request_brief: payload.work_request_brief ?? null,
    agent_brief_markdown: payload.agent_brief_markdown ?? null,
    // ADDITIVE: forward the projectkit WorkRequest/Concern snapshot untouched.
    dispatch_request: payload.dispatch_request ?? null,
    callback,
  }
  const route = cleanString(payload.route)
  const entityType = cleanString(payload.entity_type)
  const entityId = cleanString(payload.entity_id)
  const summary = cleanString(payload.summary)
  const title = cleanString(payload.title) ?? `Sitelayer work request ${payload.work_item_id.slice(0, 8)}`
  const callbackPath = cleanString(payload.callback?.path)
  const callbackUrl = cleanString(payload.callback?.url)
  const captureSessionId = cleanString(payload.capture_session_id)
  const lane = cleanString(payload.lane)
  const isAgentLane = isImplementationLane(lane)

  // featureBrief drives the steerer workflow's brief template — prefer
  // the operator-authored summary over the generated title because the
  // summary captures intent, while the title is often the route hint.
  const featureBrief = summary ?? title
  const affectedPackages = deriveAffectedPackages({ route, entityType })
  const baseTags = 'sitelayer,context-handoff,work-request,triage:ready-for-agent'
  const tags = isAgentLane ? `${baseTags},implementation,sitelayer:lane:${lane ?? 'agent'}` : `${baseTags},audit`
  const properties: Record<string, unknown> = {
    project_hint: 'sitelayer',
    source_system: 'sitelayer',
    source_kind: 'context_work_item',
    company_id: companyId,
    work_item_id: payload.work_item_id,
    support_packet_id: cleanString(payload.support_packet_id),
    capture_session_id: captureSessionId,
    route,
    entity_type: entityType,
    entity_id: entityId,
    callback_path: callbackPath,
    callback_url: callbackUrl,
    callback_token_type: payload.callback ? callbackTokenType : null,
    lane,
    work_request_brief_schema: readBriefSchema(payload.work_request_brief),
    context_handoff_payload_version: payloadVersion,
  }
  const executionContext: Record<string, unknown> = {
    payload_version: payloadVersion,
    project_hint: 'sitelayer',
    source_system: 'sitelayer',
    work_item_id: payload.work_item_id,
    support_packet_id: cleanString(payload.support_packet_id),
    capture_session_id: captureSessionId,
    route,
    entity_type: entityType,
    entity_id: entityId,
    callback_path: callbackPath,
    callback_url: callbackUrl,
    callback_token_type: payload.callback ? callbackTokenType : null,
    dispatch_mode: 'steerer',
    claim_mode: 'steerer',
    context_handoff: contextHandoff,
    work_request_brief: payload.work_request_brief ?? null,
    agent_brief_markdown: cleanString(payload.agent_brief_markdown),
    // ADDITIVE: surface the projectkit WorkRequest/Concern snapshot at the top
    // level of execution_context too, so a subscriber can read it without
    // descending into context_handoff.
    dispatch_request: payload.dispatch_request ?? null,
  }

  if (isAgentLane) {
    properties.steerer_workflow_id = SITELAYER_IMPLEMENTATION_STEERER_WORKFLOW_ID
    properties.counsel_class = SITELAYER_IMPLEMENTATION_COUNSEL_CLASS
    properties.readonly = false
    // Inputs declared on the mesh steerer workflow registry entry
    // (required: project_task_id, feature_brief, affected_packages;
    // optional: acceptance_criteria, branch_prefix, context_handoff_ref,
    // target_files). project_task_id is filled in by mesh once the
    // task row is created — we surface context_handoff_ref so the
    // implementer can fetch the full timeline from
    // /api/work-requests/:id.
    properties.feature_brief = featureBrief
    properties.affected_packages = affectedPackages
    properties.context_handoff_ref = payload.work_item_id
    properties.acceptance_criteria = [
      'Read the attached Sitelayer context handoff (execution_context.context_handoff) before changing code.',
      'Implement the change scoped to affected_packages; run targeted typecheck + tests before committing.',
      'Push to an agent/<runner>/sitelayer-* branch and report branch + test verdict in the output envelope. Do NOT merge to main.',
      'Use the scoped callback URL when reporting status back to Sitelayer.',
    ]
    executionContext.steerer_workflow_id = SITELAYER_IMPLEMENTATION_STEERER_WORKFLOW_ID
    executionContext.counsel_class = SITELAYER_IMPLEMENTATION_COUNSEL_CLASS
    executionContext.feature_brief = featureBrief
    executionContext.affected_packages = affectedPackages
    executionContext.context_handoff_ref = payload.work_item_id
  } else {
    properties.readonly = true
    properties.acceptance_criteria = [
      'Read the attached Sitelayer context handoff before acting.',
      'Record the observed issue, likely cause, and recommended owner or next action.',
      'Use the scoped callback URL when updating the Sitelayer work request status.',
    ]
  }

  return {
    payload_version: payloadVersion,
    subject: `[Sitelayer] ${title}`,
    description: buildMeshTaskDescription({
      companyId,
      workItemId: payload.work_item_id,
      supportPacketId: cleanString(payload.support_packet_id),
      captureSessionId,
      title,
      summary,
      route,
      entityType,
      entityId,
      callbackPath: callbackUrl ?? callbackPath,
      isAgentLane,
      lane,
      affectedPackages,
      agentBriefMarkdown: cleanString(payload.agent_brief_markdown),
    }),
    created_by: 'sitelayer-worker',
    source: 'sitelayer-context-handoff',
    task_type: isAgentLane ? 'implementation' : 'audit',
    auto_dispatch: contextWorkDispatchAutoDispatchEnabled(),
    tags,
    project_hint: 'sitelayer',
    idempotency_key: `sitelayer:context_work_item:${payload.work_item_id}`,
    reversibility_window_seconds:
      typeof payload.reversibility_window_seconds === 'number' && Number.isFinite(payload.reversibility_window_seconds)
        ? payload.reversibility_window_seconds
        : DEFAULT_REVERSIBILITY_WINDOW_SECONDS,
    properties,
    execution_context: executionContext,
  }
}

function isImplementationLane(lane: string | null): boolean {
  return lane === 'agent' || lane === 'both'
}

function contextWorkDispatchAutoDispatchEnabled(): boolean {
  const raw = process.env.CONTEXT_WORK_DISPATCH_AUTO_DISPATCH?.trim().toLowerCase()
  return raw === undefined || !['0', 'false', 'no'].includes(raw)
}

// deriveAffectedPackages takes the best signal we have at dispatch time
// — the work item's route (e.g. /projects/p/foo) and entity_type (e.g.
// project, rental_workflow, chat_widget) — and maps to sitelayer's
// monorepo workspace names. Sitelayer is a Node monorepo with apps/
// (api, web, worker) and packages/. The mesh steerer workflow's input
// schema requires `affected_packages`; we default to `['*']` when we
// can't infer, per the task spec ("better than blocking on perfect
// inference"). The implementer reads the context_handoff to figure
// out the actual scope from there.
function deriveAffectedPackages(hint: { route: string | null; entityType: string | null }): string[] {
  const route = hint.route ?? ''
  const entityType = hint.entityType ?? ''
  const matches = new Set<string>()
  // Chat widget changes live in apps/web + apps/api (per CLAUDE.md
  // operator note: chat-widget machine + ai-chat route are the most-
  // touched pair).
  if (/chat|widget|ai-chat/i.test(route) || /chat|widget/i.test(entityType)) {
    matches.add('apps/web')
    matches.add('apps/api')
  }
  if (route.startsWith('/api/') || /api|route|endpoint/i.test(entityType)) {
    matches.add('apps/api')
  }
  if (route.startsWith('/projects/') || /project|rental_workflow|estimate/i.test(entityType)) {
    matches.add('apps/web')
    matches.add('apps/api')
  }
  if (/worker|job|outbox|drain/i.test(route) || /worker|job/i.test(entityType)) {
    matches.add('apps/worker')
  }
  if (matches.size === 0) return ['*']
  return [...matches].sort()
}

function buildMeshTaskDescription(input: {
  companyId: string
  workItemId: string
  supportPacketId?: string | null
  captureSessionId?: string | null
  title: string
  summary?: string | null
  route?: string | null
  entityType?: string | null
  entityId?: string | null
  callbackPath?: string | null
  isAgentLane?: boolean
  lane?: string | null
  affectedPackages?: string[]
  agentBriefMarkdown?: string | null
}): string {
  const lines = [
    'Sitelayer context handoff work request.',
    '',
    `Title: ${input.title}`,
    `Company: ${input.companyId}`,
    `Work item: ${input.workItemId}`,
  ]
  appendLine(lines, 'Support packet', input.supportPacketId)
  appendLine(lines, 'Capture session', input.captureSessionId)
  appendLine(lines, 'Route', input.route)
  if (input.entityType || input.entityId) {
    lines.push(`Entity: ${input.entityType ?? 'unknown'}:${input.entityId ?? 'unknown'}`)
  }
  appendLine(lines, 'Summary', input.summary)
  appendLine(lines, 'Callback', input.callbackPath)
  if (input.agentBriefMarkdown) {
    lines.push('', 'Agent-readable handoff brief:', input.agentBriefMarkdown)
  }
  if (input.isAgentLane) {
    appendLine(lines, 'Lane', `${input.lane ?? 'agent'} (implementation)`)
    if (input.affectedPackages?.length) {
      lines.push(`Affected packages: ${input.affectedPackages.join(', ')}`)
    }
    lines.push(
      '',
      'Instructions (implementation lane):',
      `- Routed via steerer_workflow_id=${SITELAYER_IMPLEMENTATION_STEERER_WORKFLOW_ID} (Claude sonnet implementer, sequential fan).`,
      `- Counsel class ${SITELAYER_IMPLEMENTATION_COUNSEL_CLASS} (Claude/Sonnet primary; explicitly NOT haiku).`,
      '- Inspect execution_context.context_handoff for the captured route, entity, UI state, events, and support packet.',
      '- Implement the change scoped to affected_packages; run targeted typecheck + tests before committing.',
      '- Push to an agent/<runner>/sitelayer-* branch and return the JSON envelope declared by the workflow output contract. Do NOT merge to main (CLAUDE.md rule 13).',
      '- Use the scoped callback from execution_context.context_handoff.callback when reporting status back to Sitelayer.',
    )
  } else {
    lines.push(
      '',
      'Instructions:',
      '- Inspect execution_context.context_handoff for the captured route, entity, UI state, events, and support packet.',
      '- Treat this as read-only triage unless a separate implementation task with target_files and acceptance_criteria is created.',
      '- If you update Sitelayer, use the scoped callback from execution_context.context_handoff.callback.',
    )
  }
  return lines.join('\n')
}

function appendLine(lines: string[], label: string, value?: string | null): void {
  if (value) lines.push(`${label}: ${value}`)
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function workRequestDispatchUrl(): string {
  return (
    process.env.PROJECTKIT_WORK_REQUEST_DISPATCH_URL?.trim() || process.env.MESH_WORK_REQUEST_DISPATCH_URL?.trim() || ''
  )
}

function readBriefSchema(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const schema = (value as Record<string, unknown>).schema
  return typeof schema === 'string' && schema.trim() ? schema.trim() : null
}

function buildDispatchHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
  }
  const token = process.env.PROJECTKIT_WORK_REQUEST_DISPATCH_TOKEN || process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}
