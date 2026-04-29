import { useEffect } from 'react'
import { useBillingReview } from '../machines/billing-review.js'
import type { RentalBillingHumanEvent, RentalBillingWorkflowSnapshotResponse } from '../api.js'
import { Button } from '../components/ui/button.js'
import { toastError, toastInfo, toastSuccess } from '../components/ui/toast.js'

/**
 * Headless billing-review screen — first consumer of the WorkflowSnapshot
 * pattern from docs/DETERMINISTIC_WORKFLOWS.md.
 *
 * The screen is intentionally a thin renderer over the API snapshot:
 *   1. Backend returns { state, state_version, context, next_events }.
 *   2. We render state + context as a card, and next_events as buttons.
 *   3. User clicks → DISPATCH event → API applies the reducer → returns
 *      a new snapshot → we re-render.
 *   4. 409s reload the snapshot and show an "out of sync" banner.
 *
 * The component does NOT compute next_events locally, does NOT call the
 * reducer locally, does NOT toggle a status field, does NOT mirror
 * business state. UI state lives in the XState machine (loading /
 * submitting / showingError / outOfSync).
 */

type BillingReviewViewProps = {
  runId: string
  companySlug: string
}

const STATE_LABELS: Record<RentalBillingWorkflowSnapshotResponse['state'], string> = {
  generated: 'Generated — ready for review',
  approved: 'Approved — ready to post',
  posting: 'Posting to QuickBooks…',
  posted: 'Posted to QuickBooks',
  failed: 'Posting failed — investigate, then retry or void',
  voided: 'Voided',
}

const TERMINAL_STATES = new Set(['posted', 'voided'])

const VOID_CONFIRM_MESSAGE =
  'Voiding this billing run cannot be undone. The customer invoice will NOT be created in QuickBooks. Continue?'

function formatCurrency(amount: string | number): string {
  const value = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(value)) return String(amount)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function BillingReviewView({ runId, companySlug }: BillingReviewViewProps) {
  const { snapshot, error, outOfSync, isLoading, isSubmitting, refresh, dispatch, dismissError } = useBillingReview(
    runId,
    companySlug,
  )

  // Surface error banners as toasts on top of the inline banner so a long-
  // running submit doesn't silently fail when the page is scrolled.
  useEffect(() => {
    if (error && outOfSync) {
      toastInfo('Billing run was updated by someone else — reload shown.')
    } else if (error) {
      toastError('Billing run action failed', error)
    }
  }, [error, outOfSync])

  // Toast on terminal-state arrival (posted/voided) so the user knows the
  // workflow closed out.
  useEffect(() => {
    if (snapshot?.state === 'posted') {
      toastSuccess(`Posted as QBO invoice ${snapshot.context.qbo_invoice_id ?? '—'}`)
    }
  }, [snapshot?.state, snapshot?.context.qbo_invoice_id])

  if (isLoading && !snapshot) {
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">Rental billing review</h2>
        <p className="text-sm text-slate-500">Loading…</p>
      </section>
    )
  }

  if (!snapshot) {
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">Rental billing review</h2>
        <p className="text-sm text-red-600">{error ?? 'Billing run not found.'}</p>
        <Button variant="outline" onClick={refresh}>
          Retry
        </Button>
      </section>
    )
  }

  const { state, context, next_events: nextEvents } = snapshot

  function onDispatchClick(eventType: RentalBillingHumanEvent) {
    if (eventType === 'VOID') {
      const confirmed = typeof window !== 'undefined' ? window.confirm(VOID_CONFIRM_MESSAGE) : true
      if (!confirmed) return
    }
    dispatch(eventType)
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-2xl font-semibold">Rental billing review</h2>
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <span>
            State: <strong className="text-slate-900">{STATE_LABELS[state]}</strong>
          </span>
          <span>v{context['state_version' as never] ?? snapshot.state_version}</span>
          <Button variant="outline" onClick={refresh} disabled={isLoading}>
            {isLoading ? 'Reloading…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {error && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            outOfSync ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-red-300 bg-red-50 text-red-900'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <p>{outOfSync ? `This billing run changed under you — reload shown above. (${error})` : error}</p>
            <Button variant="ghost" size="sm" onClick={dismissError}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Period</dt>
            <dd>
              {context.period_start} → {context.period_end}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Subtotal</dt>
            <dd>{formatCurrency(context.subtotal)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Approved</dt>
            <dd>
              {context.approved_by ?? '—'}
              <span className="ml-2 text-slate-400">{formatDateTime(context.approved_at)}</span>
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Posted</dt>
            <dd>
              {context.qbo_invoice_id ?? '—'}
              <span className="ml-2 text-slate-400">{formatDateTime(context.posted_at)}</span>
            </dd>
          </div>
          {state === 'failed' && (
            <div className="sm:col-span-2">
              <dt className="text-red-600">Last error</dt>
              <dd className="font-mono text-xs">{context.error ?? '—'}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700">Lines</h3>
        {context.lines.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No billable lines.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="py-1 pr-2">Item</th>
                <th className="py-1 pr-2">Qty</th>
                <th className="py-1 pr-2">Rate</th>
                <th className="py-1 pr-2">Days</th>
                <th className="py-1 pr-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {context.lines.map((line) => (
                <tr key={line.id} className="border-b border-slate-100">
                  <td className="py-1 pr-2">{line.description ?? line.inventory_item_id}</td>
                  <td className="py-1 pr-2">{line.quantity}</td>
                  <td className="py-1 pr-2">
                    {formatCurrency(line.agreed_rate)}/{line.rate_unit}
                  </td>
                  <td className="py-1 pr-2">{line.billable_days}</td>
                  <td className="py-1 pr-2 text-right">{formatCurrency(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {nextEvents.length === 0 ? (
          <p className="text-sm text-slate-500">
            {TERMINAL_STATES.has(state) ? 'This run is in a terminal state.' : 'Waiting on QuickBooks…'}
          </p>
        ) : (
          nextEvents.map((evt) => (
            <Button
              key={evt.type}
              variant={evt.type === 'VOID' ? 'outline' : 'default'}
              disabled={isSubmitting || Boolean(evt.disabled_reason)}
              title={evt.disabled_reason ?? ''}
              onClick={() => onDispatchClick(evt.type)}
            >
              {isSubmitting ? '…' : evt.label}
            </Button>
          ))
        )}
      </div>
    </section>
  )
}
