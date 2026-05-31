/**
 * Owner desktop rentals — the equipment yard at a glance (Desktop v2).
 * Reuses the same `useInventoryItems` catalog hook as the mobile rentals
 * catalog AND joins it to the real `useInventoryUtilization` rollup
 * (GET /api/inventory/utilization) so on-rent vs available, the headline
 * deployment %, and per-asset utilization bars all come from live
 * dispatch state instead of the old `active`-flag proxy. See
 * owner-dashboard.tsx for the d-content + '@/components/d' patterns.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useCreateInventoryItem,
  useInventoryItems,
  useInventoryUtilization,
  type InventoryItem,
  type UtilizationRow,
} from '@/lib/api/rentals'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DModal, type DColumn } from '@/components/d'
import { MButton, MInput, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

// Real dispatch-derived status. on_rent_quantity > 0 → the item type has
// units out on active rental lines; everything else with tracked stock is
// available in the yard. (Service is a fleet-level bucket in the
// utilization rollup; per-item service status has no endpoint yet — see
// the utilization screen + GAP LIST.)
type AssetStatus = 'available' | 'on-rent' | 'service'

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

/** Per-item view derived from the live utilization rollup, keyed by item id. */
interface AssetUtil {
  status: AssetStatus
  utilizationPct: number
  where: string
}

function utilFromRow(row: UtilizationRow | undefined): AssetUtil {
  const onRent = Number(row?.on_rent_quantity ?? 0) || 0
  const available = Number(row?.available_quantity ?? 0) || 0
  const total = onRent + available
  return {
    status: onRent > 0 ? 'on-rent' : 'available',
    utilizationPct: total > 0 ? Math.round((onRent / total) * 100) : 0,
    where: onRent > 0 ? 'On site' : 'Yard',
  }
}

export function OwnerRentals() {
  const navigate = useNavigate()
  const itemsQuery = useInventoryItems()
  const utilizationQuery = useInventoryUtilization()
  const createItem = useCreateInventoryItem()

  // Add-asset modal state. Code + description are the required fields (the
  // create endpoint defaults the rest); day rate is optional. Mirrors the
  // versioned rate-edit modal pattern in owner-rentals-asset.tsx.
  const [addOpen, setAddOpen] = useState(false)
  const [draftCode, setDraftCode] = useState('')
  const [draftDescription, setDraftDescription] = useState('')
  const [draftRate, setDraftRate] = useState('')

  const openAddAsset = () => {
    createItem.reset()
    setDraftCode('')
    setDraftDescription('')
    setDraftRate('')
    setAddOpen(true)
  }

  const parsedAddRate = Number(draftRate)
  const addRateValid = draftRate.trim() === '' || (Number.isFinite(parsedAddRate) && parsedAddRate >= 0)
  const canCreate =
    draftCode.trim() !== '' && draftDescription.trim() !== '' && addRateValid && !createItem.isPending

  const handleCreateAsset = () => {
    if (!canCreate) return
    createItem.mutate(
      {
        code: draftCode.trim(),
        description: draftDescription.trim(),
        ...(draftRate.trim() !== '' ? { default_rental_rate: parsedAddRate } : {}),
      },
      {
        onSuccess: (created) => {
          setAddOpen(false)
          // Drop straight onto the new asset's detail screen.
          navigate(`/desktop/rentals/${created.id}`)
        },
      },
    )
  }

  const assets = useMemo(
    () => (itemsQuery.data?.inventoryItems ?? []).filter((i) => !i.deleted_at),
    [itemsQuery.data?.inventoryItems],
  )

  // item id → live utilization row, so the table + KPIs read real state.
  const utilById = useMemo(() => {
    const map = new Map<string, UtilizationRow>()
    for (const row of utilizationQuery.data?.items ?? []) map.set(row.inventory_item_id, row)
    return map
  }, [utilizationQuery.data?.items])

  // Headline deployment rollup — the API already computes the fleet
  // utilization_pct (on-rent quantity / total owned stock); fall back to a
  // per-item-type count while the rollup is loading.
  const { total, onRent, available, utilizationPct } = useMemo(() => {
    const total = assets.length
    const onRent = assets.filter((i) => utilFromRow(utilById.get(i.id)).status === 'on-rent').length
    const available = total - onRent
    const fleetPct = utilizationQuery.data?.totals?.utilization_pct
    return {
      total,
      onRent,
      available,
      utilizationPct:
        typeof fleetPct === 'number' ? Math.round(fleetPct) : total > 0 ? Math.round((onRent / total) * 100) : 0,
    }
  }, [assets, utilById, utilizationQuery.data?.totals?.utilization_pct])

  // Column order mirrors the design: ASSET · TAG · WHERE · UTIL · RATE · STATUS
  // (status is the right-most, right-aligned status-pill column). The repo's
  // CATEGORY column is dropped — the design surfaces WHERE/UTIL instead.
  const columns: Array<DColumn<InventoryItem>> = [
    { key: 'asset', header: 'Asset', render: (r) => <span className="d-table-cell-strong">{r.description}</span> },
    {
      key: 'tag',
      header: 'Tag',
      render: (r) => (
        <span className="num" style={{ fontSize: 12, color: 'var(--m-ink-2)' }}>
          {r.code}
        </span>
      ),
    },
    { key: 'where', header: 'Where', render: (r) => utilFromRow(utilById.get(r.id)).where },
    {
      key: 'util',
      header: 'Util',
      render: (r) => {
        const pct = utilFromRow(utilById.get(r.id)).utilizationPct
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              aria-hidden
              style={{
                flex: 1,
                minWidth: 48,
                height: 6,
                background: 'var(--m-line)',
                border: '1px solid var(--m-ink)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.min(100, Math.max(0, pct))}%`,
                  height: '100%',
                  background: 'var(--m-accent)',
                }}
              />
            </div>
            <span className="num" style={{ minWidth: 36, textAlign: 'right' }}>
              {pct}%
            </span>
          </div>
        )
      },
    },
    {
      key: 'rate',
      header: 'Rate',
      numeric: true,
      render: (r) => `${formatMoney(r.default_rental_rate)}/${r.unit || 'day'}`,
    },
    {
      key: 'status',
      header: 'Status',
      numeric: true,
      render: (r) => {
        const status = utilFromRow(utilById.get(r.id)).status
        return (
          <MPill tone={statusTone(status)} dot>
            {status}
          </MPill>
        )
      },
    },
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
          action={
            <MButton size="sm" variant="primary" onClick={openAddAsset}>
              + ADD ASSET
            </MButton>
          }
          columns={columns}
          rows={assets}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/desktop/rentals/${r.id}`)}
          empty="No equipment yet. Assets land here once inventory is added."
        />
      </div>

      {/* Add asset — POST /api/inventory/items via useCreateInventoryItem.
          Code + description are required; an optional day rate seeds the
          catalog rate. On success we land on the new asset's detail screen. */}
      <DModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add asset"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <MButton variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </MButton>
            <MButton variant="primary" disabled={!canCreate} onClick={handleCreateAsset}>
              {createItem.isPending ? 'Adding…' : 'Add asset'}
            </MButton>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
            Asset name
            <MInput
              value={draftDescription}
              autoFocus
              onChange={(e) => setDraftDescription(e.currentTarget.value)}
              placeholder="e.g. Scaffold A · 24×8"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
            Tag / code
            <MInput
              value={draftCode}
              onChange={(e) => setDraftCode(e.currentTarget.value)}
              placeholder="e.g. SCF-001"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
            Day rate (optional)
            <MInput
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={draftRate}
              onChange={(e) => setDraftRate(e.currentTarget.value)}
              placeholder="0.00"
            />
          </label>
          {!addRateValid && draftRate.trim() !== '' ? (
            <div style={{ fontSize: 13, color: 'var(--m-red)', fontWeight: 600 }}>
              Enter a non-negative dollar amount.
            </div>
          ) : null}
          {createItem.isError ? (
            <div style={{ fontSize: 13, color: 'var(--m-red)', fontWeight: 600 }}>
              {createItem.error instanceof Error ? createItem.error.message : 'Could not add the asset.'}
            </div>
          ) : null}
        </div>
      </DModal>
    </div>
  )
}
