import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MPill, type MTone } from '@/components/m'
import { useLaborPayrollRuns, type LaborPayrollState } from '@/lib/api'

const STATES: ReadonlyArray<LaborPayrollState | 'all'> = [
  'all',
  'generated',
  'approved',
  'posting',
  'posted',
  'failed',
  'voided',
]

const TONE_BY_STATE: Record<LaborPayrollState, MTone | undefined> = {
  generated: undefined,
  approved: undefined,
  posting: 'amber',
  posted: 'green',
  failed: 'amber',
  voided: undefined,
}

export function LaborPayrollRunListScreen() {
  const [filter, setFilter] = useState<LaborPayrollState | 'all'>('all')
  const runs = useLaborPayrollRuns(filter === 'all' ? {} : { state: filter })
  const rows = runs.data?.laborPayrollRuns ?? []

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/financial" className="text-[12px] text-ink-3">
        ← Financial
      </Link>
      <div className="mt-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Labor payroll runs</h1>
          <p className="text-[12px] text-ink-3 mt-1">
            {rows.length} run{rows.length === 1 ? '' : 's'}
          </p>
        </div>
        <Link
          to="/financial/labor-payroll-runs/new"
          className="shrink-0 mt-1 px-3 py-1.5 rounded-full text-[12px] font-medium bg-accent text-white"
        >
          + New run
        </Link>
      </div>

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
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Loading…</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Nothing in this state.</div>
          </div>
        ) : (
          rows.map((r) => {
            const dollars = Number(r.total_cents) / 100
            const qboRef = r.qbo_payroll_batch_ref?.[0]
            return (
              <Link key={r.id} to={`/financial/labor-payroll-runs/${r.id}`} className="block">
                <div className="m-card m-card-tight">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">
                        ${dollars.toLocaleString(undefined, { maximumFractionDigits: 2 })} · {r.period_start} →{' '}
                        {r.period_end}
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        {Number(r.total_hours).toFixed(1)}h · v{r.state_version}
                        {qboRef ? ` · QBO ${qboRef}` : ''}
                      </div>
                    </div>
                    <MPill tone={TONE_BY_STATE[r.state]}>{r.state}</MPill>
                  </div>
                </div>
              </Link>
            )
          })
        )}
      </div>
    </div>
  )
}
