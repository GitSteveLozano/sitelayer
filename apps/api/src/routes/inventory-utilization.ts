import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'

export type InventoryUtilizationRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  sendJson: (status: number, body: unknown) => void
}

interface UtilizationItemRow {
  inventory_item_id: string
  code: string
  description: string
  unit: string
  default_rental_rate: string
  on_rent_quantity: string
  available_quantity: string
  active_lines: number
  // Idle days = days since the most recent activity (last movement
  // *or* last on_rent_date). NULL when the item has no history.
  days_since_activity: number | null
  // Cents idled per day at the default rental rate (rough order-of-
  // magnitude — true idle revenue requires the contract rate).
  idle_revenue_per_day_cents: number
}

/**
 * GET /api/inventory/utilization
 *
 * Per-item utilization rollup for the rentals dashboard:
 *   - on_rent_quantity from active job_rental_lines
 *   - available_quantity = total_stock - on_rent
 *   - days_since_activity from inventory_movements + line on_rent_date
 *   - idle_revenue_per_day_cents = available * default_rental_rate
 *
 * Sorts highest idle dollars first so the owner sees the heaviest
 * idle assets at the top of the list. Soft-deleted items skipped.
 */
export async function handleInventoryUtilizationRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: InventoryUtilizationRouteCtx,
): Promise<boolean> {
  if (req.method !== 'GET') return false
  if (url.pathname !== '/api/inventory/utilization') return false
  if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true

  const result = await ctx.pool.query<UtilizationItemRow>(
    `
    with stock as (
      select
        i.id as inventory_item_id,
        i.code,
        i.description,
        i.unit,
        i.default_rental_rate,
        coalesce((
          select sum(case
            -- New receipt into the yard (no from_location): + stock
            when m.movement_type in ('deliver', 'transfer', 'adjustment') and m.from_location_id is null then m.quantity
            -- Damage / loss removes from owned stock regardless of locations
            when m.movement_type in ('damage', 'loss') then -m.quantity
            -- Return-to-supplier (no to_location): - stock
            when m.movement_type = 'return' and m.to_location_id is null then -m.quantity
            else 0
          end)
          from inventory_movements m
          where m.company_id = i.company_id and m.inventory_item_id = i.id
        ), 0)::numeric(12,2) as movement_balance,
        coalesce((
          select sum(l.quantity)
          from job_rental_lines l
          where l.company_id = i.company_id
            and l.inventory_item_id = i.id
            and l.status = 'active'
            and l.deleted_at is null
            and (l.off_rent_date is null or l.off_rent_date >= current_date)
        ), 0)::numeric(12,2) as on_rent_quantity,
        coalesce((
          select count(*)
          from job_rental_lines l
          where l.company_id = i.company_id
            and l.inventory_item_id = i.id
            and l.status = 'active'
            and l.deleted_at is null
        ), 0)::int as active_lines,
        greatest(
          coalesce((
            select max(m.occurred_on)::date
            from inventory_movements m
            where m.company_id = i.company_id and m.inventory_item_id = i.id
          ), '0001-01-01'::date),
          coalesce((
            select max(l.on_rent_date)::date
            from job_rental_lines l
            where l.company_id = i.company_id and l.inventory_item_id = i.id
          ), '0001-01-01'::date)
        ) as last_activity
      from inventory_items i
      where i.company_id = $1 and i.deleted_at is null and i.active = true
    )
    select
      inventory_item_id,
      code,
      description,
      unit,
      default_rental_rate,
      on_rent_quantity,
      greatest(movement_balance - on_rent_quantity, 0)::numeric(12,2) as available_quantity,
      active_lines,
      case when last_activity = '0001-01-01'::date then null
           else (current_date - last_activity)::int end as days_since_activity,
      (greatest(movement_balance - on_rent_quantity, 0) * default_rental_rate * 100)::int
        as idle_revenue_per_day_cents
    from stock
    order by idle_revenue_per_day_cents desc, code asc
    `,
    [ctx.company.id],
  )

  // Headline numbers — useful for the rnt-list KPI hero.
  const totals = result.rows.reduce(
    (acc, r) => {
      acc.total_idle_revenue_per_day_cents += Number(r.idle_revenue_per_day_cents) || 0
      acc.total_on_rent += Number(r.on_rent_quantity) || 0
      acc.total_available += Number(r.available_quantity) || 0
      return acc
    },
    {
      total_idle_revenue_per_day_cents: 0,
      total_on_rent: 0,
      total_available: 0,
      generated_at: new Date().toISOString(),
    },
  )

  ctx.sendJson(200, { items: result.rows, totals })
  return true
}
