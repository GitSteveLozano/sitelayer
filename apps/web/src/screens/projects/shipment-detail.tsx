import { Link, useParams } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { useShipmentWorkflow, type ShipmentWorkflowState } from '@/lib/api/shipment-workflow'

const STATUS_TONE: Record<ShipmentWorkflowState, 'default' | 'good' | 'warn' | 'bad' | 'info'> = {
  planned: 'default',
  picking: 'info',
  shipped: 'info',
  delivered: 'good',
  returning: 'warn',
  closed: 'default',
  voided: 'bad',
}

export function ShipmentDetailScreen() {
  const { shipmentId } = useParams<{ shipmentId: string }>()
  const { snapshot, isLoading, isSubmitting, error, outOfSync, dispatch, dismissError } = useShipmentWorkflow(
    shipmentId ?? '',
  )

  if (isLoading && !snapshot) {
    return (
      <div className="px-5 pt-6 pb-12 max-w-2xl">
        <Card tight>
          <div className="text-[12px] text-ink-3">Loading shipment…</div>
        </Card>
      </div>
    )
  }
  if (!snapshot) {
    return (
      <div className="px-5 pt-6 pb-12 max-w-2xl">
        <Card tight>
          <div className="text-[12px] text-ink-3">Shipment not found.</div>
        </Card>
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
        <Pill tone={STATUS_TONE[snapshot.state]}>{snapshot.state}</Pill>
      </div>

      {outOfSync ? (
        <Card tight className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Stale state</div>
          <div className="text-[12px] text-ink-2 mt-1">
            Shipment state moved on the server. Reloaded — pick the next action again.
          </div>
        </Card>
      ) : null}

      {error && !outOfSync ? (
        <Card tight className="mt-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Error</div>
              <div className="text-[12px] text-ink-2 mt-1">{error}</div>
            </div>
            <button type="button" onClick={dismissError} className="text-[11px] text-ink-3 underline">
              dismiss
            </button>
          </div>
        </Card>
      ) : null}

      <h2 className="mt-6 text-[14px] font-semibold">Lines</h2>
      <div className="mt-2 space-y-1">
        {ctx.lines.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No lines on this shipment yet.</div>
          </Card>
        ) : (
          ctx.lines.map((line) => (
            <Card key={line.id} tight>
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
            </Card>
          ))
        )}
      </div>

      <h2 className="mt-6 text-[14px] font-semibold">Next steps</h2>
      <div className="mt-2">
        {snapshot.next_events.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Terminal state — no further actions.</div>
          </Card>
        ) : (
          <div className="flex flex-wrap gap-2">
            {snapshot.next_events.map((ev) => (
              <MobileButton
                key={ev.type}
                variant={ev.type === 'VOID' ? 'ghost' : 'primary'}
                disabled={isSubmitting || !!ev.disabled_reason}
                onClick={() => dispatch(ev.type)}
              >
                {ev.label}
              </MobileButton>
            ))}
          </div>
        )}
      </div>

      <h2 className="mt-6 text-[14px] font-semibold">Event log</h2>
      <div className="mt-2 space-y-1">
        {ctx.events.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No events recorded yet.</div>
          </Card>
        ) : (
          ctx.events.map((ev) => (
            <Card key={ev.id} tight>
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
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
