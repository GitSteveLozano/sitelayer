import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useBillingRun, useDispatchBillingRunEvent, type RentalBillingHumanEvent } from '@/lib/api'

const TONE_BY_STATE: Record<string, 'good' | 'warn' | 'default'> = {
  generated: 'default',
  approved: 'default',
  posting: 'warn',
  posted: 'good',
  failed: 'warn',
  voided: 'default',
}

export function BillingRunDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const snapshot = useBillingRun(id)
  const dispatch = useDispatchBillingRunEvent(id ?? '')
  const [error, setError] = useState<string | null>(null)

  if (!id) {
    return (
      <div className="px-5 pt-8">
        <Link to="/financial/billing-runs" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  if (snapshot.isPending) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading run…</div>
  }
  if (!snapshot.data) {
    return (
      <div className="px-5 pt-8">
        <h1 className="font-display text-[22px] font-bold tracking-tight">Run not found</h1>
        <Link to="/financial/billing-runs" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  const ctx = snapshot.data.context
  const lines = ctx.lines ?? []

  const onEvent = async (event: RentalBillingHumanEvent) => {
    setError(null)
    try {
      await dispatch.mutateAsync({ event, state_version: snapshot.data.state_version })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Event failed')
    }
  }

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/financial/billing-runs" className="text-[12px] text-ink-3">
        ← Billing runs
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-tight leading-tight">
            ${Number(ctx.subtotal).toLocaleString()}
          </h1>
          <div className="text-[11px] text-ink-3 mt-1">
            {ctx.period_start} → {ctx.period_end} · v{snapshot.data.state_version}
            {ctx.qbo_invoice_id ? ` · QBO inv #${ctx.qbo_invoice_id}` : ''}
          </div>
        </div>
        <Pill tone={TONE_BY_STATE[snapshot.data.state] ?? 'default'}>{snapshot.data.state}</Pill>
      </div>

      {ctx.error ? (
        <Card tight className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-status-warn">Error</div>
          <div className="text-[12px] text-ink-2 mt-1">{ctx.error}</div>
        </Card>
      ) : null}

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Line items</div>
        {lines.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No lines.</div>
          </Card>
        ) : (
          lines.map((line) => (
            <Card key={line.id} tight>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold truncate">{line.description ?? line.inventory_item_id}</div>
                  <div className="text-[11px] text-ink-3 mt-0.5">
                    {Number(line.quantity).toFixed(0)} × ${Number(line.agreed_rate).toFixed(2)} / {line.rate_unit} ·{' '}
                    {line.billable_days}d
                  </div>
                </div>
                <div className="text-[13px] font-semibold num">${Number(line.amount).toFixed(2)}</div>
              </div>
            </Card>
          ))
        )}
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Trail</div>
        <Card tight>
          <Trail label="Approved" at={ctx.approved_at} />
          <Trail label="Posted" at={ctx.posted_at} />
          <Trail label="Failed" at={ctx.failed_at} />
        </Card>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Actions</div>
        {snapshot.data.next_events.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Terminal state — no further actions.</div>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {snapshot.data.next_events.map((ev) => (
              <MobileButton
                key={ev.type}
                variant={ev.type === 'VOID' ? 'ghost' : 'primary'}
                disabled={dispatch.isPending}
                onClick={() => onEvent(ev.type)}
              >
                {ev.label}
              </MobileButton>
            ))}
          </div>
        )}
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
      </div>

      <div className="mt-4">
        <Attribution source="GET /api/rental-billing-runs/:id · POST /:id/events" />
      </div>
    </div>
  )
}

function Trail({ label, at }: { label: string; at: string | null }) {
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
