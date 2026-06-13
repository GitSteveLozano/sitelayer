import { Link, useParams } from 'react-router-dom'
import { MButton, MPill, type MTone } from '@/components/m'
import { Attribution } from '@/components/ai'
import { getActiveCompanySlug } from '@/lib/api/client'
import { useControlPlaneProbePublish } from '@/lib/control-plane-probe-pub'
import { useBillingReview } from '@/machines/billing-review'
import type { RentalBillingHumanEvent } from '@/lib/api'

const TONE_BY_STATE: Record<string, MTone | undefined> = {
  generated: undefined,
  approved: undefined,
  posting: 'amber',
  posted: 'green',
  failed: 'amber',
  voided: undefined,
}

export function BillingRunDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const companySlug = getActiveCompanySlug()
  // Empty-string runId is harmless — the machine's load actor would 404
  // immediately and the early-return below guards the rest of the render.
  const { snapshot, error, outOfSync, isLoading, isSubmitting, dispatch, dismissError } = useBillingReview(
    id ?? '',
    companySlug,
  )

  // Publish the billing-review state into the control-plane probe so the
  // browser-bridge capture modal can fold it into
  // `page_state.billing_review_state`. See `apps/web/src/lib/control-plane-probe-pub.ts`.
  useControlPlaneProbePublish('billingReviewState', snapshot?.state ?? null)

  if (!id) {
    return (
      <div className="px-5 pt-8">
        <Link to="/financial/billing-runs" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  if (isLoading && !snapshot) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading run…</div>
  }
  if (!snapshot) {
    return (
      <div className="px-5 pt-8">
        <h1 className="font-display text-[22px] font-bold tracking-tight">Run not found</h1>
        <Link to="/financial/billing-runs" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  const ctx = snapshot.context
  const lines = ctx.lines ?? []

  const onEvent = (event: RentalBillingHumanEvent) => {
    dispatch(event)
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
            {ctx.period_start} → {ctx.period_end} · v{snapshot.state_version}
            {ctx.qbo_invoice_id ? ` · QBO inv #${ctx.qbo_invoice_id}` : ''}
          </div>
        </div>
        <MPill tone={TONE_BY_STATE[snapshot.state]}>{snapshot.state}</MPill>
      </div>

      {outOfSync ? (
        <div className="m-card m-card-tight mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Stale state</div>
          <div className="text-[12px] text-ink-2 mt-1">
            Run state moved on the server. Reloaded — pick the next action again.
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

      {ctx.error ? (
        <div className="m-card m-card-tight mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Run error</div>
          <div className="text-[12px] text-ink-2 mt-1">{ctx.error}</div>
        </div>
      ) : null}

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Line items</div>
        {lines.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">No lines.</div>
          </div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="m-card m-card-tight">
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
            </div>
          ))
        )}
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Trail</div>
        <div className="m-card m-card-tight">
          <Trail label="Approved" at={ctx.approved_at} />
          <Trail label="Posted" at={ctx.posted_at} />
          <Trail label="Failed" at={ctx.failed_at} />
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
                variant={ev.type === 'VOID' ? 'ghost' : 'primary'}
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
        <Attribution source="GET /api/rental-billing-runs/:id · POST /:id/events (billing-review XState machine)" />
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
