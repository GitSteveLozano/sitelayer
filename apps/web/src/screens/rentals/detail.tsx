import { Link, useParams } from 'react-router-dom'
import { MButton, MPill, type MTone } from '@/components/m'
import { Attribution } from '@/components/ai'
import { useInventoryItems, useInventoryMovements, useInventoryUtilization, type InventoryMovement } from '@/lib/api'
import { getActiveCompanySlug } from '@/lib/api/client'
import {
  dispatchRentalLifecycleEvent,
  fetchRentalLifecycle,
  type RentalLifecycleHumanEvent,
  type RentalLifecycleSnapshot,
} from '@/lib/api/rental-lifecycle'
import { createHeadlessWorkflowMachine } from '@/machines/headless-workflow'

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
          <MPill tone={Number(util?.on_rent_quantity ?? 0) > 0 ? 'green' : undefined}>
            {Number(util?.on_rent_quantity ?? 0).toFixed(0)} on rent
          </MPill>
          <MPill>{Number(util?.available_quantity ?? 0).toFixed(0)} avail</MPill>
          <span className="num text-[12px] text-ink-3">
            ${Number(item.default_rental_rate).toFixed(2)}/{item.unit}
          </span>
        </div>
      </div>

      <div className="px-4 pb-8 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Recent movements</div>
        {movements.isPending ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Loading…</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">No movements yet.</div>
          </div>
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

// ---------------------------------------------------------------------------
// Rental lifecycle detail (`rnt-lifecycle-detail`)
//
// Headless renderer over the deterministic `rental` workflow:
// active → returned → invoiced_pending → closed. Mirrors
// `screens/financial/billing-run-detail.tsx`: GET snapshot → render
// state + next_events → POST { event, state_version } → 409 reloads the
// fresh snapshot and flags the stale-state condition.
//
// This dispatches lifecycle transitions through
// POST /api/rentals/:id/events (RETURN / CLOSE) rather than the legacy
// CRUD `POST /api/rentals/:id/return` path. The return path still owns
// damage-reconciliation; this screen is the calm "where is this rental
// in its lifecycle, and what's the next legal step" surface.
// ---------------------------------------------------------------------------

const LIFECYCLE_TONE_BY_STATE: Record<string, MTone | undefined> = {
  active: 'green',
  returned: undefined,
  invoiced_pending: 'amber',
  closed: undefined,
}

// XState machine is created once at module scope (XState machines must
// not be re-created per render). The factory owns only UI state —
// loading / submitting / showingError / outOfSync — and stores the
// server-authoritative snapshot verbatim.
const { useHook: useRentalLifecycle } = createHeadlessWorkflowMachine<
  RentalLifecycleSnapshot,
  RentalLifecycleHumanEvent
>({
  id: 'rentalLifecycle',
  load: (id, slug) => fetchRentalLifecycle(id, slug),
  submit: (id, event, stateVersion, slug) => dispatchRentalLifecycleEvent(id, event, stateVersion, slug),
})

export function RentalLifecycleDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const companySlug = getActiveCompanySlug()
  // Empty-string id is harmless — the load actor 404s immediately and the
  // early-return below guards the rest of the render.
  const { snapshot, error, outOfSync, isLoading, isSubmitting, dispatch, dismissError } = useRentalLifecycle(
    id ?? '',
    companySlug,
  )

  if (!id) {
    return (
      <div className="px-5 pt-8">
        <Link to="/rentals" className="text-accent text-[13px] font-medium">
          ← back to rentals
        </Link>
      </div>
    )
  }

  if (isLoading && !snapshot) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading rental…</div>
  }
  if (!snapshot) {
    return (
      <div className="px-5 pt-8">
        <h1 className="font-display text-[22px] font-bold tracking-tight">Rental not found</h1>
        <Link to="/rentals" className="text-accent text-[13px] font-medium">
          ← back to rentals
        </Link>
      </div>
    )
  }

  const ctx = snapshot.context

  const onEvent = (event: RentalLifecycleHumanEvent) => {
    dispatch(event)
  }

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/rentals" className="text-[12px] text-ink-3">
        ← Rentals
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-bold tracking-tight leading-tight truncate">
            {ctx.item_description}
          </h1>
          <div className="text-[11px] text-ink-3 mt-1">
            ${Number(ctx.daily_rate).toFixed(2)}/day · delivered {ctx.delivered_on}
            {ctx.returned_on ? ` · returned ${ctx.returned_on}` : ''} · v{snapshot.state_version}
          </div>
        </div>
        <MPill tone={LIFECYCLE_TONE_BY_STATE[snapshot.state]}>{snapshot.state}</MPill>
      </div>

      {outOfSync ? (
        <div className="m-card m-card-tight mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Stale state</div>
          <div className="text-[12px] text-ink-2 mt-1">
            Rental state moved on the server. Reloaded — pick the next action again.
          </div>
        </div>
      ) : null}

      {error && !outOfSync ? (
        <div className="m-card m-card-tight mt-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Error</div>
              <div className="text-[12px] text-ink-2 mt-1">{error}</div>
            </div>
            <button type="button" onClick={dismissError} className="text-[11px] text-ink-3 underline">
              dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Billing</div>
        <div className="m-card m-card-tight">
          <LifecycleRow label="Cadence" value={`${ctx.invoice_cadence_days}d`} />
          <LifecycleRow label="Next invoice" value={ctx.next_invoice_at ?? '—'} />
          <LifecycleRow
            label="Last invoice"
            value={ctx.last_invoice_amount ? `$${Number(ctx.last_invoice_amount).toFixed(2)}` : '—'}
          />
          <LifecycleRow label="Billed through" value={ctx.last_invoiced_through ?? '—'} />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Trail</div>
        <div className="m-card m-card-tight">
          <LifecycleTrail label="Returned" at={ctx.returned_at} />
          <LifecycleTrail label="Closed" at={ctx.closed_at} />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Actions</div>
        {snapshot.next_events.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Terminal state — no further actions.</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {snapshot.next_events.map((ev) => (
              <MButton
                key={ev.type}
                variant={ev.type === 'CLOSE' ? 'ghost' : 'primary'}
                disabled={isSubmitting}
                onClick={() => onEvent(ev.type)}
              >
                {ev.label}
              </MButton>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        <Attribution source="GET /api/rentals/:id · POST /:id/events (rental lifecycle workflow reducer)" />
      </div>
    </div>
  )
}

function LifecycleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[12px] py-1">
      <div className="text-ink-3">{label}</div>
      <div className="text-ink-2 num">{value}</div>
    </div>
  )
}

function LifecycleTrail({ label, at }: { label: string; at: string | null }) {
  return (
    <div className="flex items-center justify-between text-[12px] py-1">
      <div className="text-ink-3">{label}</div>
      <div className="text-ink-2">
        {at
          ? new Date(at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })
          : '—'}
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
          : movement.movement_type === 'damaged'
            ? 'Damaged'
            : movement.movement_type === 'lost'
              ? 'Lost'
              : movement.movement_type === 'repair'
                ? 'Repair'
                : 'Adjusted'
  const tone: MTone | undefined =
    movement.movement_type === 'damaged' || movement.movement_type === 'lost' || movement.movement_type === 'repair'
      ? 'amber'
      : movement.movement_type === 'deliver'
        ? 'green'
        : undefined
  return (
    <div className="m-card m-card-tight">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px] font-semibold">
            {label} · {Number(movement.quantity).toFixed(0)}
          </div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            {movement.project_name ?? 'no project'} · {movement.occurred_on}
          </div>
        </div>
        <MPill tone={tone}>{movement.movement_type}</MPill>
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
    </div>
  )
}
