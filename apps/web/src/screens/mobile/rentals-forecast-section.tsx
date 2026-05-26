/**
 * Forecast section of the rentals dashboard. Projects, per inventory
 * item, the next 6 weeks of on-rent vs idle quantity so the owner can
 * see where demand is heading and which weeks leave stock sitting idle.
 *
 * Data comes from GET /api/inventory-items/:id/forecast via
 * `useInventoryForecast`, shaped by `selectForecastPoints`. The item is
 * picked from the availability rows already on screen, so no extra
 * catalog fetch is needed.
 */
import { useState } from 'react'
import { MChip, MChipRow, MKpi, MKpiRow, MSectionH } from '../../components/m/index.js'
import { MBanner, MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { selectForecastPoints, useInventoryForecast, type ForecastPoint } from '@/lib/api/inventory-availability'
import type { AvailabilityRow } from '@/lib/api/inventory-availability'

const WEEKS = 6

export function RentalsForecastSection({ items }: { items: readonly AvailabilityRow[] }) {
  // Default to the heaviest-utilized item so the chart opens on something
  // interesting; fall back to the first stocked item.
  const ranked = [...items].sort((a, b) => b.utilization_pct - a.utilization_pct)
  const [selectedId, setSelectedId] = useState<string | null>(ranked[0]?.inventory_item_id ?? null)
  const selected = items.find((i) => i.inventory_item_id === selectedId) ?? ranked[0] ?? null

  const forecast = useInventoryForecast(selected?.inventory_item_id, WEEKS)

  if (items.length === 0) {
    return (
      <MEmptyState
        title="Nothing to forecast"
        body="Add inventory with rental lines to project demand over the coming weeks."
      />
    )
  }

  const points = selectForecastPoints(forecast.data)

  return (
    <>
      <MSectionH>Pick an item</MSectionH>
      <div style={{ padding: '0 16px' }}>
        <MChipRow>
          {ranked.slice(0, 10).map((item) => (
            <MChip
              key={item.inventory_item_id}
              active={item.inventory_item_id === selected?.inventory_item_id}
              onClick={() => setSelectedId(item.inventory_item_id)}
            >
              {item.code}
            </MChip>
          ))}
        </MChipRow>
      </div>

      {forecast.isLoading ? (
        <div style={{ marginTop: 12 }}>
          <MSkeletonList count={3} />
        </div>
      ) : forecast.isError ? (
        <div style={{ padding: '12px 16px' }}>
          <MBanner
            tone="error"
            title="Couldn't load forecast"
            body="The demand projection didn't come back. Pull to retry."
          />
        </div>
      ) : points.length === 0 ? (
        <MEmptyState
          title="No projection"
          body="No active rental lines fall inside the forecast window for this item."
        />
      ) : (
        <ForecastBody item={selected} points={points} />
      )}
    </>
  )
}

function ForecastBody({ item, points }: { item: AvailabilityRow | null; points: readonly ForecastPoint[] }) {
  const peak = points.reduce((m, p) => Math.max(m, p.capacity, p.projected_on_rent), 0)
  const peakOnRent = points.reduce((m, p) => Math.max(m, p.projected_on_rent), 0)
  const overCommittedWeeks = points.filter((p) => item && p.projected_on_rent > item.total_quantity).length
  const idleWeeks = points.filter((p) => p.projected_idle > 0).length

  return (
    <>
      <div style={{ padding: '12px 16px 0' }}>
        <MKpiRow cols={3}>
          <MKpi label="Peak demand" value={fmtQty(peakOnRent)} meta={`over ${points.length} wks`} />
          <MKpi
            label="Idle weeks"
            value={String(idleWeeks)}
            meta="stock sits"
            metaTone={idleWeeks > 0 ? 'amber' : 'green'}
          />
          <MKpi
            label="Over-committed"
            value={String(overCommittedWeeks)}
            meta="weeks short"
            metaTone={overCommittedWeeks > 0 ? 'red' : 'green'}
          />
        </MKpiRow>
      </div>

      {overCommittedWeeks > 0 && item ? (
        <div style={{ padding: '12px 16px 0' }}>
          <MBanner
            tone="warn"
            title={`${overCommittedWeeks} week${overCommittedWeeks === 1 ? '' : 's'} over capacity`}
            body={`Projected demand for ${item.code} tops the ${fmtQty(item.total_quantity)} units you track. Line up a transfer or sub-rental before those weeks.`}
          />
        </div>
      ) : null}

      <MSectionH>Next {points.length} weeks</MSectionH>
      <div style={{ padding: '0 16px 8px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {points.map((p) => (
          <ForecastWeekBar
            key={p.week_start}
            point={p}
            peak={peak}
            overCapacity={Boolean(item && p.projected_on_rent > item.total_quantity)}
          />
        ))}
      </div>
    </>
  )
}

function ForecastWeekBar({ point, peak, overCapacity }: { point: ForecastPoint; peak: number; overCapacity: boolean }) {
  const onRentPct = peak > 0 ? Math.min(100, (point.projected_on_rent / peak) * 100) : 0
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--m-ink-2)' }}>{weekLabel(point.week_start)}</span>
        <span className="num" style={{ fontSize: 12 }}>
          {fmtQty(point.projected_on_rent)} out · {fmtQty(point.projected_idle)} idle
        </span>
      </div>
      <div className="m-progress" aria-label={`Projected ${fmtQty(point.projected_on_rent)} on rent`}>
        <div
          className="m-progress-fill"
          style={{
            width: `${onRentPct}%`,
            background: overCapacity ? 'var(--m-red)' : 'var(--m-accent)',
          }}
        />
      </div>
    </div>
  )
}

function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function weekLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const date = new Date(y, m - 1, d)
  return `Wk of ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}
