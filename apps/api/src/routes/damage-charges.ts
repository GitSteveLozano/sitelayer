import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { recordMutationOutbox, withMutationTx } from '../mutation-tx.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'

/**
 * Damage / loss / late-return / cleanup charges.
 *
 * A charge is created when a shipment return comes up short, a unit is
 * flagged damaged, or a project closeout finds an unbilled exception.
 * Invoicing it enqueues a single mutation_outbox row keyed by the charge
 * id; the existing worker drain reuses the QBO push idempotency surface.
 */
export type DamageChargeRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const COLUMNS = `
  id, company_id, project_id, customer_id, shipment_id, shipment_line_id,
  inventory_item_id, catalog_part_id, kind, quantity, unit_amount,
  total_amount, description, taxable, status, state_version, qbo_invoice_id,
  invoiced_at, invoiced_by, waived_at, waived_by, waive_reason, notes,
  version, deleted_at, created_at, updated_at
`

function s(v: unknown): string | null {
  if (v == null) return null
  const text = String(v).trim()
  return text ? text : null
}
function num(v: unknown): number {
  if (v == null || v === '') return 0
  const parsed = Number(v)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function handleDamageChargeRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: DamageChargeRouteCtx,
): Promise<boolean> {
  // List per project.
  const listMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/damage-charges$/)
  if (req.method === 'GET' && listMatch) {
    const projectId = listMatch[1]!
    const result = await ctx.pool.query(
      `select ${COLUMNS} from damage_charges
       where company_id = $1 and project_id = $2 and deleted_at is null
       order by created_at desc`,
      [ctx.company.id, projectId],
    )
    ctx.sendJson(200, { charges: result.rows })
    return true
  }
  if (req.method === 'POST' && listMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = listMatch[1]!
    const body = await ctx.readBody()
    const kind = s(body.kind)
    const description = s(body.description)
    if (!kind || !['damage', 'loss', 'late_return', 'cleanup'].includes(kind)) {
      ctx.sendJson(400, { error: 'kind must be damage|loss|late_return|cleanup' })
      return true
    }
    if (!description) {
      ctx.sendJson(400, { error: 'description is required' })
      return true
    }
    const quantity = num(body.quantity)
    const unitAmount = num(body.unit_amount)
    const totalAmount =
      body.total_amount != null ? num(body.total_amount) : Math.round(quantity * unitAmount * 100) / 100
    const result = await ctx.pool.query(
      `insert into damage_charges (
        company_id, project_id, customer_id, shipment_id, shipment_line_id,
        inventory_item_id, catalog_part_id, kind, quantity, unit_amount,
        total_amount, description, taxable, notes
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13,true),$14)
      returning ${COLUMNS}`,
      [
        ctx.company.id,
        projectId,
        s(body.customer_id),
        s(body.shipment_id),
        s(body.shipment_line_id),
        s(body.inventory_item_id),
        s(body.catalog_part_id),
        kind,
        quantity,
        unitAmount,
        totalAmount,
        description,
        body.taxable,
        s(body.notes),
      ],
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  // Invoice the charge — enqueue an outbox row.
  const invoiceMatch = url.pathname.match(/^\/api\/damage-charges\/([^/]+)\/invoice$/)
  if (req.method === 'POST' && invoiceMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = invoiceMatch[1]!
    const result = await withMutationTx(async (client: PoolClient) => {
      const charge = await client.query(
        `update damage_charges
           set status = 'invoiced', invoiced_at = now(), invoiced_by = $3,
               state_version = state_version + 1, version = version + 1, updated_at = now()
         where company_id = $1 and id = $2 and status = 'open' and deleted_at is null
         returning ${COLUMNS}`,
        [ctx.company.id, id, ctx.currentUserId],
      )
      if (!charge.rows[0]) {
        return { error: 'charge not open' as const, code: 409 }
      }
      await recordMutationOutbox(
        ctx.company.id,
        'damage_charge',
        id,
        'damage_charge_invoice_push',
        charge.rows[0] ?? {},
        `damage_charge_invoice:${id}`,
        'server',
        ctx.currentUserId,
        client,
      )
      return { charge: charge.rows[0] }
    })
    if ('error' in result) {
      ctx.sendJson(result.code ?? 400, { error: result.error })
      return true
    }
    ctx.sendJson(200, result.charge)
    return true
  }

  const waiveMatch = url.pathname.match(/^\/api\/damage-charges\/([^/]+)\/waive$/)
  if (req.method === 'POST' && waiveMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = waiveMatch[1]!
    const body = await ctx.readBody()
    const result = await ctx.pool.query(
      `update damage_charges
         set status = 'waived', waived_at = now(), waived_by = $3,
             waive_reason = $4, state_version = state_version + 1,
             version = version + 1, updated_at = now()
       where company_id = $1 and id = $2 and status = 'open' and deleted_at is null
       returning ${COLUMNS}`,
      [ctx.company.id, id, ctx.currentUserId, s(body.waive_reason)],
    )
    if (!result.rows[0]) {
      ctx.sendJson(409, { error: 'charge not open' })
      return true
    }
    ctx.sendJson(200, result.rows[0])
    return true
  }

  return false
}
