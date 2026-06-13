import type http from 'node:http'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { buildPaginationMeta, parseJsonBody, parsePagination, type PaginationParams } from '../http-utils.js'
import { recordMutationLedger, withMutationTx, type LedgerExecutor } from '../mutation-tx.js'
import { deleteVersionedEntity, patchVersionedEntity } from '../versioned-update.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

// POST upsert wire-format. Entity type / local ref / external id are all
// required strings (existing 400 path) — schema rejects e.g. numeric
// external_id upfront. label/status/notes are nullable + optional with
// `String(...)` legacy coercion replaced by typed strings.
const QboMappingCreateBodySchema = z
  .object({
    entity_type: z.string().optional(),
    local_ref: z.string().optional(),
    external_id: z.string().optional(),
    label: z.string().nullish(),
    status: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .loose()

const QboMappingPatchBodySchema = z
  .object({
    entity_type: z.string().nullish(),
    local_ref: z.string().nullish(),
    external_id: z.string().nullish(),
    label: z.string().nullish(),
    status: z.string().nullish(),
    notes: z.string().nullish(),
    expected_version: z.union([z.number(), z.string()]).nullish(),
    version: z.union([z.number(), z.string()]).nullish(),
  })
  .loose()

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
   *
   * `pagination` is optional so existing callers/tests that hand back the
   * full set continue to work; when supplied, the implementation should
   * apply `limit`/`offset` at the SQL layer.
   */
  listMappings: (
    companyId: string,
    provider: string,
    entityType: string | null,
    pagination?: PaginationParams,
  ) => Promise<IntegrationMappingRow[]>
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
    const pagination = parsePagination(url.searchParams)
    if (!pagination.ok) {
      ctx.sendJson(400, { error: pagination.error })
      return true
    }
    const mappings = await ctx.listMappings(ctx.company.id, 'qbo', entityType, pagination.value)
    ctx.sendJson(200, {
      mappings,
      pagination: buildPaginationMeta(pagination.value, mappings.length),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/integrations/qbo/mappings') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(QboMappingCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const entityType = (body.entity_type ?? '').trim()
    const localRef = (body.local_ref ?? '').trim()
    const externalId = (body.external_id ?? '').trim()
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
          label: body.label ? body.label.trim() : null,
          status: body.status ? body.status.trim() : 'active',
          notes: body.notes ? body.notes.trim() : null,
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
    const parsedPatch = parseJsonBody(QboMappingPatchBodySchema, await ctx.readBody())
    if (!parsedPatch.ok) {
      ctx.sendJson(400, { error: parsedPatch.error })
      return true
    }
    const body = parsedPatch.value
    return patchVersionedEntity({
      ctx,
      body,
      entityType: 'integration_mapping',
      entityName: 'mapping',
      table: 'integration_mappings',
      id: mappingId,
      checkVersionWhere: "company_id = $1 and provider = 'qbo' and id = $2 and deleted_at is null",
      update: async (client, expectedVersion) => {
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
      },
    })
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/integrations\/qbo\/mappings\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const mappingId = url.pathname.split('/')[5] ?? ''
    if (!mappingId) {
      ctx.sendJson(400, { error: 'mapping id is required' })
      return true
    }
    const body = await ctx.readBody()
    return deleteVersionedEntity({
      ctx,
      body,
      entityType: 'integration_mapping',
      entityName: 'mapping',
      table: 'integration_mappings',
      id: mappingId,
      checkVersionWhere: "company_id = $1 and provider = 'qbo' and id = $2 and deleted_at is null",
      delete: async (client, expectedVersion) => {
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
      },
    })
  }

  return false
}

/**
 * Self-registered dispatch descriptor for the `qbo-mappings` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const qboMappingsRouteDescriptor: DispatchRouteDescriptor = {
  name: 'qbo-mappings',
  order: 230,
  handle: ({ req, url, company, requireRoleStr, readBody, sendJson, checkVersion, ctx }) =>
    handleQboMappingRoutes(req, url, {
      company,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
      checkVersion,
      listMappings: ctx.listIntegrationMappings,
      upsertMapping: ctx.upsertIntegrationMapping,
    }),
}
