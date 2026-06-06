import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution, Spark } from '@/components/ai'
import { useInventoryUtilization, type UtilizationRow } from '@/lib/api'

/**
 * `rnt-utilization` — owner/foreman utilization dashboard.
 *
 * Three-block layout:
 *   1. Idle revenue per day hero ($) + on-rent / available counts
 *   2. Heaviest idle items (top 5 by $/day)
 *   3. Stalest assets (top 5 by days_since_activity)
 *
 * Following the AI Layer rules: every number cites its source via
 * Attribution; no speculative recommendations — the agent's job is
 * to surface, not to prescribe.
 */
export function RentalsUtilizationScreen() {
  const utilization = useInventoryUtilization()

  if (utilization.isPending) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading utilization…</div>
  }

  const totals = utilization.data?.totals
  const items = utilization.data?.items ?? []

  const topIdle = items.filter((i) => i.idle_revenue_per_day_cents > 0).slice(0, 5)
  const topStale = [...items]
    .filter((i) => i.days_since_activity !== null)
    .sort((a, b) => (b.days_since_activity ?? 0) - (a.days_since_activity ?? 0))
    .slice(0, 5)

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to="/rentals" className="text-[12px] text-ink-3">
          ← Rentals
        </Link>
        <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Utilization</h1>
        <p className="text-[12px] text-ink-3 mt-1">30-day rollup, ranked by idle dollars.</p>
      </div>

      <div className="px-4 pb-8 space-y-3">
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <Spark state="accent" size={12} aria-label="" />
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Idle revenue per day</div>
          </div>
          <div className="num text-[28px] font-bold tracking-tight">
            ${((totals?.total_idle_revenue_per_day_cents ?? 0) / 100).toLocaleString()}
          </div>
          <div className="text-[12px] text-ink-3 mt-1">
            {Number(totals?.total_on_rent ?? 0).toFixed(0)} on rent · {Number(totals?.total_available ?? 0).toFixed(0)}{' '}
            available across {items.length} item{items.length === 1 ? '' : 's'}
          </div>
        </Card>

        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pt-2">
          Heaviest idle dollars
        </div>
        {topIdle.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Nothing idle today.</div>
          </Card>
        ) : (
          topIdle.map((row) => <CompactRow key={row.inventory_item_id} row={row} mode="idle" />)
        )}

        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pt-2">Stalest assets</div>
        {topStale.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No movement history yet.</div>
          </Card>
        ) : (
          topStale.map((row) => <CompactRow key={row.inventory_item_id} row={row} mode="stale" />)
        )}

        <Attribution source="GET /api/inventory/utilization" />
      </div>
    </div>
  )
}

function CompactRow({ row, mode }: { row: UtilizationRow; mode: 'idle' | 'stale' }) {
  const idle = row.idle_revenue_per_day_cents
  return (
    <Link to={`/rentals/items/${row.inventory_item_id}`} className="block">
      <Card tight>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold">{row.code}</div>
            <div className="text-[11px] text-ink-3 mt-0.5">{row.description}</div>
          </div>
          {mode === 'idle' ? (
            <Pill tone={idle > 5000 ? 'warn' : 'default'}>${(idle / 100).toFixed(2)}/day</Pill>
          ) : (
            <Pill tone={(row.days_since_activity ?? 0) > 30 ? 'warn' : 'default'}>{row.days_since_activity}d idle</Pill>
          )}
        </div>
      </Card>
    </Link>
  )
}
