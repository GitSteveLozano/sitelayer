import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'

// Per-project and per-customer service-item rate overrides — the WRITE side of
// the pricing chain the resolver (apps/api/src/pricing.ts) already reads:
//   project_pricing_overrides → customer_pricing_overrides
//     → company_pricing_overrides → qbo item rate → service_items.default_rate
//
// Cavy (WhatsApp 4/11): "can the pricing rate section be project specific? Or
// even a template per builder? Some builders get better pricing." The override
// rows existed (migration 071) and the resolver honoured them, but nothing
// wrote them — so per-project rates were a claimed-but-dead feature. These
// routes make them real. A subsequent estimate recompute picks the new rate up
// through the resolver, so the estimate stays the source of truth.

export type PricingOverrideRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

type Scope = {
  kind: 'project' | 'customer'
  table: 'project_pricing_overrides' | 'customer_pricing_overrides'
  idColumn: 'project_id' | 'customer_id'
  scopeId: string
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

async function listOverrides(ctx: PricingOverrideRouteCtx, scope: Scope): Promise<void> {
  const result = await withCompanyClient(ctx.company.id, (c) =>
    c.query(
      `select id, service_item_code, rate, unit, version, updated_at
       from ${scope.table}
       where company_id = $1 and ${scope.idColumn} = $2 and deleted_at is null
       order by service_item_code asc`,
      [ctx.company.id, scope.scopeId],
    ),
  )
  ctx.sendJson(200, { overrides: result.rows })
}

async function upsertOverride(ctx: PricingOverrideRouteCtx, scope: Scope): Promise<void> {
  if (!ctx.requireRole(['admin', 'office'])) return
  const body = await ctx.readBody()
  const serviceItemCode = String(body.service_item_code ?? '').trim()
  if (!serviceItemCode) {
    ctx.sendJson(400, { error: 'service_item_code is required' })
    return
  }
  const rate = Number(body.rate)
  if (!isFiniteNonNegative(rate)) {
    ctx.sendJson(400, { error: 'rate must be a non-negative number' })
    return
  }
  // Unit is optional — when omitted we inherit the service item's catalog unit
  // (the override can still set a different billing unit explicitly).
  const explicitUnit =
    body.unit === undefined || body.unit === null || String(body.unit).trim() === '' ? null : String(body.unit).trim()

  const row = await withMutationTx(async (client: PoolClient) => {
    const result = await client.query(
      `
      insert into ${scope.table} (company_id, ${scope.idColumn}, service_item_code, rate, unit, version)
      values (
        $1, $2, $3, $4,
        coalesce($5, (select unit from service_items where company_id = $1 and code = $3 and deleted_at is null limit 1), 'ea'),
        1
      )
      on conflict (company_id, ${scope.idColumn}, service_item_code) do update
        set rate = excluded.rate,
            unit = coalesce($5, ${scope.table}.unit),
            deleted_at = null,
            version = ${scope.table}.version + 1,
            updated_at = now()
      returning id, service_item_code, rate, unit, version, updated_at
      `,
      [ctx.company.id, scope.scopeId, serviceItemCode, rate, explicitUnit],
    )
    const saved = result.rows[0]
    await recordMutationLedger(client, {
      companyId: ctx.company.id,
      entityType: `${scope.kind}_pricing_override`,
      entityId: saved.id,
      action: 'upsert',
      row: saved,
      syncPayload: { action: 'upsert', scope: scope.kind, scopeId: scope.scopeId, override: saved },
    })
    return saved
  })
  ctx.sendJson(200, { override: row })
}

async function deleteOverride(ctx: PricingOverrideRouteCtx, scope: Scope): Promise<void> {
  if (!ctx.requireRole(['admin', 'office'])) return
  const body = await ctx.readBody()
  const serviceItemCode = String(body.service_item_code ?? '').trim()
  if (!serviceItemCode) {
    ctx.sendJson(400, { error: 'service_item_code is required' })
    return
  }
  const row = await withMutationTx(async (client: PoolClient) => {
    const result = await client.query(
      `update ${scope.table}
       set deleted_at = now(), version = version + 1, updated_at = now()
       where company_id = $1 and ${scope.idColumn} = $2 and service_item_code = $3 and deleted_at is null
       returning id, service_item_code`,
      [ctx.company.id, scope.scopeId, serviceItemCode],
    )
    const removed = result.rows[0]
    if (!removed) return null
    await recordMutationLedger(client, {
      companyId: ctx.company.id,
      entityType: `${scope.kind}_pricing_override`,
      entityId: removed.id,
      action: 'delete',
      row: removed,
      syncPayload: { action: 'delete', scope: scope.kind, scopeId: scope.scopeId, override: removed },
    })
    return removed
  })
  if (!row) {
    ctx.sendJson(404, { error: 'override not found' })
    return
  }
  ctx.sendJson(200, { deleted: row })
}

/**
 * Handle /api/projects/:id/pricing-overrides and
 * /api/customers/:id/pricing-overrides (GET list, PUT upsert, DELETE clear).
 * The service item code travels in the body (not the path) so codes with
 * spaces — "Air Barrier", "Finish Coat" — never need URL escaping.
 */
export async function handlePricingOverrideRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: PricingOverrideRouteCtx,
): Promise<boolean> {
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/pricing-overrides$/)
  const customerMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/pricing-overrides$/)
  const match = projectMatch ?? customerMatch
  if (!match) return false

  const scope: Scope = projectMatch
    ? { kind: 'project', table: 'project_pricing_overrides', idColumn: 'project_id', scopeId: projectMatch[1] ?? '' }
    : {
        kind: 'customer',
        table: 'customer_pricing_overrides',
        idColumn: 'customer_id',
        scopeId: customerMatch![1] ?? '',
      }

  if (!scope.scopeId) {
    ctx.sendJson(400, { error: `${scope.kind} id is required` })
    return true
  }

  if (req.method === 'GET') {
    await listOverrides(ctx, scope)
    return true
  }
  if (req.method === 'PUT') {
    await upsertOverride(ctx, scope)
    return true
  }
  if (req.method === 'DELETE') {
    await deleteOverride(ctx, scope)
    return true
  }
  return false
}
