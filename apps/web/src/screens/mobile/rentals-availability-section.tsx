/**
 * Availability section of the rentals dashboard. Shows, per inventory
 * item, how many units are on rent right now vs sitting in stock — the
 * "what can I send out today" view for the owner/dispatcher.
 *
 * Data comes from the shared /api/inventory/utilization payload, shaped
 * by `selectAvailabilityRows` / `selectAvailabilitySummary`.
 */
import { MI, MKpi, MKpiRow, MListInset, MListRow, MPill, MSectionH } from '../../components/m/index.js'
import { MEmptyState } from '../../components/m-states/index.js'
import type { AvailabilityRow, AvailabilitySummary } from '@/lib/api/inventory-availability'

function fmtQty(n: number, unit: string): string {
  const v = Number.isInteger(n) ? String(n) : n.toFixed(2)
  return `${v} ${unit || 'ea'}`
}

export function RentalsAvailabilitySection({
  rows,
  summary,
}: {
  rows: readonly AvailabilityRow[]
  summary: AvailabilitySummary
}) {
  if (rows.length === 0) {
    return (
      <MEmptyState
        title="No tracked stock yet"
        body="Once items have movements and rental lines, on-rent vs in-stock balances show here."
      />
    )
  }

  return (
    <>
      <div style={{ padding: '0 16px' }}>
        <MKpiRow cols={3}>
          <MKpi label="On rent" value={fmtQtyShort(summary.total_on_rent)} meta="units out" />
          <MKpi
            label="Available"
            value={fmtQtyShort(summary.total_available)}
            meta="ready to send"
            metaTone={summary.total_available > 0 ? 'green' : undefined}
          />
          <MKpi
            label="Fully out"
            value={String(summary.fully_deployed_count)}
            meta={`of ${summary.stocked_item_count} types`}
            metaTone={summary.fully_deployed_count > 0 ? 'amber' : 'green'}
          />
        </MKpiRow>
      </div>
      <MSectionH>On rent vs in stock</MSectionH>
      <MListInset>
        {rows.map((r) => {
          const out = r.available_quantity <= 0
          return (
            <MListRow
              key={r.inventory_item_id}
              leading={<MI.Layers size={18} />}
              leadingTone={out ? 'amber' : 'green'}
              headline={r.description}
              supporting={
                <>
                  {r.code} · {fmtQty(r.on_rent_quantity, r.unit)} out · {fmtQty(r.available_quantity, r.unit)} in stock
                </>
              }
              trailing={
                out ? (
                  <MPill tone="amber" dot>
                    All out
                  </MPill>
                ) : (
                  <span className="num">{r.utilization_pct}%</span>
                )
              }
            />
          )
        })}
      </MListInset>
    </>
  )
}

function fmtQtyShort(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1)
}
