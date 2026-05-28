/**
 * Owner desktop rentals — utilization + service (Desktop v2).
 * A KPI strip (fleet avg util / 30d revenue / open service), then a
 * 2-column split: per-asset utilization table (underutilized rows
 * flagged red) on the left, a service log card on the right.
 *
 * Derives utilization + revenue from the same `useInventoryItems` data
 * hook as the mobile rentals catalog — there is no dispatch-state join
 * yet, so on-rent vs available comes from the placeholder `active` flag
 * (mirrors owner-rentals.tsx). There is no service API, so the service
 * log is an empty/derived list with a TODO. See owner-dashboard.tsx for
 * the d-content + '@/components/d' primitive patterns.
 */
import { useMemo } from 'react'
import { useInventoryItems, type InventoryItem } from '@/lib/api/rentals'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

// Underutilized threshold — rows below this get flagged red. Tune once
// true dispatch-state utilization is wired in.
const UNDERUTILIZED_PCT = 50

type AssetRow = {
  id: string
  asset: string
  utilizationPct: number
  // 30-day revenue estimate: daily rate × deployed days. Without a
  // dispatch ledger we approximate days from the utilization proxy.
  revenue: number
  underutilized: boolean
}

type ServiceEntry = {
  id: string
  date: string
  item: string
  status: 'done' | 'open'
}

function utilizationFor(item: InventoryItem): number {
  // Placeholder until a dispatch-state join exists: `active` assets sit
  // in the yard (low util), inactive ones are deployed (high util).
  return item.active ? 35 : 85
}

export function OwnerRentalsUtilization() {
  const itemsQuery = useInventoryItems()

  const assets = useMemo(
    () => (itemsQuery.data?.inventoryItems ?? []).filter((i) => !i.deleted_at),
    [itemsQuery.data?.inventoryItems],
  )

  const { rows, fleetAvgUtil, revenue30d } = useMemo(() => {
    const rows: AssetRow[] = assets.map((item) => {
      const utilizationPct = utilizationFor(item)
      const rate = Number(item.default_rental_rate ?? 0)
      const deployedDays = Math.round((utilizationPct / 100) * 30)
      return {
        id: item.id,
        asset: item.description,
        utilizationPct,
        revenue: rate * deployedDays,
        underutilized: utilizationPct < UNDERUTILIZED_PCT,
      }
    })
    const fleetAvgUtil =
      rows.length > 0 ? Math.round(rows.reduce((sum, r) => sum + r.utilizationPct, 0) / rows.length) : 0
    const revenue30d = rows.reduce((sum, r) => sum + r.revenue, 0)
    return { rows, fleetAvgUtil, revenue30d }
  }, [assets])

  // No service API yet — derived/empty list. TODO: wire a service-log
  // endpoint (inventory service tickets) and replace this stub.
  const serviceLog: ServiceEntry[] = useMemo(() => [], [])
  const openServiceCount = serviceLog.filter((s) => s.status === 'open').length

  const columns: Array<DColumn<AssetRow>> = [
    {
      key: 'asset',
      header: 'Asset',
      render: (r) => (
        <span className="d-table-cell-strong" style={r.underutilized ? { color: 'var(--m-red)' } : undefined}>
          {r.asset}
        </span>
      ),
    },
    {
      key: 'utilization',
      header: 'Utilization',
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            aria-hidden
            style={{
              flex: 1,
              height: 6,
              background: 'var(--m-line)',
              border: '1px solid var(--m-ink)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.min(100, Math.max(0, r.utilizationPct))}%`,
                height: '100%',
                background: r.underutilized ? 'var(--m-red)' : 'var(--m-accent)',
              }}
            />
          </div>
          <span className="num" style={{ minWidth: 36, textAlign: 'right' }}>
            {r.utilizationPct}%
          </span>
        </div>
      ),
    },
    {
      key: 'revenue',
      header: 'Revenue',
      numeric: true,
      render: (r) => formatMoney(r.revenue),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Rentals</DEyebrow>
          <DH1>Utilization + service.</DH1>
        </div>

        <DKpiStrip>
          <DKpi
            label="Fleet avg util"
            value={String(fleetAvgUtil)}
            unit="%"
            meta={`${assets.length} ${assets.length === 1 ? 'asset' : 'assets'}`}
          />
          <DKpi label="Revenue 30d" value={formatMoney(revenue30d)} meta="Estimated" />
          <DKpi
            label="Service open"
            value={String(openServiceCount)}
            tone={openServiceCount > 0 ? 'accent' : undefined}
            meta={openServiceCount > 0 ? 'Needs work' : 'All clear'}
            metaTone={openServiceCount > 0 ? 'bad' : 'good'}
          />
        </DKpiStrip>

        <div className="d-split">
          <DataTable<AssetRow>
            title="By asset"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            empty="No equipment yet. Assets land here once inventory is added."
          />

          <div className="d-card">
            <div
              className="d-table-head"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <span className="d-table-head-title">Service log</span>
              {/* TODO: wire to a service-ticket endpoint; no service API yet. */}
              <MButton size="sm" variant="ghost" onClick={() => {}}>
                + LOG
              </MButton>
            </div>
            {serviceLog.length === 0 ? (
              <div style={{ color: 'var(--m-ink-3)', fontSize: 14, marginTop: 12 }}>
                No service entries yet. Maintenance and repairs land here once a service ticket is logged.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                {serviceLog.map((entry) => (
                  <div
                    key={entry.id}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                  >
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{entry.date}</div>
                      <div style={{ fontWeight: 600 }}>{entry.item}</div>
                    </div>
                    <MPill tone={entry.status === 'done' ? 'green' : 'amber'} dot>
                      {entry.status}
                    </MPill>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
