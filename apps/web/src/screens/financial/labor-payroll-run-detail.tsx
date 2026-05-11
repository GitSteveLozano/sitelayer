import { Link, useParams } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { getActiveCompanySlug } from '@/lib/api/client'
import { useLaborPayroll } from '@/machines/labor-payroll'
import type { LaborPayrollHumanEvent } from '@/lib/api'

const TONE_BY_STATE: Record<string, 'good' | 'warn' | 'default'> = {
  generated: 'default',
  approved: 'default',
  posting: 'warn',
  posted: 'good',
  failed: 'warn',
  voided: 'default',
}

export function LaborPayrollRunDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const companySlug = getActiveCompanySlug()
  // Empty-string runId is harmless — the machine's load actor would 404
  // immediately and the early-return below guards the rest of the render.
  const { snapshot, error, outOfSync, isLoading, isSubmitting, dispatch, dismissError } = useLaborPayroll(
    id ?? '',
    companySlug,
  )

  if (!id) {
    return (
      <div className="px-5 pt-8">
        <Link to="/financial/labor-payroll-runs" className="text-accent text-[13px] font-medium">
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
        <Link to="/financial/labor-payroll-runs" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  const ctx = snapshot.context
  const coveredIds = ctx.covered_labor_entry_ids ?? []
  const dollars = Number(ctx.total_cents) / 100
  const qboRefs = ctx.qbo_payroll_batch_ref ?? []

  const onEvent = (event: LaborPayrollHumanEvent) => {
    dispatch(event)
  }

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/financial/labor-payroll-runs" className="text-[12px] text-ink-3">
        ← Labor payroll runs
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-tight leading-tight">
            ${dollars.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </h1>
          <div className="text-[11px] text-ink-3 mt-1">
            {ctx.period_start} → {ctx.period_end} · {Number(ctx.total_hours).toFixed(1)}h · v{snapshot.state_version}
            {qboRefs.length > 0 ? ` · QBO ${qboRefs.join(', ')}` : ''}
          </div>
        </div>
        <Pill tone={TONE_BY_STATE[snapshot.state] ?? 'default'}>{snapshot.state}</Pill>
      </div>

      {outOfSync ? (
        <Card tight className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Stale state</div>
          <div className="text-[12px] text-ink-2 mt-1">
            Run state moved on the server. Reloaded — pick the next action again.
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

      {ctx.error_message ? (
        <Card tight className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Run error</div>
          <div className="text-[12px] text-ink-2 mt-1">{ctx.error_message}</div>
        </Card>
      ) : null}

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Coverage</div>
        <Card tight>
          <div className="flex items-center justify-between text-[12px] py-1">
            <div className="text-ink-3">Labor entries</div>
            <div className="text-ink-2 num">{coveredIds.length}</div>
          </div>
          <div className="flex items-center justify-between text-[12px] py-1">
            <div className="text-ink-3">Total hours</div>
            <div className="text-ink-2 num">{Number(ctx.total_hours).toFixed(1)}h</div>
          </div>
          <div className="flex items-center justify-between text-[12px] py-1">
            <div className="text-ink-3">Total</div>
            <div className="text-ink-2 num">
              ${dollars.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
          </div>
          {ctx.time_review_run_id ? (
            <div className="flex items-center justify-between text-[12px] py-1">
              <div className="text-ink-3">Time-review run</div>
              <div className="text-ink-2 num truncate max-w-[60%]">{ctx.time_review_run_id}</div>
            </div>
          ) : null}
        </Card>
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
        {snapshot.next_events.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Terminal state — no further actions.</div>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {snapshot.next_events.map((ev) => (
              <MobileButton
                key={ev.type}
                variant={ev.type === 'VOID' ? 'ghost' : 'primary'}
                disabled={isSubmitting}
                onClick={() => onEvent(ev.type)}
              >
                {ev.label}
              </MobileButton>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        <Attribution source="GET /api/labor-payroll-runs/:id · POST /:id/events (labor-payroll XState machine)" />
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
