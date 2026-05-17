import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, MobileButton } from '@/components/mobile'
import { AgentSurface, Attribution, Dismiss, StripeCard, WhyThis } from '@/components/ai'
import {
  dispatchTimeReviewEvent,
  queryKeys,
  type AiInsight,
  type BidFollowUpDraft,
  type TimeReviewRunRow,
} from '@/lib/api'
import { formatDollars } from './helpers'

// ---------------------------------------------------------------------------
// Attention items
// ---------------------------------------------------------------------------

type AttentionKind = 'over_budget' | 'reviews_pending' | 'drafts_stale'

export interface AttentionItem {
  id: string
  kind: AttentionKind
  tone: 'warn' | 'accent'
  eyebrow: string
  title: string
  detail: string
  attribution: string
  action_label: string
  action_to: string
}

export interface BuildAttentionInputs {
  reviewsPending: {
    id: string
    period_start: string
    period_end: string
    total_hours: string
    total_entries: number
    anomaly_count: number
    created_at: string
  }[]
  burden: import('@/lib/api').LaborBurdenSummaryResponse | undefined
  drafts: { id: string; project_id: string; updated_at: string }[]
}

export function buildAttentionItems(inputs: BuildAttentionInputs): AttentionItem[] {
  const items: AttentionItem[] = []

  // Over-budget: total_cents > total_budget_cents (when a budget is set).
  if (inputs.burden && inputs.burden.total_budget_cents > 0) {
    const overCents = inputs.burden.total_cents - inputs.burden.total_budget_cents
    if (overCents > 0) {
      const pct = inputs.burden.burden_pct_of_budget
      items.push({
        id: 'attn:over_budget',
        kind: 'over_budget',
        tone: 'warn',
        eyebrow: `At risk · ${formatDollars(overCents)} over`,
        title: `Today's burden is ${(pct * 100).toFixed(0)}% of plan`,
        detail: `${inputs.burden.total_hours.toFixed(1)} crew-hrs at ${formatDollars(inputs.burden.blended_loaded_hourly_cents)}/hr loaded.`,
        attribution: 'Why this card?',
        action_label: 'Open Time',
        action_to: '/time',
      })
    }
  }

  // Time-review pending — flag when there are runs waiting > 24h or with anomalies.
  const stale = inputs.reviewsPending.filter(
    (r) => r.anomaly_count > 0 || Date.now() - Date.parse(r.created_at) > 24 * 3600 * 1000,
  )
  if (stale.length > 0) {
    const totalEntries = stale.reduce((sum, r) => sum + r.total_entries, 0)
    const anomalies = stale.reduce((sum, r) => sum + r.anomaly_count, 0)
    items.push({
      id: 'attn:reviews_pending',
      kind: 'reviews_pending',
      tone: 'warn',
      eyebrow: `${stale.length} run${stale.length === 1 ? '' : 's'} waiting · ${totalEntries} entries`,
      title: 'Time entries waiting for approval',
      detail:
        anomalies > 0 ? `${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'}.` : 'All clean — single tap to approve.',
      attribution: 'Pending > 24h or has anomalies surface here.',
      action_label: 'Review',
      action_to: '/time',
    })
  }

  // Stale drafts — daily logs not submitted in 24h.
  const staleDrafts = inputs.drafts.filter((d) => Date.now() - Date.parse(d.updated_at) > 24 * 3600 * 1000)
  if (staleDrafts.length > 0) {
    items.push({
      id: 'attn:drafts_stale',
      kind: 'drafts_stale',
      tone: 'accent',
      eyebrow: `${staleDrafts.length} draft${staleDrafts.length === 1 ? '' : 's'} · last touch > 24h`,
      title: "Daily logs aren't getting submitted",
      detail: 'A foreman has unsubmitted draft logs older than yesterday.',
      attribution: 'Drafts go stale ≥ 24h surface here.',
      action_label: 'Open Logs',
      action_to: '/log',
    })
  }

  return items
}

export function AttentionList({
  items,
  reviewsPending,
}: {
  items: AttentionItem[]
  /** Pending time-review rows used by the bulk "Approve clean (N)" action on the reviews_pending item. */
  reviewsPending: TimeReviewRunRow[]
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [whyOpen, setWhyOpen] = useState<string | null>(null)
  const visible = items.filter((i) => !dismissed.has(i.id))

  // Bulk approve clean (anomaly_count === 0) reviews. Fires sequential
  // dispatches — count is bounded by stale.length on the home screen so
  // a serial loop is fine and avoids 5xx storms on the workflow tx.
  const qc = useQueryClient()
  const approveClean = useMutation<{ approved: number }, Error, void>({
    mutationFn: async () => {
      const clean = reviewsPending.filter((r) => r.anomaly_count === 0)
      let approved = 0
      for (const run of clean) {
        try {
          await dispatchTimeReviewEvent(run.id, { event: 'APPROVE', state_version: run.state_version })
          approved += 1
        } catch {
          /* swallow per-run failures so one stale state_version doesn't
             abort the rest of the batch — the UI surfaces the count of
             approvals that landed and refetches truth. */
        }
      }
      return { approved }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.timeReviewRuns.all() })
    },
  })

  if (visible.length === 0) {
    return (
      <Card>
        <div className="text-[13px] font-semibold">Nothing's flagged.</div>
        <div className="text-[11px] text-ink-3 mt-1">
          When labor goes over budget, time entries pile up, or daily logs go stale, they'll surface here.
        </div>
      </Card>
    )
  }

  const cleanCount = reviewsPending.filter((r) => r.anomaly_count === 0).length

  return (
    <div className="space-y-2.5">
      {visible.map((item) => {
        const isReviews = item.kind === 'reviews_pending'
        return (
          <StripeCard key={item.id} tone={item.tone}>
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-warn">{item.eyebrow}</div>
              <Dismiss onDismiss={() => setDismissed((d) => new Set([...d, item.id]))} />
            </div>
            <div className="text-[14.5px] font-semibold leading-snug">{item.title}</div>
            <div className="text-[12px] text-ink-2 mt-1 leading-relaxed">{item.detail}</div>

            <div className="mt-2.5 pt-2.5 border-t border-dashed border-line-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setWhyOpen(item.id)}
                className="text-[12px] text-ink-2 font-medium px-2 py-2 rounded-md border border-line bg-card-soft active:bg-line/40"
              >
                Why now?
              </button>
              {isReviews && cleanCount > 0 ? (
                <MobileButton
                  variant="primary"
                  size="sm"
                  fullWidth
                  onClick={() => approveClean.mutate()}
                  disabled={approveClean.isPending}
                >
                  {approveClean.isPending ? 'Approving…' : `Approve clean (${cleanCount})`}
                </MobileButton>
              ) : (
                <Link to={item.action_to} className="block">
                  <MobileButton variant="primary" size="sm" fullWidth>
                    {item.action_label}
                  </MobileButton>
                </Link>
              )}
            </div>

            {whyOpen === item.id ? (
              <div className="mt-2">
                <WhyThis title={item.title} attribution={item.attribution}>
                  {item.detail}
                </WhyThis>
                <button
                  type="button"
                  onClick={() => setWhyOpen(null)}
                  className="mt-1 text-[11px] text-ink-3 underline-offset-2 hover:underline"
                >
                  Close
                </button>
              </div>
            ) : (
              <div className="mt-1.5">
                <Attribution source={item.attribution} state="muted" />
              </div>
            )}
          </StripeCard>
        )
      })}
      {approveClean.data?.approved ? (
        <div className="text-[11px] text-good text-center">
          Approved {approveClean.data.approved} run{approveClean.data.approved === 1 ? '' : 's'}.
        </div>
      ) : null}
    </div>
  )
}

interface BidFollowUpListProps {
  insights: AiInsight<BidFollowUpDraft>[]
  onScan: () => void
  scanning: boolean
  onApply: (id: string) => Promise<void>
  onDismiss: (id: string) => Promise<void>
}

export function BidFollowUpList({ insights, onScan, scanning, onApply, onDismiss }: BidFollowUpListProps) {
  if (insights.length === 0) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={onScan}
          disabled={scanning}
          className="w-full py-3 rounded-md border border-line text-[13px] font-medium text-ink-2 disabled:opacity-50"
        >
          {scanning ? 'Scanning…' : 'Scan for stale bids'}
        </button>
      </div>
    )
  }
  return (
    <div className="mt-4 space-y-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Bid follow-ups</div>
      {insights.map((insight) => (
        <AgentSurface key={insight.id} banner={`Agent draft · ${insight.confidence} confidence`}>
          <div className="text-[13px] font-semibold mb-1">{insight.payload.subject}</div>
          <div className="text-[12px] text-ink-2 leading-relaxed whitespace-pre-wrap">{insight.payload.body}</div>
          <div className="mt-2 pt-2 border-t border-dashed border-line-2 flex items-center justify-between">
            <Attribution source={insight.attribution} />
            <span className="text-[11px] text-ink-3">{insight.payload.days_outstanding}d out</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void onApply(insight.id)}
              className="py-2 rounded-md bg-accent text-white text-[12px] font-medium"
            >
              Mark sent
            </button>
            <button
              type="button"
              onClick={() => void onDismiss(insight.id)}
              className="py-2 rounded-md border border-line text-ink-2 text-[12px] font-medium"
            >
              Dismiss
            </button>
          </div>
        </AgentSurface>
      ))}
    </div>
  )
}
