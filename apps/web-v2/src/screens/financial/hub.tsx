import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { useBillingRuns, useEstimatePushes } from '@/lib/api'

/**
 * Financial workflow hub — owner-facing index of the two QBO-bound
 * approval queues. Each card shows the count of items waiting on a
 * human (drafted/reviewed for estimates; generated/approved for
 * billing runs). The detail surfaces drive the workflow events that
 * land outbox rows for the worker to push to QBO.
 */
export function FinancialHubScreen() {
  const pushes = useEstimatePushes()
  const runs = useBillingRuns()

  const pushPending = (pushes.data?.estimatePushes ?? []).filter(
    (p) => p.status === 'drafted' || p.status === 'reviewed' || p.status === 'failed',
  ).length
  const runPending = (runs.data?.billingRuns ?? []).filter(
    (r) => r.status === 'generated' || r.status === 'failed',
  ).length

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/" className="text-[12px] text-ink-3">
        ← Home
      </Link>
      <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight leading-tight">Financial</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        Approval queues for QBO-bound work — review, approve, retry, or void.
      </p>

      <div className="mt-6 space-y-3">
        <Link to="/financial/estimate-pushes" className="block">
          <Card>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold">Estimate pushes</div>
                <div className="text-[12px] text-ink-3 mt-0.5">Bid → QBO Estimate. Review, approve, post.</div>
              </div>
              <Pill tone={pushPending > 0 ? 'warn' : 'good'}>{pushPending} pending</Pill>
            </div>
          </Card>
        </Link>

        <Link to="/financial/billing-runs" className="block">
          <Card>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold">Rental billing runs</div>
                <div className="text-[12px] text-ink-3 mt-0.5">25-day cycles → QBO Invoice. Approve, post, retry.</div>
              </div>
              <Pill tone={runPending > 0 ? 'warn' : 'good'}>{runPending} pending</Pill>
            </div>
          </Card>
        </Link>
      </div>
    </div>
  )
}
