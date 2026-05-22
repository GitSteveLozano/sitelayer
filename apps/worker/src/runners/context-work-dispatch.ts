import type { Pool, PoolClient } from 'pg'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'

export interface ContextWorkDispatchPayload {
  work_item_id: string
  support_packet_id?: string | null
  title?: string | null
  summary?: string | null
  route?: string | null
  entity_type?: string | null
  entity_id?: string | null
  reversibility_window_seconds?: number | null
  support_packet?: unknown
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

export function createContextWorkDispatchRunner(deps: { pool: Pool }) {
  const { pool } = deps

  return async function drainContextWorkDispatch(companyId: string): Promise<AgentDrainSummary> {
    if (!process.env.MESH_WORK_REQUEST_DISPATCH_URL) {
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

  const dispatchUrl = process.env.MESH_WORK_REQUEST_DISPATCH_URL
  if (!dispatchUrl) {
    throw new Error('MESH_WORK_REQUEST_DISPATCH_URL is not configured')
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
       source_system, payload, metadata, idempotency_key, redaction_version
     ) values ($1, $2, 'agent.dispatch_acknowledged', 'system', 'sitelayer-worker',
       'mesh', $3::jsonb, $4::jsonb, $5, 'context-handoff-v1')
     on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      companyId,
      workItemId,
      JSON.stringify({
        status: response.status,
        mesh_task_id: meshTaskId,
        response: responseText ? responseText.slice(0, 1000) : null,
      }),
      JSON.stringify({ dispatcher: 'mesh' }),
      `context_work_item:dispatch_mesh_ack:${workItemId}`,
    ],
  )
  await client.query(
    `update context_work_items
        set status = 'agent_running',
            lane = 'agent',
            updated_at = now()
      where company_id = $1 and id = $2`,
    [companyId, workItemId],
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
  const contextHandoff = {
    version: 'context-handoff-v1',
    source_system: 'sitelayer',
    company_id: companyId,
    work_item_id: payload.work_item_id,
    support_packet_id: payload.support_packet_id ?? null,
    title: payload.title ?? null,
    summary: payload.summary ?? null,
    route: payload.route ?? null,
    entity_type: payload.entity_type ?? null,
    entity_id: payload.entity_id ?? null,
    support_packet: payload.support_packet ?? null,
    callback: payload.callback ?? null,
  }
  const route = cleanString(payload.route)
  const entityType = cleanString(payload.entity_type)
  const entityId = cleanString(payload.entity_id)
  const summary = cleanString(payload.summary)
  const title = cleanString(payload.title) ?? `Sitelayer work request ${payload.work_item_id.slice(0, 8)}`
  const callbackPath = cleanString(payload.callback?.path)
  const callbackUrl = cleanString(payload.callback?.url)

  return {
    subject: `[Sitelayer] ${title}`,
    description: buildMeshTaskDescription({
      companyId,
      workItemId: payload.work_item_id,
      supportPacketId: cleanString(payload.support_packet_id),
      title,
      summary,
      route,
      entityType,
      entityId,
      callbackPath: callbackUrl ?? callbackPath,
    }),
    created_by: 'sitelayer-worker',
    source: 'sitelayer-context-handoff',
    task_type: 'audit',
    auto_dispatch: true,
    tags: 'sitelayer,context-handoff,work-request,triage:ready-for-agent,audit',
    project_hint: 'sitelayer',
    idempotency_key: `sitelayer:context_work_item:${payload.work_item_id}`,
    reversibility_window_seconds:
      typeof payload.reversibility_window_seconds === 'number' && Number.isFinite(payload.reversibility_window_seconds)
        ? payload.reversibility_window_seconds
        : DEFAULT_REVERSIBILITY_WINDOW_SECONDS,
    properties: {
      project_hint: 'sitelayer',
      source_system: 'sitelayer',
      source_kind: 'context_work_item',
      company_id: companyId,
      work_item_id: payload.work_item_id,
      support_packet_id: cleanString(payload.support_packet_id),
      route,
      entity_type: entityType,
      entity_id: entityId,
      callback_path: callbackPath,
      callback_url: callbackUrl,
      readonly: true,
      acceptance_criteria: [
        'Read the attached Sitelayer context handoff before acting.',
        'Record the observed issue, likely cause, and recommended owner or next action.',
        'Use the scoped callback URL when updating the Sitelayer work request status.',
      ],
    },
    execution_context: {
      project_hint: 'sitelayer',
      source_system: 'sitelayer',
      work_item_id: payload.work_item_id,
      support_packet_id: cleanString(payload.support_packet_id),
      route,
      entity_type: entityType,
      entity_id: entityId,
      callback_path: callbackPath,
      callback_url: callbackUrl,
      dispatch_mode: 'steerer',
      claim_mode: 'steerer',
      context_handoff: contextHandoff,
    },
  }
}

function buildMeshTaskDescription(input: {
  companyId: string
  workItemId: string
  supportPacketId?: string | null
  title: string
  summary?: string | null
  route?: string | null
  entityType?: string | null
  entityId?: string | null
  callbackPath?: string | null
}): string {
  const lines = [
    'Sitelayer context handoff work request.',
    '',
    `Title: ${input.title}`,
    `Company: ${input.companyId}`,
    `Work item: ${input.workItemId}`,
  ]
  appendLine(lines, 'Support packet', input.supportPacketId)
  appendLine(lines, 'Route', input.route)
  if (input.entityType || input.entityId) {
    lines.push(`Entity: ${input.entityType ?? 'unknown'}:${input.entityId ?? 'unknown'}`)
  }
  appendLine(lines, 'Summary', input.summary)
  appendLine(lines, 'Callback', input.callbackPath)
  lines.push(
    '',
    'Instructions:',
    '- Inspect execution_context.context_handoff for the captured route, entity, UI state, events, and support packet.',
    '- Treat this as read-only triage unless a separate implementation task with target_files and acceptance_criteria is created.',
    '- If you update Sitelayer, use the scoped callback from execution_context.context_handoff.callback.',
  )
  return lines.join('\n')
}

function appendLine(lines: string[], label: string, value?: string | null): void {
  if (value) lines.push(`${label}: ${value}`)
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function buildDispatchHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
  }
  const token = process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}
