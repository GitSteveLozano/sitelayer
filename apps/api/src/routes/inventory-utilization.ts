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

interface RollupRow {
  total_items: number
  total_quantity_owned: string
  on_rent_count: string
  in_yard_count: string
  out_for_service_count: string
}

interface TopUtilizedRow {
  inventory_item_id: string
  code: string
  name: string
  on_rent_quantity: string
  total_quantity: string
  utilization_pct: number
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
 *
 * The response also includes a headline deployment rollup on `totals`:
 *   - total_items / total_quantity_owned (stock balance net of lost/damaged)
 *   - on_rent_count (active job_rental_lines quantities)
 *   - in_yard_count (yard-location balance)
 *   - out_for_service_count (repair-location balance — not double-counted as on rent)
 *   - utilization_pct (on_rent / total_quantity_owned * 100, 0 when no stock)
 *   - top_utilized: up to 5 item types ranked by per-item utilization %
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

  // Headline rollup — owner persona "% of equipment currently deployed".
  // total_quantity_owned is the net movement-ledger balance across usable
  // locations (excludes lost/damaged). on_rent_count comes from active
  // job_rental_lines so service items are not double-counted as deployed.
  // in_yard_count and out_for_service_count come from the movement ledger
  // by location_type so each unit is in exactly one bucket.
  const rollupResult = await ctx.pool.query<RollupRow>(
    `
    with active_rentals as (
      select coalesce(sum(l.quantity), 0)::numeric(12,2) as on_rent_count
      from job_rental_lines l
      where l.company_id = $1
        and l.deleted_at is null
        and l.off_rent_date is null
        and l.status = 'active'
    ),
    movement_buckets as (
      select
        coalesce(sum(
          case
            when m.to_location_id is not null and coalesce(tl.location_type, '') not in ('lost', 'damaged') then m.quantity
            else 0
          end
          -
          case
            when m.from_location_id is not null and coalesce(fl.location_type, '') not in ('lost', 'damaged') then m.quantity
            else 0
          end
        ), 0)::numeric(12,2) as total_quantity_owned,
        coalesce(sum(
          case when m.to_location_id is not null and tl.location_type = 'yard' then m.quantity else 0 end
          -
          case when m.from_location_id is not null and fl.location_type = 'yard' then m.quantity else 0 end
        ), 0)::numeric(12,2) as in_yard_count,
        coalesce(sum(
          case when m.to_location_id is not null and tl.location_type = 'repair' then m.quantity else 0 end
          -
          case when m.from_location_id is not null and fl.location_type = 'repair' then m.quantity else 0 end
        ), 0)::numeric(12,2) as out_for_service_count
      from inventory_movements m
      left join inventory_locations fl on fl.company_id = m.company_id and fl.id = m.from_location_id
      left join inventory_locations tl on tl.company_id = m.company_id and tl.id = m.to_location_id
      where m.company_id = $1
    ),
    item_count as (
      select count(*)::int as total_items
      from inventory_items i
      where i.company_id = $1 and i.deleted_at is null
    )
    select
      ic.total_items,
      coalesce(mb.total_quantity_owned, 0)::numeric(12,2)::text as total_quantity_owned,
      coalesce(ar.on_rent_count, 0)::numeric(12,2)::text as on_rent_count,
      greatest(coalesce(mb.in_yard_count, 0), 0)::numeric(12,2)::text as in_yard_count,
      greatest(coalesce(mb.out_for_service_count, 0), 0)::numeric(12,2)::text as out_for_service_count
    from item_count ic
    cross join movement_buckets mb
    cross join active_rentals ar
    `,
    [ctx.company.id],
  )

  const rollupRow = rollupResult.rows[0] ?? {
    total_items: 0,
    total_quantity_owned: '0',
    on_rent_count: '0',
    in_yard_count: '0',
    out_for_service_count: '0',
  }
  const totalQuantityOwned = Number(rollupRow.total_quantity_owned) || 0
  const onRentCount = Number(rollupRow.on_rent_count) || 0
  const utilizationPct = totalQuantityOwned > 0 ? Math.round((onRentCount / totalQuantityOwned) * 1000) / 10 : 0

  // Top-5 most-utilized item types by current on-rent share of total stock.
  // Items with no stock at all are skipped — they can't be "utilized".
  const topUtilized: TopUtilizedRow[] = result.rows
    .map((r) => {
      const onRent = Number(r.on_rent_quantity) || 0
      const available = Number(r.available_quantity) || 0
      const total = onRent + available
      return {
        inventory_item_id: r.inventory_item_id,
        code: r.code,
        name: r.description,
        on_rent_quantity: r.on_rent_quantity,
        total_quantity: total.toFixed(2),
        utilization_pct: total > 0 ? Math.round((onRent / total) * 1000) / 10 : 0,
      }
    })
    .filter((r) => Number(r.total_quantity) > 0)
    .sort((a, b) => b.utilization_pct - a.utilization_pct)
    .slice(0, 5)

  // Legacy idle / available totals are still computed from the per-item
  // rows so existing consumers (rnt-list, rnt-utilization screens) keep
  // working without a schema bump.
  const legacyTotals = result.rows.reduce(
    (acc, r) => {
      acc.total_idle_revenue_per_day_cents += Number(r.idle_revenue_per_day_cents) || 0
      acc.total_on_rent += Number(r.on_rent_quantity) || 0
      acc.total_available += Number(r.available_quantity) || 0
      return acc
    },
    { total_idle_revenue_per_day_cents: 0, total_on_rent: 0, total_available: 0 },
  )

  const totals = {
    ...legacyTotals,
    total_items: Number(rollupRow.total_items) || 0,
    total_quantity_owned: totalQuantityOwned,
    on_rent_count: onRentCount,
    in_yard_count: Number(rollupRow.in_yard_count) || 0,
    out_for_service_count: Number(rollupRow.out_for_service_count) || 0,
    utilization_pct: utilizationPct,
    top_utilized: topUtilized,
    generated_at: new Date().toISOString(),
  }

  ctx.sendJson(200, { items: result.rows, totals })
  return true
}
