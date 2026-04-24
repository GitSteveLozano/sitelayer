import type { Pool } from 'pg'
import { getRequestContext } from '@sitelayer/logger'

const DOMAIN_ENTITY_TYPES = new Set([
  'company',
  'company_membership',
  'project',
  'customer',
  'worker',
  'service_item',
  'pricing_profile',
  'bonus_rule',
  'crew_schedule',
  'labor_entry',
  'blueprint_document',
  'takeoff_measurement',
  'material_bill',
  'integration_connection',
  'integration_mapping',
  'estimate_line',
])

export type AuditInput = {
  companyId: string
  entityType: string
  entityId: string
  action: string
  before?: unknown
  after?: unknown
  actorUserId?: string | null
  actorRole?: string | null
  sentryTrace?: string | null
}

export function isAuditableEntity(entityType: string): boolean {
  return DOMAIN_ENTITY_TYPES.has(entityType)
}

export async function recordAudit(pool: Pool, input: AuditInput): Promise<void> {
  if (!isAuditableEntity(input.entityType)) return
  const ctx = getRequestContext()
  const actor = input.actorUserId ?? ctx?.actorUserId ?? ctx?.userId ?? 'system'
  const requestId = ctx?.requestId ?? null

  await pool.query(
    `
    insert into audit_events (
      company_id, actor_user_id, actor_role, entity_type, entity_id, action,
      before, after, request_id, sentry_trace
    )
    values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
    `,
    [
      input.companyId,
      actor,
      input.actorRole ?? null,
      input.entityType,
      String(input.entityId),
      input.action,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      requestId,
      input.sentryTrace ?? null,
    ],
  )
}
