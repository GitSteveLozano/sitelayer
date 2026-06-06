import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { parseConfigPayload, parseJsonBody } from '../http-utils.js'
import { deleteVersionedEntity, patchVersionedEntity } from '../versioned-update.js'

// pricing_profiles.config is a free-form JSONB blob parsed separately by
// parseConfigPayload (accepts already-parsed object OR JSON string). The
// schema validates the wire shape around it.
const PricingProfileCreateBodySchema = z
  .object({
    name: z.string().optional(),
    is_default: z.boolean().optional(),
    config: z.unknown().optional(),
    config_json: z.unknown().optional(),
  })
  .loose()

const PricingProfilePatchBodySchema = z
  .object({
    name: z.string().nullish(),
    is_default: z.boolean().nullish(),
    config: z.unknown().optional(),
    config_json: z.unknown().optional(),
    expected_version: z.union([z.number(), z.string()]).nullish(),
    version: z.union([z.number(), z.string()]).nullish(),
  })
  .loose()

export type PricingProfileRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

/**
 * Handle /api/pricing-profiles* requests. Same SQL, same role gates, same
 * default-flag invariants — the create/update paths still run the
 * `is_default` clear-others UPDATE inside the same tx as the insert/update,
 * so we never end up with zero defaults if a step fails.
 */
export async function handlePricingProfileRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: PricingProfileRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/pricing-profiles') {
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        'select id, name, is_default, config, version, created_at from pricing_profiles where company_id = $1 order by created_at asc',
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { pricingProfiles: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/pricing-profiles') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(PricingProfileCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const name = (body.name ?? '').trim()
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    let config: Record<string, unknown>
    try {
      config = parseConfigPayload(body.config ?? body.config_json)
    } catch {
      ctx.sendJson(400, { error: 'config must be valid json' })
      return true
    }
    const profile = await withMutationTx(async (client: PoolClient) => {
      if (body.is_default) {
        await client.query('update pricing_profiles set is_default = false where company_id = $1', [ctx.company.id])
      }
      const result = await client.query(
        `
        insert into pricing_profiles (company_id, name, is_default, config, version)
        values ($1, $2, coalesce($3, false), $4::jsonb, 1)
        returning id, name, is_default, config, version, created_at
        `,
        [ctx.company.id, name, body.is_default ?? false, JSON.stringify(config)],
      )
      const row = result.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'pricing_profile',
        entityId: row.id,
        action: 'create',
        row,
        syncPayload: { action: 'create', pricingProfile: row },
      })
      return row
    })
    ctx.sendJson(201, profile)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/pricing-profiles\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const pricingProfileId = url.pathname.split('/')[3] ?? ''
    if (!pricingProfileId) {
      ctx.sendJson(400, { error: 'pricing profile id is required' })
      return true
    }
    const parsedPatch = parseJsonBody(PricingProfilePatchBodySchema, await ctx.readBody())
    if (!parsedPatch.ok) {
      ctx.sendJson(400, { error: parsedPatch.error })
      return true
    }
    const body = parsedPatch.value
    let config: Record<string, unknown> | null = null
    if (body.config !== undefined || body.config_json !== undefined) {
      try {
        config = parseConfigPayload(body.config ?? body.config_json)
      } catch {
        ctx.sendJson(400, { error: 'config must be valid json' })
        return true
      }
    }
    return patchVersionedEntity({
      ctx,
      body,
      entityType: 'pricing_profile',
      entityName: 'pricing profile',
      table: 'pricing_profiles',
      id: pricingProfileId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      update: async (client, expectedVersion) => {
        if (body.is_default) {
          await client.query('update pricing_profiles set is_default = false where company_id = $1 and id <> $2', [
            ctx.company.id,
            pricingProfileId,
          ])
        }
        const result = await client.query(
          `
          update pricing_profiles
          set
            name = coalesce($3, name),
            is_default = coalesce($4, is_default),
            config = coalesce($5::jsonb, config),
            version = version + 1
          where company_id = $1 and id = $2 and ($6::int is null or version = $6)
          returning id, name, is_default, config, version, created_at
          `,
          [
            ctx.company.id,
            pricingProfileId,
            body.name ?? null,
            body.is_default ?? null,
            config ? JSON.stringify(config) : null,
            expectedVersion,
          ],
        )
        const row = result.rows[0]
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'pricing_profile',
          entityId: pricingProfileId,
          action: 'update',
          row,
          syncPayload: { action: 'update', pricingProfile: row },
        })
        return row
      },
    })
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/pricing-profiles\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const pricingProfileId = url.pathname.split('/')[3] ?? ''
    if (!pricingProfileId) {
      ctx.sendJson(400, { error: 'pricing profile id is required' })
      return true
    }
    const body = await ctx.readBody()
    return deleteVersionedEntity({
      ctx,
      body,
      entityType: 'pricing_profile',
      entityName: 'pricing profile',
      table: 'pricing_profiles',
      id: pricingProfileId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      delete: async (client, expectedVersion) => {
        const result = await client.query(
          'delete from pricing_profiles where company_id = $1 and id = $2 and ($3::int is null or version = $3) returning id, name, is_default, config, version, created_at',
          [ctx.company.id, pricingProfileId, expectedVersion],
        )
        const row = result.rows[0]
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'pricing_profile',
          entityId: pricingProfileId,
          action: 'delete',
          row,
          syncPayload: { action: 'delete', pricingProfile: row },
        })
        return row
      },
    })
  }

  return false
}
