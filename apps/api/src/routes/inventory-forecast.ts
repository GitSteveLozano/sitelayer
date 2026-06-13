import type http from 'node:http'
import { withCompanyClient } from '../mutation-tx.js'
import type { RentalInventoryRouteCtx } from './rental-inventory.types.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

/**
 * The forecast route only reads `company` + `sendJson`, so it takes a
 * narrowed view of the shared rental-inventory ctx. This keeps it
 * decoupled from the storage/photo-upload plumbing that the CRUD module's
 * condition-photo endpoints require on the full `RentalInventoryRouteCtx`.
 */
export type InventoryForecastRouteCtx = Pick<RentalInventoryRouteCtx, 'company' | 'sendJson'>

/**
 * Handle the inventory demand forecast surface.
 *
 * `GET /api/inventory-items/:id/forecast?weeks=6`
 *
 * Returns a per-week projection over the requested horizon (default 6, capped
 * 1..26). Each row reports the projected on-rent quantity (sum of active
 * `job_rental_lines.quantity` whose [on_rent_date, off_rent_date] window
 * overlaps the week), and the projected idle quantity (total tracked stock
 * minus projected on-rent, clamped at zero).
 *
 * The query is intentionally pure SQL so it can run inside a single round
 * trip and the worker can pick up the same shape later for proactive
 * over-commit alerts.
 */
export async function handleInventoryForecastRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: InventoryForecastRouteCtx,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/inventory-items\/([^/]+)\/forecast$/)
  if (!(req.method === 'GET' && match)) return false

  const itemId = match[1]!
  const weeksParam = url.searchParams.get('weeks')
  const weeks = Math.max(1, Math.min(26, Math.floor(Number(weeksParam ?? 6))))
  if (!Number.isFinite(weeks)) {
    ctx.sendJson(400, { error: 'weeks must be a positive integer' })
    return true
  }

  // Confirm the item exists for this company before running the projection so
  // a typo doesn't get a misleading "all zeros" response.
  const itemCheck = await withCompanyClient(ctx.company.id, (c) =>
    c.query<{ id: string }>(`select id from inventory_items where company_id = $1 and id = $2 and deleted_at is null`, [
      ctx.company.id,
      itemId,
    ]),
  )
  if (!itemCheck.rows[0]) {
    ctx.sendJson(404, { error: 'inventory_item not found' })
    return true
  }

  const result = await withCompanyClient(ctx.company.id, (c) =>
    c.query<{
      week_start: string
      projected_on_rent_qty: string
      projected_idle_qty: string
    }>(
      `
    with weeks as (
      select
        gs::int as week_index,
        (date_trunc('week', current_date)::date + (gs * 7))::date as week_start,
        (date_trunc('week', current_date)::date + (gs * 7) + 6)::date as week_end
      from generate_series(0, $3 - 1) as gs
    ),
    stock as (
      select coalesce(sum(
        case
          when m.to_location_id is not null and coalesce(tl.location_type, '') not in ('lost', 'damaged') then m.quantity
          else 0
        end
        -
        case
          when m.from_location_id is not null and coalesce(fl.location_type, '') not in ('lost', 'damaged') then m.quantity
          else 0
        end
      ), 0)::numeric(12,2) as total_stock
      from inventory_movements m
      left join inventory_locations fl on fl.company_id = m.company_id and fl.id = m.from_location_id
      left join inventory_locations tl on tl.company_id = m.company_id and tl.id = m.to_location_id
      where m.company_id = $1 and m.inventory_item_id = $2
    ),
    rental_window as (
      select
        l.quantity::numeric(12,2) as quantity,
        l.on_rent_date as start_date,
        coalesce(l.off_rent_date, current_date + ($3 * 7)) as end_date
      from job_rental_lines l
      join job_rental_contracts c
        on c.company_id = l.company_id and c.id = l.contract_id and c.deleted_at is null
      where l.company_id = $1
        and l.inventory_item_id = $2
        and l.deleted_at is null
        and l.status = 'active'
    ),
    schedule_window as (
      -- crew_schedules feed the projection by surfacing dates where a project
      -- is staffed; we don't carry per-item demand on the schedule, so this
      -- subquery is a stub that returns no rows today. Keeping the join in
      -- place lets a future schedule-aware projection drop in without a
      -- route signature change.
      select 0::numeric(12,2) as quantity, current_date as start_date, current_date as end_date
      where false
    )
    select
      to_char(w.week_start, 'YYYY-MM-DD') as week_start,
      coalesce(sum(
        case
          when r.start_date <= w.week_end and r.end_date >= w.week_start then r.quantity
          else 0
        end
      ), 0)::numeric(12,2)::text as projected_on_rent_qty,
      greatest(
        (select total_stock from stock) -
        coalesce(sum(
          case
            when r.start_date <= w.week_end and r.end_date >= w.week_start then r.quantity
            else 0
          end
        ), 0),
        0
      )::numeric(12,2)::text as projected_idle_qty
    from weeks w
    left join rental_window r on r.start_date <= w.week_end and r.end_date >= w.week_start
    left join schedule_window s on false
    group by w.week_index, w.week_start
    order by w.week_index asc
    `,
      [ctx.company.id, itemId, weeks],
    ),
  )

  ctx.sendJson(200, {
    inventory_item_id: itemId,
    weeks: result.rows.map((r) => ({
      week_start: r.week_start,
      projected_on_rent_qty: r.projected_on_rent_qty,
      projected_idle_qty: r.projected_idle_qty,
    })),
  })
  return true
}

/**
 * Self-registered dispatch descriptor for the `inventory-forecast` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const inventoryForecastRouteDescriptor: DispatchRouteDescriptor = {
  name: 'inventory-forecast',
  order: 730,
  handle: ({ req, url, company, sendJson }) =>
    handleInventoryForecastRoutes(req, url, {
      company,
      sendJson,
    }),
}
