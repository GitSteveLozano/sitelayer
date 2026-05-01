import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useInventoryItems, useInventoryUtilization, type UtilizationRow } from '@/lib/api'

/**
 * `rnt-list` — Rentals tab home.
 *
 * Hero: total idle revenue per day (the headline pain) + on-rent count.
 * Body: catalog rows ranked by idle dollars desc so the heaviest idle
 * assets sit at the top. The scan-dispatch FAB jumps to /rentals/scan.
 *
 * Persona scoping: foreman/owner see this view as-is. Workers go
 * straight to the scan flow (no list view in their tab).
 */
export function RentalsListScreen() {
  const utilization = useInventoryUtilization()
  const items = useInventoryItems()

  if (utilization.isPending || items.isPending) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading rentals…</div>
  }

  const totals = utilization.data?.totals
  const rows = utilization.data?.items ?? []
  const totalsCount = items.data?.inventoryItems.length ?? 0

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Rentals</div>
        <h1 className="mt-1 font-display text-[26px] font-bold tracking-tight leading-tight">Catalog</h1>
      </div>

      <div className="px-4">
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Idle revenue per day</div>
          <div className="num text-[28px] font-bold tracking-tight mt-1">
            ${((totals?.total_idle_revenue_per_day_cents ?? 0) / 100).toLocaleString()}
          </div>
          <div className="text-[12px] text-ink-3 mt-1">
            {Number(totals?.total_on_rent ?? 0).toFixed(0)} on rent · {Number(totals?.total_available ?? 0).toFixed(0)}{' '}
            available · {totalsCount} item{totalsCount === 1 ? '' : 's'}
          </div>
          <div className="mt-3">
            <Attribution source="From inventory_movements + active rental lines (no AI inference)" />
          </div>
        </Card>
      </div>

      <div className="px-4 pt-3 pb-2 grid grid-cols-2 gap-2.5">
        <Link to="/rentals/scan" className="block">
          <MobileButton variant="primary">Scan dispatch</MobileButton>
        </Link>
        <Link to="/rentals/utilization" className="block">
          <MobileButton variant="ghost">Utilization</MobileButton>
        </Link>
      </div>

      <div className="px-4 pt-2 pb-8 space-y-2">
        {rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No active inventory items yet.</div>
          </Card>
        ) : (
          rows.map((row) => <UtilizationRowCard key={row.inventory_item_id} row={row} />)
        )}
      </div>
    </div>
  )
}

function UtilizationRowCard({ row }: { row: UtilizationRow }) {
  const idle = row.idle_revenue_per_day_cents
  const tone: 'good' | 'warn' | 'default' = idle > 5000 ? 'warn' : idle > 0 ? 'default' : 'good'
  const idleDays = row.days_since_activity
  return (
    <Link to={`/rentals/items/${row.inventory_item_id}`} className="block">
      <Card tight>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold">{row.code}</div>
            <div className="text-[12px] text-ink-2 truncate">{row.description}</div>
            <div className="text-[11px] text-ink-3 mt-0.5">
              {Number(row.on_rent_quantity).toFixed(0)} on rent · {Number(row.available_quantity).toFixed(0)} avail
              {idleDays !== null ? ` · ${idleDays}d idle` : ''}
            </div>
          </div>
          <div className="text-right">
            <Pill tone={tone}>${(idle / 100).toFixed(2)}/day</Pill>
          </div>
        </div>
      </Card>
    </Link>
  )
}
