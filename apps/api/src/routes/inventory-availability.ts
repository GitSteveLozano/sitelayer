import type http from 'node:http'
import type { RentalInventoryRouteCtx } from './rental-inventory.types.js'

/**
 * Handle the inventory availability surface.
 *
 * `GET /api/inventory/items/availability` — one row per inventory item with
 * tracked stock from the movement ledger plus active-rental rollups.
 *
 * `total_stock_quantity` is the net balance across usable locations
 * (yard/job/in_transit/repair). `available_quantity` is total stock minus
 * active job-rental quantity, clamped at zero so legacy data without opening
 * stock adjustments does not display negative availability. The clamp is
 * also what gives us safe concurrent-checkout semantics — racing rental
 * lines can never make availability dip below zero in the response.
 */
export async function handleInventoryAvailabilityRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalInventoryRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/inventory/items/availability') {
    const result = await ctx.pool.query<{
      inventory_item_id: string
      total_stock_quantity: string
      available_quantity: string
      yard_quantity: string
      on_rent_quantity: string
      on_rent_lines: number
      on_rent_projects: number
    }>(
      `
      with active_rentals as (
        select
          l.inventory_item_id,
          coalesce(sum(l.quantity), 0)::numeric(12,2) as on_rent_quantity,
          count(*)::int as on_rent_lines,
          count(distinct c.project_id)::int as on_rent_projects
        from job_rental_lines l
        join job_rental_contracts c
          on c.company_id = l.company_id and c.id = l.contract_id and c.deleted_at is null
        where l.company_id = $1
          and l.deleted_at is null
          and l.off_rent_date is null
          and l.status = 'active'
        group by l.inventory_item_id
      ),
      movement_balances as (
        select
          m.inventory_item_id,
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
          ), 0)::numeric(12,2) as total_stock_quantity,
          coalesce(sum(
            case when m.to_location_id is not null and tl.location_type = 'yard' then m.quantity else 0 end
            -
            case when m.from_location_id is not null and fl.location_type = 'yard' then m.quantity else 0 end
          ), 0)::numeric(12,2) as yard_quantity
        from inventory_movements m
        left join inventory_locations fl on fl.company_id = m.company_id and fl.id = m.from_location_id
        left join inventory_locations tl on tl.company_id = m.company_id and tl.id = m.to_location_id
        where m.company_id = $1
        group by m.inventory_item_id
      )
      select
        i.id as inventory_item_id,
        coalesce(b.total_stock_quantity, 0)::numeric(12,2)::text as total_stock_quantity,
        greatest(
          coalesce(b.total_stock_quantity, 0) - coalesce(a.on_rent_quantity, 0),
          0
        )::numeric(12,2)::text as available_quantity,
        coalesce(b.yard_quantity, 0)::numeric(12,2)::text as yard_quantity,
        coalesce(a.on_rent_quantity, 0)::numeric(12,2)::text as on_rent_quantity,
        coalesce(a.on_rent_lines, 0)::int as on_rent_lines,
        coalesce(a.on_rent_projects, 0)::int as on_rent_projects
      from inventory_items i
      left join active_rentals a on a.inventory_item_id = i.id
      left join movement_balances b on b.inventory_item_id = i.id
      where i.company_id = $1 and i.deleted_at is null
      order by i.code asc
      `,
      [ctx.company.id],
    )
    ctx.sendJson(200, { availability: result.rows })
    return true
  }

  return false
}
