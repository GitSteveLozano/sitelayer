import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { useBillingRuns, type RentalBillingState } from '@/lib/api'

const STATES: ReadonlyArray<RentalBillingState | 'all'> = [
  'all',
  'generated',
  'approved',
  'posting',
  'posted',
  'failed',
  'voided',
]

const TONE_BY_STATE: Record<RentalBillingState, 'good' | 'warn' | 'default'> = {
  generated: 'default',
  approved: 'default',
  posting: 'warn',
  posted: 'good',
  failed: 'warn',
  voided: 'default',
}

export function BillingRunListScreen() {
  const [filter, setFilter] = useState<RentalBillingState | 'all'>('all')
  const runs = useBillingRuns(filter === 'all' ? {} : { state: filter })
  const rows = runs.data?.billingRuns ?? []

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/financial" className="text-[12px] text-ink-3">
        ← Financial
      </Link>
      <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Billing runs</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        {rows.length} run{rows.length === 1 ? '' : 's'}
      </p>

      <div className="mt-4 flex gap-1.5 overflow-x-auto scrollbar-hide pb-2">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium border shrink-0 ${
              filter === s ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mt-2 space-y-2">
        {runs.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Nothing in this state.</div>
          </Card>
        ) : (
          rows.map((r) => (
            <Link key={r.id} to={`/financial/billing-runs/${r.id}`} className="block">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">
                      ${Number(r.subtotal).toLocaleString()} · {r.period_start} → {r.period_end}
                    </div>
                    <div className="text-[11px] text-ink-3 mt-0.5">
                      v{r.state_version}
                      {r.qbo_invoice_id ? ` · QBO inv #${r.qbo_invoice_id}` : ''}
                    </div>
                  </div>
                  <Pill tone={TONE_BY_STATE[r.status]}>{r.status}</Pill>
                </div>
              </Card>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
