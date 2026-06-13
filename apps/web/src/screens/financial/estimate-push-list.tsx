import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MPill, type MTone } from '@/components/m'
import { useEstimatePushes, type EstimatePushState } from '@/lib/api'

const STATES: ReadonlyArray<EstimatePushState | 'all'> = [
  'all',
  'drafted',
  'reviewed',
  'approved',
  'posting',
  'posted',
  'failed',
  'voided',
]

const TONE_BY_STATE: Record<EstimatePushState, MTone | undefined> = {
  drafted: undefined,
  reviewed: undefined,
  approved: undefined,
  posting: 'amber',
  posted: 'green',
  failed: 'amber',
  voided: undefined,
}

export function EstimatePushListScreen() {
  const [filter, setFilter] = useState<EstimatePushState | 'all'>('all')
  const pushes = useEstimatePushes(filter === 'all' ? {} : { state: filter })
  const rows = pushes.data?.estimatePushes ?? []

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/financial" className="text-[12px] text-ink-3">
        ← Financial
      </Link>
      <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Estimate pushes</h1>
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
        {pushes.isPending ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Loading…</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Nothing in this state.</div>
          </div>
        ) : (
          rows.map((r) => (
            <Link key={r.id} to={`/financial/estimate-pushes/${r.id}`} className="block">
              <div className="m-card m-card-tight">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">
                      ${Number(r.subtotal).toLocaleString()} · v{r.state_version}
                    </div>
                    <div className="text-[11px] text-ink-3 mt-0.5">
                      created {new Date(r.created_at).toLocaleDateString()}
                      {r.qbo_estimate_id ? ` · QBO #${r.qbo_estimate_id}` : ''}
                    </div>
                  </div>
                  <MPill tone={TONE_BY_STATE[r.status]}>{r.status}</MPill>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
