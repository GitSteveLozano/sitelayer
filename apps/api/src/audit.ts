import type { Pool, PoolClient } from 'pg'
import { getRequestContext } from '@sitelayer/logger'

export type AuditExecutor = Pick<Pool | PoolClient, 'query'>

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
  'takeoff_draft',
  'material_bill',
  'integration_connection',
  'integration_mapping',
  'estimate_line',
  'inventory_item',
  'inventory_location',
  'inventory_movement',
  'inventory_service_ticket',
  'job_rental_contract',
  'job_rental_line',
  'rental_billing_run',
  'estimate_push',
  'project_lifecycle',
  'worker_issue',
  'labor_payroll_run',
  'estimate_share_link',
  'rental',
  'shipment',
  'project_lost_reason',
  'change_order',
  'project_billing_milestone',
  'guardrail',
  'project_message',
  'broadcast',
  // Global Clerk identity mirror (clerk_users). Audit rows for this entity are
  // only written when there IS a company to attribute the event to (e.g. a
  // future JIT-membership grant). The pre-tenancy webhook upsert itself is not
  // audited here — audit_events.company_id is NOT NULL — and instead relies on
  // the clerk_users created_at/updated_at/deleted_at columns as its trail.
  'clerk_user',
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
  /** The real impersonator during an audited impersonation session. Defaults
   *  from the request context (set in server.ts from the Clerk `act` claim) so
   *  callers don't have to thread it. */
  impersonatedBy?: string | null
  sentryTrace?: string | null
}

export function isAuditableEntity(entityType: string): boolean {
  return DOMAIN_ENTITY_TYPES.has(entityType)
}

export async function recordAudit(executor: AuditExecutor, input: AuditInput): Promise<void> {
  if (!isAuditableEntity(input.entityType)) return
  const ctx = getRequestContext()
  const actor = input.actorUserId ?? ctx?.actorUserId ?? ctx?.userId ?? 'system'
  const requestId = ctx?.requestId ?? null
  // Impersonation tag: explicit input wins, else inherit the session's
  // impersonator from the request context (set once in server.ts).
  const impersonatedBy = input.impersonatedBy ?? ctx?.impersonatedBy ?? null

  await executor.query(
    `
    insert into audit_events (
      company_id, actor_user_id, actor_role, entity_type, entity_id, action,
      before, after, request_id, sentry_trace, impersonated_by
    )
    values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
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
      impersonatedBy,
    ],
  )
}
