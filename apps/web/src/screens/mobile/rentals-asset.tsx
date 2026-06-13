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
import { useOpenServiceTicket } from '@/lib/api/inventory-service-tickets'
import {
  MBody,
  MButton,
  MButtonStack,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney } from './format.js'

export function MobileRentalsAsset() {
  const navigate = useNavigate()
  const { assetId } = useParams<{ assetId: string }>()
  const { data, isLoading, error } = useInventoryItems()
  // FLAG FOR SERVICE opens a REAL inventory_service_tickets row (the durable
  // backend the service log reads) before navigating to the log — it was a
  // bare navigate that persisted nothing (audit M10 #9).
  const openTicket = useOpenServiceTicket()
  const [flagError, setFlagError] = useState<string | null>(null)

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

  // Dispatch context — there is no /api/dispatch state join yet, so the
  // day-count is derived from the last movement timestamp (updated_at)
  // while the asset is out. Renders the design's "OUT · DAY N OF M" pill,
  // a current-location headline, and a dispatched/due-back detail line.
  const dispatchedAt = out ? (item.updated_at ?? item.created_at ?? null) : null
  const daysOut = dispatchedAt ? Math.max(1, daysBetween(dispatchedAt, new Date().toISOString())) : null
  // Revenue accrued so far on the current dispatch (days_out × day_rate).
  const revenueToDate = daysOut && dayRate ? daysOut * dayRate : 0

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
        {/* Status pill — day-count when out (msg__70: "OUT · DAY 12 OF 32"). */}
        <div style={{ padding: '14px 16px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className="m-l-leading num"
            data-tone={out ? 'amber' : 'green'}
            style={{ width: 40, height: 40, fontWeight: 700 }}
          >
            {monogram}
          </span>
          <MPill tone={out ? 'amber' : 'green'} dot>
            {out ? (daysOut ? `OUT · DAY ${daysOut}` : 'OUT') : 'IN YARD'}
          </MPill>
        </div>

        {/* Current-location headline + dispatched/due-back detail line. */}
        <div style={{ padding: '12px 16px 0' }}>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 24,
              lineHeight: 1.1,
              letterSpacing: '-0.01em',
            }}
          >
            {out ? 'Currently dispatched.' : 'In the yard.'}
          </div>
          {dispatchedAt ? (
            <div
              className="num"
              style={{ marginTop: 8, color: 'var(--m-ink-3)', fontWeight: 600, letterSpacing: '0.04em' }}
            >
              DISPATCHED {fmtShort(dispatchedAt)}
            </div>
          ) : null}
        </div>

        <div style={{ padding: '12px 16px 0' }}>
          <MKpiRow cols={2}>
            <MKpi
              label="Revenue to date"
              value={formatMoney(revenueToDate)}
              meta={
                daysOut
                  ? `${daysOut} days × ${formatMoney(dayRate)}`
                  : `${formatMoney(dayRate)} per ${item.unit || 'day'}`
              }
            />
            <MKpi
              label="Utilization"
              value={`${utilizationPct}`}
              unit="%"
              meta={out ? 'Deployed' : 'Idle'}
              metaTone={out ? 'green' : undefined}
            />
          </MKpiRow>
        </div>

        {/* Quick actions — three full-width stacked CTAs (msg__70). */}
        <MSectionH>Quick actions</MSectionH>
        <div style={{ padding: '0 16px' }}>
          <MButtonStack>
            <MButton
              variant="primary"
              onClick={() => navigate(`/rentals/dispatch?asset=${encodeURIComponent(item.id)}`)}
            >
              DISPATCH ELSEWHERE
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/rentals/return')}>
              RETURN TO YARD
            </MButton>
            <MButton
              variant="ghost"
              disabled={openTicket.isPending}
              onClick={() => {
                setFlagError(null)
                openTicket
                  .mutateAsync({
                    inventory_item_id: item.id,
                    service_type: 'Flagged for service',
                    notes: 'Flagged from the asset detail screen.',
                  })
                  .then(() => navigate(`/rentals/service/${encodeURIComponent(item.id)}`))
                  .catch((err: unknown) => {
                    setFlagError(err instanceof Error ? err.message : 'Could not open a service ticket.')
                  })
              }}
              style={{ color: 'var(--m-red)', borderColor: 'var(--m-red)' }}
            >
              {openTicket.isPending ? 'FLAGGING…' : 'FLAG FOR SERVICE'}
            </MButton>
          </MButtonStack>
          {flagError ? <div style={{ marginTop: 8, color: 'var(--m-red)', fontSize: 13 }}>{flagError}</div> : null}
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

/** Mono short date for the dispatched/due-back detail line, e.g. "4/15". */
function fmtShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return iso
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** Whole days between two ISO timestamps (>= 0). */
function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).valueOf()
  const to = new Date(toIso).valueOf()
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.max(0, Math.floor((to - from) / 86_400_000))
}
