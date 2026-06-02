/**
 * Budget vs actuals — frozen BUDGET (estimate snapshot at award) vs ACTUALS
 * (material_bills + labor_entries), per cost-code (Takeoff Deep Dive §4 —
 * bid / budget / actuals).
 *
 * Today recompute mutates estimate_lines in place, so the number the job was
 * SOLD at is lost once the estimate moves. This view reads the IMMUTABLE
 * budget snapshot taken by an explicit operator "Freeze budget" action and
 * diffs it against realized cost. estimate_lines stays the live bid — freezing
 * does not touch it. A change order re-freezes (new version); the prior
 * snapshot is never mutated.
 *
 * Mirrors est-actuals.tsx (the estimate-vs-actuals job-costs view) — same
 * DKpi / DataTable / MPill primitives.
 */
import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useBudgetVariance, useFreezeBudget, type VarianceCostCode } from '@/lib/api/budget'
import { DataTable, DEyebrow, DH1, type DColumn } from '@/components/d'
import { MPill, MButton } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

// A pill tone for a variance: on/under budget is green, modest over is amber,
// materially over is red. Confidence (high/med/low) is the ordinal magnitude.
function varianceTone(varianceCents: number, confidence: VarianceCostCode['confidence']): 'green' | 'amber' | 'red' {
  if (varianceCents <= 0) return 'green'
  return confidence === 'low' ? 'red' : 'amber'
}

function money(cents: number): string {
  return formatMoney((Number(cents) || 0) / 100)
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | undefined }) {
  return (
    <div className="d-card" style={{ display: 'grid', gap: 6 }}>
      <div className="d-kpi-l">{label}</div>
      <div
        className="num"
        style={{
          fontFamily: 'var(--m-font-display)',
          fontWeight: 800,
          fontSize: 30,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          color: tone === 'bad' ? 'var(--m-red)' : tone === 'good' ? 'var(--m-green)' : undefined,
        }}
      >
        {value}
      </div>
    </div>
  )
}

export function OwnerBudgetVariance() {
  const params = useParams()
  const projectId = params.projectId ?? null
  const variance = useBudgetVariance(projectId)
  const freeze = useFreezeBudget()

  const data = variance.data
  const costCodes = useMemo(() => data?.cost_codes ?? [], [data])

  const onFreeze = () => {
    if (!projectId) return
    freeze.mutate({ projectId })
  }

  const columns: Array<DColumn<VarianceCostCode>> = [
    {
      key: 'code',
      header: 'Cost code',
      render: (r) => (
        <span>
          <span className="d-table-cell-strong">{r.service_item_code || 'Unallocated'}</span>
          {r.division_code ? <span style={{ color: 'var(--m-ink-3)' }}> · {r.division_code}</span> : null}
        </span>
      ),
    },
    {
      key: 'budget',
      header: 'Budget',
      numeric: true,
      render: (r) => money(r.budget_total_cents),
    },
    {
      key: 'actual',
      header: 'Actual',
      numeric: true,
      render: (r) => money(r.actual_total_cents),
    },
    {
      key: 'variance',
      header: 'Variance',
      numeric: true,
      render: (r) => (
        <span style={{ color: r.variance_cents > 0 ? 'var(--m-red)' : undefined }}>
          {r.variance_cents > 0 ? '+' : ''}
          {money(r.variance_cents)}
        </span>
      ),
    },
    {
      key: 'confidence',
      header: 'On budget',
      numeric: true,
      render: (r) => <MPill tone={varianceTone(r.variance_cents, r.confidence)}>{r.confidence}</MPill>,
    },
  ]

  const summary = data?.summary
  const frozen = data?.frozen ?? false
  const variancePositive = (summary?.variance_cents ?? 0) > 0

  return (
    <div className="d-content">
      <div className="d-stack">
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <DEyebrow>Money · Budget</DEyebrow>
            <DH1>Budget vs actuals</DH1>
          </div>
          <div style={{ display: 'grid', gap: 4, justifyItems: 'end' }}>
            <MButton variant="primary" onClick={onFreeze} disabled={!projectId || freeze.isPending}>
              {freeze.isPending ? 'Freezing…' : frozen ? 'Re-freeze (change order)' : 'Freeze budget'}
            </MButton>
            {data?.snapshot ? (
              <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>
                Frozen v{data.snapshot.version} · {new Date(data.snapshot.frozen_at).toLocaleDateString()}
              </span>
            ) : null}
            {freeze.isError ? (
              <span style={{ fontSize: 12, color: 'var(--m-red)' }}>
                {freeze.error instanceof Error ? freeze.error.message : 'Freeze failed'}
              </span>
            ) : null}
          </div>
        </div>

        {!frozen ? (
          <div className="d-card" style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontWeight: 700 }}>No frozen budget yet</div>
            <div style={{ color: 'var(--m-ink-3)', fontSize: 13 }}>
              Freeze the current estimate to lock the number this job was sold at. Until then there is nothing to
              measure actuals against. Recompute keeps changing the live estimate; the freeze captures an immutable
              snapshot.
            </div>
          </div>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          <Kpi label="Budget" value={money(summary?.budget_total_cents ?? 0)} />
          <Kpi label="Actual" value={money(summary?.actual_total_cents ?? 0)} />
          <Kpi
            label="Variance"
            value={`${variancePositive ? '+' : ''}${money(summary?.variance_cents ?? 0)}`}
            tone={variancePositive ? 'bad' : 'good'}
          />
          <Kpi label="Unallocated material" value={money(summary?.unallocated_material_cents ?? 0)} />
        </div>

        <DataTable<VarianceCostCode>
          title="By cost code"
          columns={columns}
          rows={costCodes}
          rowKey={(r) => r.service_item_code || 'unallocated'}
          empty={
            variance.isLoading
              ? 'Loading…'
              : variance.isError
                ? 'Could not load budget variance.'
                : frozen
                  ? 'No cost-coded lines in the frozen budget.'
                  : 'Freeze the budget to begin tracking variance by cost code.'
          }
        />

        {data?.attribution ? <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{data.attribution}</div> : null}
      </div>
    </div>
  )
}
