import { useNavigate } from 'react-router-dom'
import type { ProjectRow } from '@/lib/api'
import { MKpi, MKpiRow, MPill, MSectionH } from '../../../components/m/index.js'
import { getActiveCompanySlug } from '../../../lib/api/client.js'
import { useRole } from '../../../lib/role.js'
import { useProjectCloseoutMachine } from '../../../machines/project-closeout.js'
import { CloseoutCard } from '../../../components/closeout/closeout-card.js'
import { useProjectLaborVariance, type LaborVarianceRow } from '../../../lib/api/labor-variance.js'
import { useProjectCloseoutSummary, type CloseoutSummaryResponse } from '../../../lib/api/closeout-summary.js'
import { formatDecimalHours, formatMoney } from '../format.js'

export function BudgetTab({
  project,
  totalHours,
  spent,
  bid,
  pctSpent,
}: {
  project: ProjectRow
  totalHours: number
  spent: number
  bid: number
  pctSpent: number
}) {
  const remaining = bid - spent
  const tone = pctSpent < 60 ? 'green' : pctSpent < 90 ? 'amber' : 'red'
  // Bar fill state mirrors the v2 brutalist convention: 'over' once the
  // job exceeds bid, 'risk' as it crowds the cap, else the accent default.
  const barState = pctSpent >= 100 ? 'over' : pctSpent >= 90 ? 'risk' : pctSpent >= 60 ? 'risk' : 'good'
  return (
    <div style={{ paddingTop: 8 }}>
      {/* Closeout summary — the strategic centerpiece per the merged-
          platform doc. Bid → labor + materials + rentals → margin. Sits
          at the top of the Budget tab so the owner sees the bottom line
          before drilling into per-code variance. */}
      <ClosingSummaryCard projectId={project.id} />
      {/* SPENT VS BID hero — the big-number the owner reads first. Display
          font, full-bleed block with a hard bottom rule, mono meta. */}
      <div style={{ padding: '18px 16px', borderBottom: '2px solid var(--m-ink)' }}>
        <MKpi label="Spent vs bid" value={formatMoney(spent)} meta={`of ${formatMoney(bid)} bid`} metaTone={tone} />
        <div className="m-progress" data-state={barState} style={{ marginTop: 14, height: 8 }}>
          <div className="m-progress-fill" style={{ width: `${Math.min(100, pctSpent)}%` }} />
        </div>
        <div
          className="num"
          style={{
            marginTop: 8,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-2)',
          }}
        >
          {pctSpent}% spent · {formatMoney(remaining)} remaining · {formatDecimalHours(totalHours, 1)} @ $
          {project.labor_rate}/hr
        </div>
      </div>
      {/* Estimate-vs-actual variance per service_item_code — the closing
          half of the foreman/owner feedback loop. Per-code spend bars sit
          right under the hero so the worst-offender code is the first
          thing the eye lands on. Self-hides on empty. */}
      <LaborVariancePanel projectId={project.id} />
      <MSectionH>Notes</MSectionH>
      <div style={{ padding: '0 16px 16px', fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>
        Budget calculated from logged labor entries × project labor rate. Materials and rentals not included in this
        rollup yet — see the Materials tab for that.
      </div>
      {/* Closeout action — drives the project-closeout workflow
          (active → completed) via GET/POST /api/projects/:id/closeout.
          Self-gates to the owner persona (admin/office); hidden for
          everyone else since the API rejects the GET for other roles. */}
      <ProjectCloseoutCard projectId={project.id} />
    </div>
  )
}

/**
 * Project-closeout action card. Routes through the SAME headless
 * `useProjectCloseoutMachine` XState machine the Overview-tab
 * CloseoutBanner uses (apps/web/src/machines/project-closeout.ts) and
 * dispatches the CLOSEOUT human event — no hand-rolled TanStack-Query +
 * ApiError/409 path. The machine owns loading/submitting/outOfSync/error;
 * the shared `CloseoutCard` renders the Budget-tab brutalist styling.
 *
 * Gated to the owner persona (admin/office map to `owner` in lib/role).
 * Non-owner personas get nothing rendered — the API GET is admin/office
 * only, so fetching for a worker/foreman would just 403.
 */
function ProjectCloseoutCard({ projectId }: { projectId: string }) {
  const role = useRole()
  const navigate = useNavigate()
  const closeout = useProjectCloseoutMachine(projectId, getActiveCompanySlug())
  const canCloseout = role === 'owner'

  // Hidden for roles without permission — never render anything.
  if (!canCloseout) return null

  return <CloseoutCard closeout={closeout} onOpenPostMortem={() => navigate(`/projects/${projectId}/post-mortem`)} />
}

/**
 * Closeout summary card — the bid → actual rollup that answers
 * "did we make money on this project?" in one glance.
 *
 * Three sections, top to bottom:
 *  1. Header row with Bid pill + Margin % pill (Margin % tone matches the
 *     variance pill convention: ≥ 10 green, 0–10 amber, < 0 red).
 *  2. KPI tiles (2-col): Bid + Total Actual + Margin (3 stacked KPIs).
 *  3. Per-bucket estimate-vs-actual table (Labor / Materials / Rentals).
 *
 * Empty state ("no data yet") renders when no bid is set AND no actuals
 * have landed — the project hasn't even started. Otherwise zeros are
 * shown explicitly so the user can see "no rentals on this job" without
 * a separate "nothing here" branch.
 *
 * Wraps GET /api/projects/:id/closeout-summary. See
 * apps/api/src/routes/projects.ts (closeout-summary branch) for the
 * server-side rollup contract.
 */
function ClosingSummaryCard({ projectId }: { projectId: string }) {
  const summary = useProjectCloseoutSummary(projectId)

  if (summary.isPending) {
    return (
      <div
        style={{
          margin: '0 16px 12px',
          padding: 14,
          fontSize: 12,
          color: 'var(--m-ink-3)',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
        }}
      >
        Loading closeout summary…
      </div>
    )
  }

  if (summary.isError) {
    return (
      <div
        style={{
          margin: '0 16px 12px',
          padding: 14,
          fontSize: 12,
          color: 'var(--m-red)',
          border: '2px solid var(--m-ink)',
        }}
      >
        Could not load closeout summary.
      </div>
    )
  }

  const data = summary.data
  if (!data) return null

  const hasAnyActual = data.total_actual > 0 || data.materials_actual > 0 || data.labor_actual > 0
  // Empty state: no bid set and no actuals recorded yet. The project
  // hasn't entered the cost-tracking phase — show the calm pre-data
  // hint instead of a row of zeros that look like a real summary.
  if (data.bid === 0 && !hasAnyActual && data.estimate_total === 0) {
    return (
      <div style={{ padding: '0 16px 12px' }}>
        <div
          style={{
            padding: '14px 16px',
            border: '2px solid var(--m-ink)',
            background: 'var(--m-card-soft)',
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              marginBottom: 4,
            }}
          >
            Closeout summary
          </div>
          <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.45 }}>
            Closeout summary fills in as labor entries, material bills, and rental invoices land.
          </div>
        </div>
      </div>
    )
  }

  const marginTone: 'green' | 'amber' | 'red' = data.margin_pct >= 10 ? 'green' : data.margin_pct >= 0 ? 'amber' : 'red'
  const marginPctLabel =
    data.bid > 0 ? `${data.margin_pct >= 0 ? '+' : '−'}${Math.abs(data.margin_pct).toFixed(1)}%` : '—'

  return (
    <div style={{ padding: '0 16px 12px' }}>
      <div
        style={{
          border: '2px solid var(--m-ink)',
          overflow: 'hidden',
          background: 'var(--m-card)',
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--m-line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            Closeout summary
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <MPill tone="blue">
              <span className="num" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                Bid {formatMoney(data.bid)}
              </span>
            </MPill>
            <MPill tone={marginTone}>
              <span className="num" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                Margin {marginPctLabel}
              </span>
            </MPill>
          </span>
        </div>

        <div style={{ padding: '12px 14px' }}>
          <MKpiRow cols={3}>
            <MKpi label="Bid" value={formatMoney(data.bid)} />
            <MKpi label="Total actual" value={formatMoney(data.total_actual)} />
            <MKpi
              label="Margin"
              value={formatMoney(data.margin)}
              meta={data.bid > 0 ? marginPctLabel : undefined}
              metaTone={marginTone}
            />
          </MKpiRow>
        </div>

        <CloseoutBucketTable summary={data} />

        <div
          style={{
            padding: '10px 14px 12px',
            borderTop: '1px solid var(--m-line)',
            fontSize: 11,
            color: 'var(--m-ink-3)',
            lineHeight: 1.45,
          }}
        >
          Variance is computed from logged labor + posted rental invoices + recorded material bills. In-progress
          invoices are not included.
        </div>
      </div>
    </div>
  )
}

function CloseoutBucketTable({ summary }: { summary: CloseoutSummaryResponse }) {
  // Per-bucket rows: estimate vs actual. Labor doesn't have its own
  // "estimated" column on the API (the estimate is per-line, not split
  // by labor / materials / rentals), so we show the project-wide
  // estimate_total as a footnote on the Labor row and leave the
  // estimate column blank for Materials / Rentals — they don't have a
  // planned baseline yet.
  const rows = [
    {
      key: 'labor',
      label: 'Labor',
      sublabel: `${summary.labor_hours.toFixed(1)}h @ $${summary.labor_rate}/hr`,
      estimate: summary.estimate_total,
      actual: summary.labor_actual,
      estimateLabel: summary.estimate_total > 0 ? `Est ${formatMoney(summary.estimate_total)}` : 'No estimate',
    },
    {
      key: 'materials',
      label: 'Materials',
      sublabel: 'Recorded bills',
      estimate: null,
      actual: summary.materials_actual,
      estimateLabel: '—',
    },
    {
      key: 'rentals',
      label: 'Rentals',
      sublabel: 'Posted invoices only',
      estimate: null,
      actual: summary.rentals_actual,
      estimateLabel: '—',
    },
  ] as const

  return (
    <div style={{ borderTop: '1px solid var(--m-line)' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto auto',
          padding: '6px 14px',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
          borderBottom: '1px solid var(--m-line)',
          background: 'var(--m-card-soft)',
        }}
      >
        <span>Bucket</span>
        <span style={{ textAlign: 'right', paddingRight: 16 }}>Estimate</span>
        <span style={{ textAlign: 'right' }}>Actual</span>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((row, idx) => (
          <li
            key={row.key}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              alignItems: 'center',
              padding: '10px 14px',
              borderBottom: idx === rows.length - 1 ? 'none' : '1px solid var(--m-line)',
              gap: 8,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-ink)' }}>{row.label}</div>
              <div style={{ fontSize: 11, color: 'var(--m-ink-3)' }}>{row.sublabel}</div>
            </div>
            <div
              className="num"
              style={{
                textAlign: 'right',
                fontSize: 12,
                color: 'var(--m-ink-2)',
                fontVariantNumeric: 'tabular-nums',
                paddingRight: 16,
              }}
            >
              {row.estimate === null ? row.estimateLabel : formatMoney(row.estimate)}
            </div>
            <div
              className="num"
              style={{
                textAlign: 'right',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--m-ink)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatMoney(row.actual)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Per-service-item planned-vs-actual variance card. Wraps
 * GET /api/projects/:id/labor-variance.
 *
 * Surfaces the top 5 worst-offender codes (already sorted by absolute
 * hours_variance_pct on the server) so the foreman can see "are we
 * ahead or behind on labor for this scope code?" without scrolling.
 * Each row shows actual / estimated quantity in the line's unit and an
 * MPill in the variance tone (green < 10%, amber 10–25%, red > 25%).
 *
 * Empty state is a calm hint rather than an error — the panel is
 * useless until `sqft_done` lands on labor entries, which only happens
 * after a job is in progress.
 */
function LaborVariancePanel({ projectId }: { projectId: string }) {
  const variance = useProjectLaborVariance(projectId)

  if (variance.isPending) {
    return (
      <div
        style={{
          margin: '0 16px 12px',
          padding: 14,
          fontSize: 12,
          color: 'var(--m-ink-3)',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
        }}
      >
        Loading scope variance…
      </div>
    )
  }

  if (variance.isError) {
    return (
      <div
        style={{
          margin: '0 16px 12px',
          padding: 14,
          fontSize: 12,
          color: 'var(--m-red)',
          border: '2px solid var(--m-ink)',
        }}
      >
        Could not load scope variance.
      </div>
    )
  }

  const rows = variance.data?.variance ?? []
  if (rows.length === 0) {
    return (
      <div style={{ padding: '0 16px 12px' }}>
        <div
          style={{
            padding: '14px 16px',
            border: '2px solid var(--m-ink)',
            background: 'var(--m-card-soft)',
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              marginBottom: 4,
            }}
          >
            Labor variance
          </div>
          <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.45 }}>
            No variance data yet — labor entries with sqft_done populate this once jobs are in progress.
          </div>
        </div>
      </div>
    )
  }

  const topRows = rows.slice(0, 5)
  const hasMore = rows.length > topRows.length

  return (
    <div>
      <div className="m-section-bar">
        <span>Labor variance · worst offenders</span>
        <span>
          {rows.length} {rows.length === 1 ? 'code' : 'codes'}
        </span>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {topRows.map((row, idx) => (
          <LaborVarianceRowItem key={row.service_item_code} row={row} isLast={idx === topRows.length - 1} />
        ))}
      </ul>
      {hasMore ? (
        <div
          className="num"
          style={{
            padding: '10px 20px',
            borderTop: '1px solid var(--m-line)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
          }}
        >
          {rows.length - topRows.length} more code{rows.length - topRows.length === 1 ? '' : 's'} · full breakdown
          coming soon
        </div>
      ) : null}
    </div>
  )
}

function LaborVarianceRowItem({ row, isLast }: { row: LaborVarianceRow; isLast: boolean }) {
  const pct = row.hours_variance_pct
  const absPct = Math.abs(pct)
  const tone: 'green' | 'amber' | 'red' = absPct < 10 ? 'green' : absPct <= 25 ? 'amber' : 'red'
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : ''
  const hasEstimate = row.estimated_quantity > 0 || row.estimated_hours > 0
  // Over-budget (actual ahead of estimate) reads as 'over'; otherwise the
  // amber/red tone maps to 'risk'; green stays the accent default.
  const barState: 'over' | 'risk' | 'good' = pct > 0 && tone === 'red' ? 'over' : tone === 'green' ? 'good' : 'risk'
  // Spend bar fill: actual / estimated, capped at the track. The leftover
  // over-budget remainder is rendered as a hard red overrun segment.
  const fillPct = hasEstimate ? Math.min(100, absPct) : 0

  return (
    <li
      style={{
        padding: '14px 20px',
        borderBottom: isLast ? 'none' : '1px solid var(--m-line)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--m-ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.service_item_code}
          </div>
          {row.division_code ? (
            <span
              className="num"
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.04em',
                color: 'var(--m-ink-3)',
                background: 'var(--m-card-soft)',
                border: '1px solid var(--m-line)',
                padding: '1px 6px',
                lineHeight: 1.3,
                flexShrink: 0,
              }}
            >
              {row.division_code}
            </span>
          ) : null}
        </div>
        <div
          className="num"
          style={{
            fontSize: 12,
            fontWeight: 800,
            flexShrink: 0,
            color: barState === 'over' ? 'var(--m-red)' : 'var(--m-ink)',
          }}
        >
          {hasEstimate ? `${sign}${absPct.toFixed(0)}%` : 'no est.'}
        </div>
      </div>
      <div
        className="num"
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
          marginTop: 4,
        }}
      >
        {formatVarianceQty(row.actual_quantity)} / {formatVarianceQty(row.estimated_quantity)} {row.unit || 'sqft'}
      </div>
      <div className="m-progress" data-state={barState} style={{ marginTop: 8, height: 4 }}>
        <div className="m-progress-fill" style={{ width: `${fillPct}%` }} />
      </div>
    </li>
  )
}

function formatVarianceQty(n: number): string {
  if (!Number.isFinite(n)) return '0'
  // sqft/lf are typically whole numbers at the foreman level; for very
  // small values keep one decimal so we don't render "0" when there's
  // partial progress.
  if (Math.abs(n) >= 10) return Math.round(n).toLocaleString()
  return n.toFixed(1)
}
