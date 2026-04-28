import type http from 'node:http'
import type { PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx, type LedgerExecutor } from '../mutation-tx.js'
import { parseExpectedVersion } from '../http-utils.js'

/**
 * Shape of an integration_mappings row. Mirrors the IntegrationMappingRow
 * type that server.ts uses; kept local so the route module doesn't import
 * back into server.ts.
 */
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

export type QboMappingRouteCtx = {
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
  /**
   * List active integration_mappings rows for a (company, provider). Same
   * shape as server.ts's listIntegrationMappings; passed in so this route
   * module doesn't need a Pool reference.
   */
  listMappings: (companyId: string, provider: string, entityType: string | null) => Promise<IntegrationMappingRow[]>
  /**
   * Upsert via (company, provider, entity_type, local_ref). Same contract
   * as server.ts's upsertIntegrationMapping. Threaded through the context
   * so the POST handler can pass the active tx client.
   */
  upsertMapping: (
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
    executor: LedgerExecutor,
  ) => Promise<IntegrationMappingRow>
}

/**
 * Handle /api/integrations/qbo/mappings* requests:
 * - GET                                — list active mappings (filterable by entity_type)
 * - POST                               — upsert one mapping (admin/office)
 * - PATCH/DELETE /api/.../mappings/<id> — versioned update / soft-delete (admin/office)
 */
export async function handleQboMappingRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: QboMappingRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/integrations/qbo/mappings') {
    const entityType = url.searchParams.get('entity_type')
    ctx.sendJson(200, { mappings: await ctx.listMappings(ctx.company.id, 'qbo', entityType) })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/integrations/qbo/mappings') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const entityType = String(body.entity_type ?? '').trim()
    const localRef = String(body.local_ref ?? '').trim()
    const externalId = String(body.external_id ?? '').trim()
    if (!entityType || !localRef || !externalId) {
      ctx.sendJson(400, { error: 'entity_type, local_ref, and external_id are required' })
      return true
    }
    const mapping = await withMutationTx(async (client: PoolClient) => {
      const row = await ctx.upsertMapping(
        ctx.company.id,
        'qbo',
        {
          entity_type: entityType,
          local_ref: localRef,
          external_id: externalId,
          label: body.label ? String(body.label).trim() : null,
          status: body.status ? String(body.status).trim() : 'active',
          notes: body.notes ? String(body.notes).trim() : null,
        },
        client,
      )
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'integration_mapping',
        entityId: row.id,
        action: 'upsert',
        row,
        syncPayload: { action: 'upsert', mapping: row },
        outboxPayload: row as Record<string, unknown>,
        idempotencyKey: `integration_mapping:qbo:${row.id}`,
      })
      return row
    })
    ctx.sendJson(201, mapping)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/integrations\/qbo\/mappings\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const mappingId = url.pathname.split('/')[5] ?? ''
    if (!mappingId) {
      ctx.sendJson(400, { error: 'mapping id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update integration_mappings
        set
          entity_type = coalesce($3, entity_type),
          local_ref = coalesce($4, local_ref),
          external_id = coalesce($5, external_id),
          label = coalesce($6, label),
          status = coalesce($7, status),
          notes = coalesce($8, notes),
          version = version + 1,
          updated_at = now(),
          deleted_at = null
        where company_id = $1 and provider = 'qbo' and id = $2 and deleted_at is null and ($9::int is null or version = $9)
        returning id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
        `,
        [
          ctx.company.id,
          mappingId,
          body.entity_type ?? null,
          body.local_ref ?? null,
          body.external_id ?? null,
          body.label ?? null,
          body.status ?? null,
          body.notes ?? null,
          expectedVersion,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'integration_mapping',
        entityId: mappingId,
        action: 'update',
        row,
        syncPayload: { action: 'update', mapping: row },
        idempotencyKey: `integration_mapping:qbo:update:${mappingId}`,
      })
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'integration_mappings',
          "company_id = $1 and provider = 'qbo' and id = $2 and deleted_at is null",
          [ctx.company.id, mappingId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'mapping not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/integrations\/qbo\/mappings\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const mappingId = url.pathname.split('/')[5] ?? ''
    if (!mappingId) {
      ctx.sendJson(400, { error: 'mapping id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update integration_mappings
        set deleted_at = now(), version = version + 1, status = 'deleted', updated_at = now()
        where company_id = $1 and provider = 'qbo' and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
        `,
        [ctx.company.id, mappingId, expectedVersion],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'integration_mapping',
        entityId: mappingId,
        action: 'delete',
        row,
        syncPayload: { action: 'delete', mapping: row },
        idempotencyKey: `integration_mapping:qbo:delete:${mappingId}`,
      })
      return row
    })
    if (!deleted) {
      if (
        !(await ctx.checkVersion(
          'integration_mappings',
          "company_id = $1 and provider = 'qbo' and id = $2 and deleted_at is null",
          [ctx.company.id, mappingId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'mapping not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  return false
}
