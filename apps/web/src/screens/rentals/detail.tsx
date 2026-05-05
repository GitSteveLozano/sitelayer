import { Link, useParams } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useInventoryItems, useInventoryMovements, useInventoryUtilization, type InventoryMovement } from '@/lib/api'

/**
 * `rnt-detail` — per-item detail view.
 *
 * Header: code + description + on-rent vs available pill.
 * Body: 30-day movement timeline, scan-stamped rows surfacing worker
 * + lat/lng + scanned_at when present.
 */
export function RentalsItemDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const items = useInventoryItems()
  const utilization = useInventoryUtilization()
  const movements = useInventoryMovements(id ? { itemId: id } : {})

  if (!id) {
    return (
      <div className="px-5 pt-8">
        <h1 className="font-display text-[22px] font-bold tracking-tight">No item</h1>
        <Link to="/rentals" className="text-accent text-[13px] font-medium">
          ← back to rentals
        </Link>
      </div>
    )
  }

  if (items.isPending || utilization.isPending) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading item…</div>
  }

  const item = items.data?.inventoryItems.find((i) => i.id === id)
  if (!item) {
    return (
      <div className="px-5 pt-8">
        <h1 className="font-display text-[22px] font-bold tracking-tight">Item not found</h1>
        <Link to="/rentals" className="text-accent text-[13px] font-medium">
          ← back to rentals
        </Link>
      </div>
    )
  }

  const util = utilization.data?.items.find((u) => u.inventory_item_id === id)
  const rows = movements.data?.inventoryMovements ?? []

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to="/rentals" className="text-[12px] text-ink-3">
          ← Rentals
        </Link>
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mt-2">{item.code}</div>
        <h1 className="mt-1 font-display text-[24px] font-bold tracking-tight leading-tight">{item.description}</h1>
        <div className="mt-2 flex items-center gap-2">
          <Pill tone={Number(util?.on_rent_quantity ?? 0) > 0 ? 'good' : 'default'}>
            {Number(util?.on_rent_quantity ?? 0).toFixed(0)} on rent
          </Pill>
          <Pill tone="default">{Number(util?.available_quantity ?? 0).toFixed(0)} avail</Pill>
          <span className="num text-[12px] text-ink-3">
            ${Number(item.default_rental_rate).toFixed(2)}/{item.unit}
          </span>
        </div>
      </div>

      <div className="px-4 pb-8 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Recent movements</div>
        {movements.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No movements yet.</div>
          </Card>
        ) : (
          rows.map((m) => <MovementRow key={m.id} movement={m} />)
        )}
        <div className="pt-2">
          <Attribution source="From inventory_movements (worker scan stamps included)" />
        </div>
      </div>
    </div>
  )
}

function MovementRow({ movement }: { movement: InventoryMovement }) {
  const label =
    movement.movement_type === 'deliver'
      ? 'Delivered'
      : movement.movement_type === 'return'
        ? 'Returned'
        : movement.movement_type === 'transfer'
          ? 'Transferred'
          : movement.movement_type === 'damage'
            ? 'Damaged'
            : movement.movement_type === 'loss'
              ? 'Lost'
              : 'Adjusted'
  const tone: 'good' | 'warn' | 'default' =
    movement.movement_type === 'damage' || movement.movement_type === 'loss'
      ? 'warn'
      : movement.movement_type === 'deliver'
        ? 'good'
        : 'default'
  return (
    <Card tight>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px] font-semibold">
            {label} · {Number(movement.quantity).toFixed(0)}
          </div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            {movement.project_name ?? 'no project'} · {movement.occurred_on}
          </div>
        </div>
        <Pill tone={tone}>{movement.movement_type}</Pill>
      </div>
      {movement.scanned_at ? (
        <div className="text-[11px] text-ink-3 mt-1">
          Scanned at{' '}
          {new Date(movement.scanned_at).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
          {movement.lat && movement.lng
            ? ` · ${Number(movement.lat).toFixed(4)}, ${Number(movement.lng).toFixed(4)}`
            : ''}
        </div>
      ) : null}
    </Card>
  )
}
