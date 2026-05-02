import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { EmptyState } from '@/components/shell/EmptyState'
import { SkeletonRows } from '@/components/shell/LoadingSkeleton'
import { useLaborBurdenToday, useWorkers } from '@/lib/api'

/**
 * `t-burden` from Sitemap §8 panel 3 — company-wide labor burden for
 * today. Same shape as the project Time-tab burden card, scaled up:
 *
 *   - Big mono total (cents → dollars)
 *   - Stacked horizontal bar showing each worker's contribution
 *   - Per-worker list with hours, OT, dollars
 *   - Budget pct from the rolled-up daily_budget across projects
 */
export function OwnerLaborBurdenScreen() {
  const burden = useLaborBurdenToday()
  const workers = useWorkers()
  const data = burden.data
  const workerById = useMemo(() => new Map((workers.data?.workers ?? []).map((w) => [w.id, w])), [workers.data])

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-4">
        <Link to="/time" className="text-[12px] text-ink-3">
          ← Time
        </Link>
        <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Labor burden</h1>
        <div className="text-[13px] text-ink-2 mt-1">
          {data ? `${data.total_hours.toFixed(1)} crew-hrs across ${data.per_worker.length} ` : 'Today'}
          {data ? `worker${data.per_worker.length === 1 ? '' : 's'}` : ''}
        </div>
      </div>

      <div className="px-4 pb-8 space-y-3">
        {burden.isPending ? (
          <SkeletonRows count={4} className="px-0" />
        ) : !data || data.per_worker.length === 0 ? (
          <EmptyState
            title="No clock activity today"
            body="Once a worker clocks in, their loaded hours roll up here in real time."
          />
        ) : (
          <>
            <Card>
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Today · loaded burden
              </div>
              <div className="font-mono tabular-nums text-[36px] font-bold tracking-tight leading-none mt-1">
                ${(data.total_cents / 100).toFixed(2)}
              </div>
              <div className="text-[12px] text-ink-3 mt-1">
                blended {(data.blended_loaded_hourly_cents / 100).toFixed(2)}/hr · {data.total_ot_hours.toFixed(1)} OT
                hrs
              </div>
              <div className="mt-3 flex h-2.5 rounded-full overflow-hidden" aria-hidden="true">
                {[...data.per_worker]
                  .sort((a, b) => b.total_cents - a.total_cents)
                  .map((w, i) => {
                    const pct = data.total_cents > 0 ? (w.total_cents / data.total_cents) * 100 : 0
                    return (
                      <span key={w.worker_id} style={{ width: `${pct}%`, background: PALETTE[i % PALETTE.length] }} />
                    )
                  })}
              </div>
              {data.total_budget_cents > 0 ? (
                <div className="font-mono tabular-nums text-[11px] text-ink-3 mt-2">
                  {(data.burden_pct_of_budget * 100).toFixed(0)}% of ${(data.total_budget_cents / 100).toLocaleString()}{' '}
                  planned
                </div>
              ) : (
                <div className="text-[11px] text-ink-3 mt-2">No daily budget rolled up — set on each project.</div>
              )}
            </Card>

            <Card className="!p-0 overflow-hidden">
              <div className="px-4 py-3 border-b border-line text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Per worker
              </div>
              <ul className="divide-y divide-line">
                {[...data.per_worker]
                  .sort((a, b) => b.total_cents - a.total_cents)
                  .map((w, i) => {
                    const worker = workerById.get(w.worker_id)
                    const totalH = w.straight_hours + w.ot_hours
                    return (
                      <li key={w.worker_id} className="px-4 py-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <span
                            aria-hidden="true"
                            className="w-2.5 h-2.5 rounded-sm shrink-0"
                            style={{ background: PALETTE[i % PALETTE.length] }}
                          />
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium truncate">
                              {worker?.name ?? w.worker_id.slice(0, 8)}
                            </div>
                            <div className="font-mono tabular-nums text-[11px] text-ink-3 mt-0.5">
                              {totalH.toFixed(1)}h{w.ot_hours > 0 ? ` · ${w.ot_hours.toFixed(1)} OT` : ''}
                            </div>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-mono tabular-nums text-[14px] font-semibold">
                            ${(w.total_cents / 100).toFixed(2)}
                          </div>
                          {w.ot_cents > 0 ? <Pill tone="warn">OT ${(w.ot_cents / 100).toFixed(0)}</Pill> : null}
                        </div>
                      </li>
                    )
                  })}
              </ul>
            </Card>

            <Attribution source="Live from /api/labor-burden/today (company-wide)" />
          </>
        )}
      </div>

      <div className="px-4 pb-6">
        <Link to="/time" className="block">
          <MobileButton variant="ghost">Back to Time</MobileButton>
        </Link>
      </div>
    </div>
  )
}

/** Same 6-stop accent ramp as the project Time-tab burden card. */
const PALETTE = [
  'var(--m-accent)',
  'var(--m-accent-ink)',
  'var(--m-blue)',
  'var(--m-green)',
  'var(--m-amber)',
  'var(--m-red)',
] as const
