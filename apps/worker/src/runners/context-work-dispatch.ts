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
  support_packet?: unknown
  callback?: {
    path?: string | null
    token?: string | null
    token_type?: string | null
  } | null
}

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
  return {
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
    execution_context: {
      context_handoff: contextHandoff,
    },
  }
}

function buildDispatchHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
  }
  const token = process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}
