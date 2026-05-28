/**
 * Rentals · Asset detail — `rent-asset`. Single-asset view for a rental
 * yard item: utilization / day-rate KPI row, quick-action tiles
 * (dispatch / return / flag-for-service), and a recent-movements list.
 *
 * Mirrors Steve's v2 brutalist `V2RentAsset` layout (square borders,
 * big-number stats, mono micro-labels) using the repo `m` primitives +
 * `var(--m-*)` tokens. There is no single-asset endpoint — the asset is
 * located in the inventory list (`useInventoryItems`) by `:assetId`.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useInventoryItems, type InventoryItem } from '@/lib/api'
import { MBody, MI, MKpi, MKpiRow, MListInset, MListRow, MPill, MSectionH, MTopBar } from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney } from './format.js'

export function MobileRentalsAsset() {
  const navigate = useNavigate()
  const { assetId } = useParams<{ assetId: string }>()
  const { data, isLoading, error } = useInventoryItems()
  const [flagged, setFlagged] = useState(false)

  const item = useMemo<InventoryItem | undefined>(
    () => data?.inventoryItems.find((i) => i.id === assetId),
    [data, assetId],
  )

  if (isLoading) {
    return (
      <>
        <MTopBar back title="Asset" onBack={() => navigate(-1)} />
        <MBody>
          <MSkeletonList count={3} />
        </MBody>
      </>
    )
  }

  if (error || !item) {
    return (
      <>
        <MTopBar back title="Asset" onBack={() => navigate(-1)} />
        <MBody>
          <MEmptyState
            title="Asset not found"
            body={
              error instanceof Error
                ? error.message
                : 'This rental asset is no longer in your inventory, or the link is stale.'
            }
            primaryLabel="Back to rentals"
            onPrimary={() => navigate('/rentals')}
          />
        </MBody>
      </>
    )
  }

  const out = !item.active
  // Placeholder utilization until a real /api/dispatch state join lands:
  // an out item reads "deployed" (100%), an in-yard item reads idle (0%).
  const utilizationPct = out ? 100 : 0
  const dayRate = Number(item.default_rental_rate ?? 0)
  const monogram = (item.code.split(/[-\s]/)[0] || item.code).slice(0, 3).toUpperCase()

  // No movement endpoint is wired for a single asset yet — derive a thin
  // history from what the catalog row carries, else fall through to the
  // empty state. created_at is the only durable timestamp on the item.
  const movements = useMemo(() => {
    const rows: { id: string; label: string; meta: string }[] = []
    if (item.created_at) {
      rows.push({
        id: 'added',
        label: 'Added to inventory',
        meta: formatDateLabel(item.created_at),
      })
    }
    if (item.updated_at && item.updated_at !== item.created_at) {
      rows.push({
        id: 'updated',
        label: out ? 'Dispatched from yard' : 'Returned to yard',
        meta: formatDateLabel(item.updated_at),
      })
    }
    return rows
  }, [item, out])

  return (
    <>
      <MTopBar back eyebrow={item.code} title={item.description} sub={item.category} onBack={() => navigate(-1)} />
      <MBody>
        <div style={{ padding: '14px 16px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className="m-l-leading num"
            data-tone={out ? 'amber' : 'green'}
            style={{ width: 40, height: 40, fontWeight: 700 }}
          >
            {monogram}
          </span>
          <MPill tone={out ? 'amber' : 'green'} dot>
            {out ? 'out' : 'in yard'}
          </MPill>
          {flagged ? (
            <MPill tone="red" dot>
              flagged
            </MPill>
          ) : null}
        </div>

        <div style={{ padding: '12px 16px 0' }}>
          <MKpiRow cols={2}>
            <MKpi label="Utilization" value={`${utilizationPct}`} unit="%" meta={out ? 'Deployed' : 'Idle'} />
            <MKpi label="Day rate" value={formatMoney(dayRate)} meta={`per ${item.unit || 'day'}`} />
          </MKpiRow>
        </div>

        <MSectionH>Quick actions</MSectionH>
        <div className="m-qa-grid">
          <button type="button" className="m-qa" onClick={() => navigate('/rentals/dispatch')}>
            <span className="m-qa-icon">
              <MI.Truck size={18} />
            </span>
            <span className="m-qa-label">Dispatch</span>
          </button>
          <button type="button" className="m-qa" onClick={() => navigate('/rentals/return')}>
            <span className="m-qa-icon">
              <MI.Check size={18} />
            </span>
            <span className="m-qa-label">Scan / return</span>
          </button>
          <button
            type="button"
            className="m-qa"
            onClick={() => setFlagged((f) => !f)}
            style={flagged ? { color: 'var(--m-red)' } : undefined}
          >
            <span className="m-qa-icon">
              <MI.AlertTri size={18} />
            </span>
            <span className="m-qa-label">{flagged ? 'Flagged' : 'Flag for service'}</span>
          </button>
        </div>

        <MSectionH>Recent movements</MSectionH>
        <div style={{ paddingBottom: 80 }}>
          {movements.length === 0 ? (
            <MEmptyState title="No movements yet" body="Dispatch or return this asset to start its movement history." />
          ) : (
            <MListInset>
              {movements.map((m) => (
                <MListRow
                  key={m.id}
                  headline={m.label}
                  trailing={
                    <span className="num" style={{ color: 'var(--m-ink-3)', fontSize: 12 }}>
                      {m.meta}
                    </span>
                  }
                />
              ))}
            </MListInset>
          )}
        </div>
      </MBody>
    </>
  )
}

function formatDateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
