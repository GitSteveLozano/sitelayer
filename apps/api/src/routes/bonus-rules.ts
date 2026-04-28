import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { parseConfigPayload, parseExpectedVersion } from '../http-utils.js'

export type BonusRuleRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

/**
 * Handle /api/bonus-rules* requests. Same SQL, same admin-only role gate,
 * same ledger writes.
 */
export async function handleBonusRuleRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: BonusRuleRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/bonus-rules') {
    const result = await ctx.pool.query(
      'select id, name, config, is_active, version, created_at from bonus_rules where company_id = $1 order by created_at asc',
      [ctx.company.id],
    )
    ctx.sendJson(200, { bonusRules: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/bonus-rules') {
    if (!ctx.requireRole(['admin'])) return true
    const body = await ctx.readBody()
    const name = String(body.name ?? '').trim()
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
    const rule = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        insert into bonus_rules (company_id, name, config, is_active, version)
        values ($1, $2, $3::jsonb, coalesce($4, true), 1)
        returning id, name, config, is_active, version, created_at
        `,
        [ctx.company.id, name, JSON.stringify(config), body.is_active ?? true],
      )
      const row = result.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'bonus_rule',
        entityId: row.id,
        action: 'create',
        row,
        syncPayload: { action: 'create', bonusRule: row },
      })
      return row
    })
    ctx.sendJson(201, rule)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/bonus-rules\/[^/]+$/)) {
    if (!ctx.requireRole(['admin'])) return true
    const bonusRuleId = url.pathname.split('/')[3] ?? ''
    if (!bonusRuleId) {
      ctx.sendJson(400, { error: 'bonus rule id is required' })
      return true
    }
    const body = await ctx.readBody()
    let config: Record<string, unknown> | null = null
    if (body.config !== undefined || body.config_json !== undefined) {
      try {
        config = parseConfigPayload(body.config ?? body.config_json)
      } catch {
        ctx.sendJson(400, { error: 'config must be valid json' })
        return true
      }
    }
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update bonus_rules
        set
          name = coalesce($3, name),
          config = coalesce($4::jsonb, config),
          is_active = coalesce($5, is_active),
          version = version + 1
        where company_id = $1 and id = $2 and ($6::int is null or version = $6)
        returning id, name, config, is_active, version, created_at
        `,
        [
          ctx.company.id,
          bonusRuleId,
          body.name ?? null,
          config ? JSON.stringify(config) : null,
          body.is_active ?? null,
          expectedVersion,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'bonus_rule',
        entityId: bonusRuleId,
        action: 'update',
        row,
        syncPayload: { action: 'update', bonusRule: row },
      })
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'bonus_rules',
          'company_id = $1 and id = $2',
          [ctx.company.id, bonusRuleId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'bonus rule not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/bonus-rules\/[^/]+$/)) {
    if (!ctx.requireRole(['admin'])) return true
    const bonusRuleId = url.pathname.split('/')[3] ?? ''
    if (!bonusRuleId) {
      ctx.sendJson(400, { error: 'bonus rule id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        'delete from bonus_rules where company_id = $1 and id = $2 and ($3::int is null or version = $3) returning id, name, config, is_active, version, created_at',
        [ctx.company.id, bonusRuleId, expectedVersion],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'bonus_rule',
        entityId: bonusRuleId,
        action: 'delete',
        row,
        syncPayload: { action: 'delete', bonusRule: row },
      })
      return row
    })
    if (!deleted) {
      if (
        !(await ctx.checkVersion(
          'bonus_rules',
          'company_id = $1 and id = $2',
          [ctx.company.id, bonusRuleId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'bonus rule not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  return false
}
