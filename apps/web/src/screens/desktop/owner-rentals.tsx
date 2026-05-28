/**
 * Owner desktop rentals — the equipment yard at a glance (Desktop v2).
 * Reuses the same `useInventoryItems` data hook as the mobile rentals
 * catalog; just a dense desktop composition. See owner-dashboard.tsx for
 * the d-content + '@/components/d' primitive patterns.
 */
import { useMemo } from 'react'
import { useInventoryItems, type InventoryItem } from '@/lib/api/rentals'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

// Without a dispatch-state join, "on-rent" vs "available" comes from the
// placeholder `active` flag (mirrors the mobile catalog). Tune once true
// dispatch state is wired in.
type AssetStatus = 'available' | 'on-rent' | 'service'

function assetStatus(item: InventoryItem): AssetStatus {
  return item.active ? 'available' : 'on-rent'
}

function statusTone(status: AssetStatus): 'green' | 'amber' | 'blue' {
  switch (status) {
    case 'available':
      return 'green'
    case 'on-rent':
      return 'amber'
    case 'service':
      return 'blue'
  }
}

function assetLocation(item: InventoryItem): string {
  return item.active ? 'Yard' : 'On site'
}

export function OwnerRentals() {
  const itemsQuery = useInventoryItems()

  const assets = useMemo(
    () => (itemsQuery.data?.inventoryItems ?? []).filter((i) => !i.deleted_at),
    [itemsQuery.data?.inventoryItems],
  )

  const { total, onRent, available, utilizationPct } = useMemo(() => {
    const total = assets.length
    const onRent = assets.filter((i) => assetStatus(i) === 'on-rent').length
    const available = assets.filter((i) => assetStatus(i) === 'available').length
    return {
      total,
      onRent,
      available,
      utilizationPct: total > 0 ? Math.round((onRent / total) * 100) : 0,
    }
  }, [assets])

  const columns: Array<DColumn<InventoryItem>> = [
    { key: 'asset', header: 'Asset', render: (r) => <span className="d-table-cell-strong">{r.description}</span> },
    { key: 'category', header: 'Category', render: (r) => r.category },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const status = assetStatus(r)
        return (
          <MPill tone={statusTone(status)} dot>
            {status}
          </MPill>
        )
      },
    },
    {
      key: 'rate',
      header: 'Rate',
      numeric: true,
      render: (r) => `${formatMoney(r.default_rental_rate)}/day`,
    },
    { key: 'location', header: 'Location', render: (r) => assetLocation(r) },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Rentals</DEyebrow>
          <DH1>
            {total} {total === 1 ? 'asset' : 'assets'} in the yard.
          </DH1>
        </div>

        <DKpiStrip>
          <DKpi label="Total assets" value={String(total)} meta="Owned equipment" />
          <DKpi
            label="On rent"
            value={String(onRent)}
            tone="accent"
            meta={onRent > 0 ? 'Deployed' : 'None out'}
            metaTone={onRent > 0 ? 'good' : undefined}
          />
          <DKpi label="Available" value={String(available)} meta="In yard" />
          <DKpi label="Utilization" value={String(utilizationPct)} unit="%" meta={`${onRent} of ${total} out`} />
        </DKpiStrip>

        <DataTable<InventoryItem>
          title="Assets"
          columns={columns}
          rows={assets}
          rowKey={(r) => r.id}
          empty="No equipment yet. Assets land here once inventory is added."
        />
      </div>
    </div>
  )
}
