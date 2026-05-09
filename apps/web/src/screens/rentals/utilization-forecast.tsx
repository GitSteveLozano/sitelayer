import { Card } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useInventoryForecast, type ForecastWeek } from '@/lib/api'

/**
 * `rnt-utilization-forecast` — 6-bar SVG demand forecast for a single
 * inventory item. Rendered inline in `utilization.tsx` (per-row drilldown
 * or the heaviest-idle list item).
 *
 * The chart is intentionally lightweight: one bar per week showing
 * projected on-rent vs idle quantity. No tooltip interactions, no axis
 * labels beyond the week start dates — the goal is a read-only fingerprint
 * of the demand curve, not a full BI surface.
 */
export interface UtilizationForecastProps {
  inventoryItemId: string
  /** Optional label rendered above the chart. */
  itemLabel?: string
  weeks?: number
}

export function UtilizationForecast({ inventoryItemId, itemLabel, weeks = 6 }: UtilizationForecastProps) {
  const forecast = useInventoryForecast(inventoryItemId, weeks)

  if (forecast.isPending) {
    return (
      <Card tight>
        <div className="text-[12px] text-ink-3">Loading forecast…</div>
      </Card>
    )
  }
  if (forecast.isError || !forecast.data) {
    return (
      <Card tight>
        <div className="text-[12px] text-warn">{forecast.error?.message ?? 'Forecast unavailable'}</div>
      </Card>
    )
  }

  const series: ForecastWeek[] = forecast.data.weeks
  if (series.length === 0) {
    return (
      <Card tight>
        <div className="text-[12px] text-ink-3">No forecast data yet — add active contract lines first.</div>
      </Card>
    )
  }

  const totals = series.map((w) => Number(w.projected_on_rent_qty) + Number(w.projected_idle_qty))
  const maxTotal = Math.max(1, ...totals)

  // SVG geometry: simple horizontal bar series. 720x140 fits the standard
  // mobile content width comfortably; the parent decides the wrapping.
  const W = 720
  const H = 140
  const padL = 36
  const padR = 12
  const padT = 12
  const padB = 28
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const slotW = innerW / series.length
  const barW = Math.max(8, slotW * 0.6)

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Demand forecast</div>
          {itemLabel ? <div className="text-[13px] font-semibold mt-0.5">{itemLabel}</div> : null}
        </div>
        <div className="text-[11px] text-ink-3">{series.length} weeks</div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 360, display: 'block' }}>
          <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke="var(--line)" strokeWidth="0.5" />
          {[0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line
                x1={padL}
                x2={W - padR}
                y1={padT + innerH * (1 - t)}
                y2={padT + innerH * (1 - t)}
                stroke="var(--line)"
                strokeWidth="0.3"
                strokeDasharray="2 4"
              />
              <text
                x={padL - 6}
                y={padT + innerH * (1 - t) + 3}
                fontSize="9"
                fill="var(--ink-3)"
                textAnchor="end"
                fontFamily="Geist Mono, monospace"
              >
                {Math.round(maxTotal * t)}
              </text>
            </g>
          ))}
          {series.map((w, i) => {
            const onRent = Number(w.projected_on_rent_qty)
            const idle = Number(w.projected_idle_qty)
            const total = onRent + idle
            const x = padL + slotW * i + (slotW - barW) / 2
            const onRentH = total > 0 ? (onRent / maxTotal) * innerH : 0
            const idleH = total > 0 ? (idle / maxTotal) * innerH : 0
            const onRentY = padT + innerH - onRentH
            const idleY = padT + innerH - onRentH - idleH
            // Format week-start label as M/D so multiple weeks don't crowd.
            const labelDate = (() => {
              const d = new Date(w.week_start)
              return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
            })()
            return (
              <g key={w.week_start}>
                {idle > 0 ? (
                  <rect x={x} y={idleY} width={barW} height={idleH} fill="var(--good, #6F8F5C)" opacity={0.45} />
                ) : null}
                {onRent > 0 ? (
                  <rect x={x} y={onRentY} width={barW} height={onRentH} fill="var(--accent, #C77B4F)" />
                ) : null}
                <text
                  x={x + barW / 2}
                  y={H - 10}
                  fontSize="10"
                  fill="var(--ink-2)"
                  textAnchor="middle"
                  fontFamily="Geist Mono, monospace"
                >
                  {labelDate}
                </text>
                {onRent > 0 ? (
                  <text
                    x={x + barW / 2}
                    y={onRentY - 3}
                    fontSize="9"
                    fill="var(--accent, #C77B4F)"
                    textAnchor="middle"
                    fontFamily="Geist Mono, monospace"
                    fontWeight="600"
                  >
                    {onRent.toFixed(0)}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      </div>
      <div className="flex items-center gap-3 mt-2 text-[11px] text-ink-3">
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm" style={{ background: 'var(--accent, #C77B4F)' }} />
          Projected on-rent
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm" style={{ background: 'var(--good, #6F8F5C)', opacity: 0.45 }} />
          Projected idle
        </span>
      </div>
      <div className="mt-2">
        <Attribution source="GET /api/inventory-items/:id/forecast — active contract overlap, weekly bucket" />
      </div>
    </Card>
  )
}
