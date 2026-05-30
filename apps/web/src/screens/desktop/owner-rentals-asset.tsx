/**
 * Owner desktop rentals — ASSET DETAIL (Desktop v2 · RENTALS · ASSET DETAIL,
 * registry id m-renta / DRentAsset).
 *
 * Split layout: left column = KPI strip (utilization / 30d revenue / day-rate
 * / status) + a rental-history movement table; right aside = "currently at"
 * location card + day-rate + the lifecycle actions (Dispatch / Return /
 * Flag for service). Reached by a row-click in owner-rentals.tsx
 * (`/desktop/rentals/:itemId`).
 *
 * Identity + day-rate + history + live utilization come from the rental
 * hooks: `useInventoryItems` (catalog), `useInventoryMovements` (per-item
 * dispatch ledger), `useInventoryLocations` ("currently at" resolution),
 * and `useInventoryUtilization` (the real on-rent / available / idle-
 * revenue rollup, GET /api/inventory/utilization). Status, utilization,
 * and "currently at" are now derived from live dispatch state. There is
 * no per-item billed-revenue endpoint, so the revenue KPI surfaces the
 * real *idle* revenue/day from the utilization rollup (labelled), with a
 * GAP LIST entry for true 30-day billed revenue.
 *
 * Parent (DesktopWorkspace) wires the route. The Dispatch / Return actions
 * navigate to the sibling `:itemId/dispatch` + `:itemId/return` screens;
 * Flag-for-service opens a real inventory_service_ticket (POST
 * /api/inventory/service-tickets) so the maintenance work has its own
 * open → in_service → done lifecycle, and lists this asset's open tickets.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  useInventoryItems,
  useInventoryLocations,
  useInventoryMovements,
  useInventoryUtilization,
  usePatchInventoryItem,
  type InventoryMovement,
  type UtilizationRow,
} from '@/lib/api/rentals'
import { useOpenServiceTicket, useServiceTickets } from '@/lib/api/inventory-service-tickets'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DModal, type DColumn } from '@/components/d'
import { MButton, MInput, MPill } from '@/components/m'
import { formatMoney, shortDate } from '../mobile/format.js'

// Real dispatch-derived status from the utilization rollup: on-rent when
// any units are out on active rental lines, available otherwise.
type AssetStatus = 'available' | 'on-rent' | 'service'

function statusFromUtil(row: UtilizationRow | undefined): AssetStatus {
  return (Number(row?.on_rent_quantity ?? 0) || 0) > 0 ? 'on-rent' : 'available'
}

function utilizationPctFromRow(row: UtilizationRow | undefined): number {
  const onRent = Number(row?.on_rent_quantity ?? 0) || 0
  const available = Number(row?.available_quantity ?? 0) || 0
  const total = onRent + available
  return total > 0 ? Math.round((onRent / total) * 100) : 0
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

const MOVEMENT_TONE: Record<InventoryMovement['movement_type'], 'green' | 'amber' | 'blue' | 'red'> = {
  deliver: 'amber',
  return: 'green',
  transfer: 'blue',
  adjustment: 'blue',
  damaged: 'red',
  lost: 'red',
  repair: 'blue',
}

export function OwnerRentalsAsset() {
  const params = useParams<{ itemId: string }>()
  const navigate = useNavigate()
  const itemId = params.itemId ?? ''
  const [flagOpen, setFlagOpen] = useState(false)
  // Edit day-rate modal state. `rateDraft` is the in-flight dollar string the
  // owner is typing; it seeds from the current item rate when the modal opens.
  const [rateOpen, setRateOpen] = useState(false)
  const [rateDraft, setRateDraft] = useState('')

  const itemsQuery = useInventoryItems()
  const locationsQuery = useInventoryLocations()
  const movementsQuery = useInventoryMovements({ itemId })
  const utilizationQuery = useInventoryUtilization()
  // Real service tickets for this asset (open + in-service surface in the
  // aside; the create path is the "Flag for service" action below).
  const serviceTicketsQuery = useServiceTickets({ itemId })
  const flagService = useOpenServiceTicket()
  // Day-rate write path — PATCH /api/inventory/items/:id (default_rental_rate),
  // versioned with the item's optimistic `version`. Refresh comes for free
  // via the hook's `['inventory']` query invalidation.
  const patchItem = usePatchInventoryItem(itemId)

  const item = useMemo(
    () => (itemsQuery.data?.inventoryItems ?? []).find((i) => i.id === itemId) ?? null,
    [itemsQuery.data?.inventoryItems, itemId],
  )

  const movements = useMemo(
    () => movementsQuery.data?.inventoryMovements ?? [],
    [movementsQuery.data?.inventoryMovements],
  )

  // Live utilization row for this item (real on-rent / available / idle-
  // revenue figures from GET /api/inventory/utilization).
  const utilRow = useMemo(
    () => (utilizationQuery.data?.items ?? []).find((r) => r.inventory_item_id === itemId),
    [utilizationQuery.data?.items, itemId],
  )

  // "Currently at" resolution still leans on the default yard location.
  const yard = useMemo(
    () => (locationsQuery.data?.inventoryLocations ?? []).find((l) => l.location_type === 'yard') ?? null,
    [locationsQuery.data?.inventoryLocations],
  )

  // Open / in-service tickets for this asset (terminal `done` tickets drop
  // out of the active list). Newest-first per the API ordering.
  const openTickets = useMemo(
    () =>
      (serviceTicketsQuery.data?.service_tickets ?? []).filter((t) => t.status === 'open' || t.status === 'in_service'),
    [serviceTicketsQuery.data?.service_tickets],
  )

  // "Currently at" — the destination of the most recent movement (the
  // movements GET joins project + location names), else the default yard.
  // The ledger is the authoritative location trail for an item.
  const currentlyAt = useMemo(() => {
    const last = movements[0]
    if (last?.project_name) return last.project_name
    if (last?.to_location_name) return last.to_location_name
    return yard?.name ?? 'Yard'
  }, [movements, yard])

  // Loading / not-found.
  if (!item) {
    if (itemsQuery.isPending) {
      return (
        <div className="d-content">
          <div style={{ color: 'var(--m-ink-3)' }}>Loading asset…</div>
        </div>
      )
    }
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Owner · Rentals</DEyebrow>
            <DH1>Asset not found</DH1>
          </div>
          <div className="d-card" style={{ color: 'var(--m-ink-2)' }}>
            This asset may have been removed from inventory.
            <div style={{ marginTop: 14 }}>
              <MButton variant="primary" onClick={() => navigate('/desktop/rentals')}>
                Back to rentals
              </MButton>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const status = statusFromUtil(utilRow)
  const rate = Number(item.default_rental_rate ?? 0)
  const utilizationPct = utilizationPctFromRow(utilRow)
  // Real idle revenue/day from the utilization rollup (available units ×
  // default rate). There is NO per-item billed-revenue endpoint, so we
  // surface idle revenue instead of fabricating a 30-day total. See GAP LIST.
  const idleRevenuePerDay = (Number(utilRow?.idle_revenue_per_day_cents ?? 0) || 0) / 100

  // capture a non-null item id for the handler closure (item is non-null past
  // the guard above, but the closure runs later).
  const confirmedItemId = item.id
  const canFlagService = !flagService.isPending
  const handleFlagForService = () => {
    if (flagService.isPending) return
    flagService.mutate(
      {
        inventory_item_id: confirmedItemId,
        notes: 'Flagged for service from owner rentals',
      },
      { onSuccess: () => setFlagOpen(false) },
    )
  }

  // Seed the draft from the current rate and open the editor.
  const openRateEditor = () => {
    patchItem.reset()
    setRateDraft(String(rate))
    setRateOpen(true)
  }

  // A valid rate is a finite, non-negative number (the API clamps with
  // parseNonNegativeNumber, but we guard the button so a bad value can't be
  // submitted and silently coerced to 0).
  const parsedRate = Number(rateDraft)
  const rateValid = rateDraft.trim() !== '' && Number.isFinite(parsedRate) && parsedRate >= 0
  const rateUnchanged = rateValid && parsedRate === rate
  const canSaveRate = rateValid && !rateUnchanged && !patchItem.isPending

  const handleSaveRate = () => {
    if (!canSaveRate) return
    patchItem.mutate(
      { default_rental_rate: parsedRate, expected_version: item.version },
      { onSuccess: () => setRateOpen(false) },
    )
  }

  const columns: Array<DColumn<InventoryMovement>> = [
    { key: 'date', header: 'Date', render: (r) => shortDate(r.occurred_on) },
    {
      key: 'type',
      header: 'Type',
      render: (r) => (
        <MPill tone={MOVEMENT_TONE[r.movement_type]} dot>
          {r.movement_type}
        </MPill>
      ),
    },
    {
      key: 'where',
      header: 'Where',
      render: (r) => r.project_name ?? r.to_location_name ?? r.from_location_name ?? '—',
    },
    { key: 'qty', header: 'Qty', numeric: true, render: (r) => r.quantity },
    { key: 'ticket', header: 'Ticket', render: (r) => r.ticket_number ?? '—' },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Rentals · {item.code}</DEyebrow>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
            <DH1>{item.description}</DH1>
            <MPill tone={statusTone(status)} dot>
              {status}
            </MPill>
          </div>
        </div>

        <DKpiStrip>
          <DKpi
            label="Utilization"
            value={String(utilizationPct)}
            unit="%"
            meta={status === 'on-rent' ? 'Deployed' : 'In yard'}
          />
          <DKpi label="Idle revenue/day" value={formatMoney(idleRevenuePerDay)} meta="Available units idling" />
          <DKpi label="Day rate" value={formatMoney(rate)} meta={`per ${item.unit || 'day'}`} />
          <DKpi
            label="Replacement"
            value={item.replacement_value ? formatMoney(item.replacement_value) : '—'}
            meta="Insured value"
          />
        </DKpiStrip>

        <div className="d-split">
          <DataTable<InventoryMovement>
            title="Rental history"
            columns={columns}
            rows={movements}
            rowKey={(r) => r.id}
            empty={
              movementsQuery.isPending
                ? 'Loading history…'
                : 'No movements yet. Dispatches and returns for this asset land here.'
            }
          />

          <aside className="d-card" style={{ position: 'sticky', top: 16, alignSelf: 'start' }}>
            <div className="d-eyebrow">Currently at</div>
            <div style={{ marginTop: 10, fontSize: 18, fontWeight: 700 }}>{currentlyAt}</div>
            <div style={{ marginTop: 4, fontSize: 13, color: 'var(--m-ink-3)' }}>
              {status === 'on-rent' ? 'On a job site' : 'Available in yard'}
            </div>

            {/* Open service tickets for this asset — the real
                inventory_service_tickets surface (open + in_service). */}
            {openTickets.length > 0 ? (
              <>
                <div className="d-eyebrow" style={{ marginTop: 22 }}>
                  Open service tickets
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  {openTickets.map((ticket) => (
                    <div
                      key={ticket.id}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                    >
                      <div style={{ fontSize: 13, color: 'var(--m-ink-2)' }}>{shortDate(ticket.opened_at)}</div>
                      <MPill tone={ticket.status === 'in_service' ? 'amber' : 'blue'} dot>
                        {ticket.status === 'in_service' ? 'in service' : 'open'}
                      </MPill>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            <div
              className="d-eyebrow"
              style={{ marginTop: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
            >
              <span>Day rate</span>
              <button
                type="button"
                onClick={openRateEditor}
                style={{
                  appearance: 'none',
                  border: 'none',
                  background: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  font: 'inherit',
                  letterSpacing: 'inherit',
                  textTransform: 'inherit',
                  color: 'var(--m-accent)',
                  fontWeight: 700,
                }}
              >
                Edit
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 24, fontWeight: 800, fontFamily: 'var(--m-num)' }}>
              {formatMoney(rate)}
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-ink-3)' }}> /{item.unit || 'day'}</span>
            </div>

            <div className="d-eyebrow" style={{ marginTop: 22 }}>
              Actions
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              <MButton variant="primary" onClick={() => navigate(`/desktop/rentals/${item.id}/dispatch`)}>
                Dispatch
              </MButton>
              <MButton variant="ghost" onClick={() => navigate(`/desktop/rentals/${item.id}/return`)}>
                Return
              </MButton>
              <MButton variant="ghost" onClick={() => setFlagOpen(true)}>
                Flag for service
              </MButton>
            </div>
          </aside>
        </div>
      </div>

      {/* Flag for service — opens a real inventory_service_ticket (POST
          /api/inventory/service-tickets) with status `open`, giving the
          maintenance work its own open → in_service → done lifecycle. The
          ticket surfaces in the asset aside above and in the company-wide
          service log on owner-rentals-utilization. */}
      <DModal
        open={flagOpen}
        onClose={() => setFlagOpen(false)}
        title={`Flag ${item.code} for service`}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <MButton variant="ghost" onClick={() => setFlagOpen(false)}>
              Cancel
            </MButton>
            <MButton variant="primary" disabled={!canFlagService} onClick={handleFlagForService}>
              {flagService.isPending ? 'Flagging…' : 'Flag for service'}
            </MButton>
          </div>
        }
      >
        <div style={{ fontSize: 14, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>
          This opens a service ticket for <strong>{item.description}</strong>. The ticket tracks the maintenance work
          (open → in service → done) and shows up in the rentals service log until it is marked done.
        </div>
        {flagService.isError ? (
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--m-red)', fontWeight: 600 }}>
            {flagService.error instanceof Error ? flagService.error.message : 'Could not flag for service.'}
          </div>
        ) : null}
      </DModal>

      {/* Edit day rate — PATCHes the inventory item's default_rental_rate
          (the asset's catalog day rate) through the existing versioned
          inventory-items update path. A 409 means another writer bumped the
          item; the surfaced error tells the owner to reopen with fresh data. */}
      <DModal
        open={rateOpen}
        onClose={() => setRateOpen(false)}
        title={`Edit day rate · ${item.code}`}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <MButton variant="ghost" onClick={() => setRateOpen(false)}>
              Cancel
            </MButton>
            <MButton variant="primary" disabled={!canSaveRate} onClick={handleSaveRate}>
              {patchItem.isPending ? 'Saving…' : 'Save day rate'}
            </MButton>
          </div>
        }
      >
        <div style={{ fontSize: 14, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>
          The catalog day rate for <strong>{item.description}</strong>. New dispatches and idle-revenue figures use
          this rate.
        </div>
        <div className="d-eyebrow" style={{ marginTop: 18 }}>
          Day rate (per {item.unit || 'day'})
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--m-ink-3)' }}>$</span>
          <MInput
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={rateDraft}
            autoFocus
            onChange={(e) => setRateDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSaveRate) handleSaveRate()
            }}
          />
        </div>
        {rateDraft.trim() !== '' && !rateValid ? (
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--m-red)', fontWeight: 600 }}>
            Enter a non-negative dollar amount.
          </div>
        ) : null}
        {patchItem.isError ? (
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--m-red)', fontWeight: 600 }}>
            {patchItem.error instanceof Error ? patchItem.error.message : 'Could not update the day rate.'}
          </div>
        ) : null}
      </DModal>
    </div>
  )
}
