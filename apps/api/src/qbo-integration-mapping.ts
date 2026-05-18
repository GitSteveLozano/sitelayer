/**
 * `integration_mappings` CRUD plus a small set of backfill helpers that
 * the QBO sync route and the estimate-push path call to record
 * (local_ref → external_id) pairs after a successful create/upsert
 * against QBO. The four entity wrappers (customer, service item,
 * division, project) all funnel through the generic `backfillMapping`
 * helper so the ledger row shape stays consistent.
 */
import type { Pool } from 'pg'
import { recordMutationLedger, type LedgerExecutor } from './mutation-tx.js'

export type IntegrationMappingRow = {
  id: string
  provider: string
  entity_type: string
  local_ref: string
  external_id: string
  label: string | null
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export async function listIntegrationMappings(
  pool: Pool,
  companyId: string,
  provider: string,
  entityType?: string | null,
  pagination?: { limit: number; offset: number },
) {
  const filters: string[] = ['company_id = $1', 'provider = $2', 'deleted_at is null']
  const values: unknown[] = [companyId, provider]
  if (entityType) {
    values.push(entityType)
    filters.push(`entity_type = $${values.length}`)
  }
  let pageClause = ''
  if (pagination) {
    values.push(pagination.limit)
    values.push(pagination.offset)
    pageClause = ` limit $${values.length - 1} offset $${values.length}`
  }
  const result = await pool.query(
    `
    select id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
    from integration_mappings
    where ${filters.join(' and ')}
    order by entity_type asc, created_at asc${pageClause}
    `,
    values,
  )
  return result.rows as IntegrationMappingRow[]
}

export async function upsertIntegrationMapping(
  pool: Pool,
  companyId: string,
  provider: string,
  values: {
    entity_type: string
    local_ref: string
    external_id: string
    label?: string | null
    status?: string | null
    notes?: string | null
  },
  executor: LedgerExecutor = pool,
) {
  const result = await executor.query(
    `
    insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
    values ($1, $2, $3, $4, $5, $6, coalesce($7, 'active'), $8)
    on conflict (company_id, provider, entity_type, local_ref)
    do update set
      external_id = excluded.external_id,
      label = coalesce(excluded.label, integration_mappings.label),
      status = coalesce(excluded.status, integration_mappings.status),
      notes = coalesce(excluded.notes, integration_mappings.notes),
      version = integration_mappings.version + 1,
      updated_at = now(),
      deleted_at = null
    returning id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
    `,
    [
      companyId,
      provider,
      values.entity_type,
      values.local_ref,
      values.external_id,
      values.label ?? null,
      values.status ?? 'active',
      values.notes ?? null,
    ],
  )
  return result.rows[0] as IntegrationMappingRow
}

/**
 * Shared core for the four entity-specific backfill helpers below.
 * Upserts the mapping row and emits a `recordMutationLedger` audit
 * anchor keyed on the mapping id. Callers are responsible for the
 * skip-conditions that vary per entity.
 */
async function backfillMapping(
  pool: Pool,
  companyId: string,
  entry: {
    entity_type: string
    local_ref: string
    external_id: string
    label: string
    notes: string
  },
  executor: LedgerExecutor,
): Promise<IntegrationMappingRow> {
  const mapping = await upsertIntegrationMapping(
    pool,
    companyId,
    'qbo',
    {
      entity_type: entry.entity_type,
      local_ref: entry.local_ref,
      external_id: entry.external_id,
      label: entry.label,
      status: 'active',
      notes: entry.notes,
    },
    executor,
  )
  await recordMutationLedger(executor, {
    companyId,
    entityType: 'integration_mapping',
    entityId: mapping.id,
    action: 'upsert',
    row: mapping,
    syncPayload: { action: 'upsert', mapping },
    outboxPayload: mapping as Record<string, unknown>,
    idempotencyKey: `integration_mapping:qbo:${mapping.id}`,
  })
  return mapping
}

export async function backfillCustomerMapping(
  pool: Pool,
  companyId: string,
  customer: { id: string; external_id: string | null; name: string },
  executor: LedgerExecutor = pool,
) {
  if (!customer.external_id) return null
  return backfillMapping(
    pool,
    companyId,
    {
      entity_type: 'customer',
      local_ref: customer.id,
      external_id: customer.external_id,
      label: customer.name,
      notes: 'backfilled from customer external_id',
    },
    executor,
  )
}

export async function backfillServiceItemMapping(
  pool: Pool,
  companyId: string,
  serviceItem: { code: string; name: string; source?: string | null },
  externalId?: string | null,
  executor: LedgerExecutor = pool,
) {
  const resolvedExternalId = externalId ?? (serviceItem.code.startsWith('qbo-') ? serviceItem.code.slice(4) : null)
  if (!resolvedExternalId) return null
  return backfillMapping(
    pool,
    companyId,
    {
      entity_type: 'service_item',
      local_ref: serviceItem.code,
      external_id: resolvedExternalId,
      label: serviceItem.name,
      notes:
        serviceItem.source === 'qbo'
          ? 'backfilled from qbo service_item import'
          : 'backfilled from qbo-prefixed service_item',
    },
    executor,
  )
}

export async function backfillDivisionMapping(
  pool: Pool,
  companyId: string,
  division: { code: string; name: string },
  externalId: string,
  executor: LedgerExecutor = pool,
) {
  return backfillMapping(
    pool,
    companyId,
    {
      entity_type: 'division',
      local_ref: division.code,
      external_id: externalId,
      label: division.name,
      notes: 'backfilled from qbo class sync',
    },
    executor,
  )
}

export async function backfillProjectMapping(
  pool: Pool,
  companyId: string,
  project: { id: string; name: string },
  externalId: string,
  executor: LedgerExecutor = pool,
) {
  return backfillMapping(
    pool,
    companyId,
    {
      entity_type: 'project',
      local_ref: project.id,
      external_id: externalId,
      label: project.name,
      notes: 'backfilled from qbo estimate push',
    },
    executor,
  )
}
