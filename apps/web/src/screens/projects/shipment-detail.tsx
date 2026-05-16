import { Link, useParams } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import {
  useShipment,
  useTransitionShipment,
  type ShipmentStatus,
} from '@/lib/api/shipments'

const STATUS_TONE: Record<ShipmentStatus, 'default' | 'good' | 'warn' | 'bad' | 'info'> = {
  planned: 'default',
  picking: 'info',
  shipped: 'info',
  delivered: 'good',
  returning: 'warn',
  closed: 'default',
  voided: 'bad',
}

const HUMAN_EVENTS: Array<{
  state: ShipmentStatus
  event: 'START_PICKING' | 'SHIP' | 'CONFIRM_DELIVERY' | 'OPEN_RETURN' | 'CLOSE' | 'VOID'
  next: ShipmentStatus
  label: string
}> = [
  { state: 'planned', event: 'START_PICKING', next: 'picking', label: 'Start picking' },
  { state: 'planned', event: 'SHIP', next: 'shipped', label: 'Mark shipped' },
  { state: 'picking', event: 'SHIP', next: 'shipped', label: 'Mark shipped' },
  { state: 'shipped', event: 'CONFIRM_DELIVERY', next: 'delivered', label: 'Confirm delivery' },
  { state: 'delivered', event: 'OPEN_RETURN', next: 'returning', label: 'Open return' },
  { state: 'delivered', event: 'CLOSE', next: 'closed', label: 'Close shipment' },
  { state: 'returning', event: 'CLOSE', next: 'closed', label: 'Close shipment' },
]

export function ShipmentDetailScreen() {
  const { shipmentId } = useParams<{ shipmentId: string }>()
  const shipment = useShipment(shipmentId ?? '')
  const transition = useTransitionShipment(shipmentId ?? '')

  if (shipment.isPending) {
    return (
      <div className="px-5 pt-6 pb-12 max-w-2xl">
        <Card tight>
          <div className="text-[12px] text-ink-3">Loading shipment…</div>
        </Card>
      </div>
    )
  }
  if (!shipment.data) {
    return (
      <div className="px-5 pt-6 pb-12 max-w-2xl">
        <Card tight>
          <div className="text-[12px] text-ink-3">Shipment not found.</div>
        </Card>
      </div>
    )
  }
  const s = shipment.data
  const availableEvents = HUMAN_EVENTS.filter((e) => e.state === s.status)

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to={`/projects/${s.project_id}`} className="text-[12px] text-ink-3">
        ← Project
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-tight leading-tight">
            {s.direction === 'outbound' ? 'Outbound shipment' : 'Return shipment'}
          </h1>
          <p className="text-[11px] text-ink-3 mt-1">
            {s.scheduled_for ? `Scheduled ${s.scheduled_for}` : 'Unscheduled'}
            {s.ticket_number ? <> · ticket {s.ticket_number}</> : null}
            {s.driver ? <> · driver {s.driver}</> : null}
          </p>
        </div>
        <Pill tone={STATUS_TONE[s.status]}>{s.status}</Pill>
      </div>

      <h2 className="mt-6 text-[14px] font-semibold">Lines</h2>
      <div className="mt-2 space-y-1">
        {s.lines.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No lines on this shipment yet.</div>
          </Card>
        ) : (
          s.lines.map((line) => (
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

      {availableEvents.length > 0 ? (
        <>
          <h2 className="mt-6 text-[14px] font-semibold">Next steps</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {availableEvents.map((e) => (
              <MobileButton
                key={e.event}
                variant="primary"
                disabled={transition.isPending}
                onClick={() =>
                  transition.mutate({
                    event_type: e.event,
                    next_status: e.next,
                    state_version: s.state_version,
                  })
                }
              >
                {e.label}
              </MobileButton>
            ))}
            {s.status !== 'closed' && s.status !== 'voided' ? (
              <MobileButton
                variant="ghost"
                disabled={transition.isPending}
                onClick={() =>
                  transition.mutate({
                    event_type: 'VOID',
                    next_status: 'voided',
                    state_version: s.state_version,
                  })
                }
              >
                Void
              </MobileButton>
            ) : null}
          </div>
        </>
      ) : null}

      <h2 className="mt-6 text-[14px] font-semibold">Event log</h2>
      <div className="mt-2 space-y-1">
        {s.events.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No events recorded yet.</div>
          </Card>
        ) : (
          s.events.map((ev) => (
            <Card key={ev.id} tight>
              <div className="text-[12px]">
                <span className="font-semibold">{ev.event_type}</span>
                <span className="text-ink-3"> · {ev.state_before ?? '—'} → {ev.state_after ?? '—'}</span>
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
