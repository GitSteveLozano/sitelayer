import { Link, useParams } from 'react-router-dom'
import { MButton, MPill, type MTone } from '@/components/m'
import { useShipmentWorkflow, type ShipmentWorkflowState } from '@/lib/api/shipment-workflow'

const STATUS_TONE: Record<ShipmentWorkflowState, MTone | undefined> = {
  planned: undefined,
  picking: 'blue',
  shipped: 'blue',
  delivered: 'green',
  returning: 'amber',
  closed: undefined,
  voided: 'red',
}

export function ShipmentDetailScreen() {
  const { shipmentId } = useParams<{ shipmentId: string }>()
  const { snapshot, isLoading, isSubmitting, error, outOfSync, dispatch, dismissError } = useShipmentWorkflow(
    shipmentId ?? '',
  )

  if (isLoading && !snapshot) {
    return (
      <div className="px-5 pt-6 pb-12 max-w-2xl">
        <div className="m-card m-card-tight">
          <div className="text-[12px] text-ink-3">Loading shipment…</div>
        </div>
      </div>
    )
  }
  if (!snapshot) {
    return (
      <div className="px-5 pt-6 pb-12 max-w-2xl">
        <div className="m-card m-card-tight">
          <div className="text-[12px] text-ink-3">Shipment not found.</div>
        </div>
      </div>
    )
  }

  const ctx = snapshot.context

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to={`/projects/${ctx.project_id}`} className="text-[12px] text-ink-3">
        ← Project
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-tight leading-tight">
            {ctx.direction === 'outbound' ? 'Outbound shipment' : 'Return shipment'}
          </h1>
          <p className="text-[11px] text-ink-3 mt-1">
            {ctx.scheduled_for ? `Scheduled ${ctx.scheduled_for}` : 'Unscheduled'} · v{snapshot.state_version}
            {ctx.ticket_number ? <> · ticket {ctx.ticket_number}</> : null}
            {ctx.driver ? <> · driver {ctx.driver}</> : null}
          </p>
        </div>
        <MPill tone={STATUS_TONE[snapshot.state]}>{snapshot.state}</MPill>
      </div>

      {outOfSync ? (
        <div className="m-card m-card-tight mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Stale state</div>
          <div className="text-[12px] text-ink-2 mt-1">
            Shipment state moved on the server. Reloaded — pick the next action again.
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

      <h2 className="mt-6 text-[14px] font-semibold">Lines</h2>
      <div className="mt-2 space-y-1">
        {ctx.lines.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">No lines on this shipment yet.</div>
          </div>
        ) : (
          ctx.lines.map((line) => (
            <div key={line.id} className="m-card m-card-tight">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold">
                    {line.inventory_item_id ? '📦 owned item' : '🛒 catalog part'}
                  </div>
                  <div className="text-[11px] text-ink-3 mt-0.5">
                    planned {line.quantity_planned}
                    {Number(line.quantity_shipped) > 0 ? <> · shipped {line.quantity_shipped}</> : null}
                    {Number(line.quantity_delivered) > 0 ? <> · delivered {line.quantity_delivered}</> : null}
                    {Number(line.quantity_returned) > 0 ? <> · returned {line.quantity_returned}</> : null}
                    {Number(line.quantity_damaged) > 0 ? <> · damaged {line.quantity_damaged}</> : null}
                    {Number(line.quantity_lost) > 0 ? <> · lost {line.quantity_lost}</> : null}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <h2 className="mt-6 text-[14px] font-semibold">Next steps</h2>
      <div className="mt-2">
        {snapshot.next_events.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Terminal state — no further actions.</div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {snapshot.next_events.map((ev) => (
              <MButton
                key={ev.type}
                variant={ev.type === 'VOID' ? 'ghost' : 'primary'}
                disabled={isSubmitting || !!ev.disabled_reason}
                onClick={() => dispatch(ev.type)}
              >
                {ev.label}
              </MButton>
            ))}
          </div>
        )}
      </div>

      <h2 className="mt-6 text-[14px] font-semibold">Event log</h2>
      <div className="mt-2 space-y-1">
        {ctx.events.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">No events recorded yet.</div>
          </div>
        ) : (
          ctx.events.map((ev) => (
            <div key={ev.id} className="m-card m-card-tight">
              <div className="text-[12px]">
                <span className="font-semibold">{ev.event_type}</span>
                <span className="text-ink-3">
                  {' '}
                  · {ev.state_before ?? '—'} → {ev.state_after ?? '—'}
                </span>
              </div>
              <div className="text-[11px] text-ink-3 mt-0.5">
                {new Date(ev.created_at).toLocaleString()} · by {ev.produced_by}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
