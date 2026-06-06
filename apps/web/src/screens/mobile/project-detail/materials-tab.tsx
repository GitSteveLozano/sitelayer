/**
 * Materials tab — native mobile view of project material spend.
 *
 * Per the v3.3.0 estimator project-detail design (prj-drafting /
 * prj-progress screenshots + mb-screens-project-detail.jsx "MATERIALS"
 * section), this is a real per-project cost surface, not a link-out:
 *   - KPI strip: bill count, total recorded spend, share-of-bid.
 *   - Line rows grouped by vendor with type + date as supporting copy
 *     and the amount as the trailing tabular figure.
 * Sources `materialBills` from bootstrap (already filtered to this
 * project by the parent screen). Empty state is calm per the design.
 */
import type { BootstrapResponse, ProjectRow } from '@/lib/api'
import { MI, MKpi, MKpiRow, MListInset, MListRow, MSectionH } from '../../../components/m/index.js'
import { formatMoney, shortDate } from '../format.js'

export function MaterialsTab({ bills, project }: { bills: BootstrapResponse['materialBills']; project: ProjectRow }) {
  const visibleBills = bills.filter((b) => !b.deleted_at)
  const total = visibleBills.reduce((sum, b) => sum + Number(b.amount ?? 0), 0)
  const bid = Number(project.bid_total ?? 0)
  const pctOfBid = bid > 0 ? Math.round((total / bid) * 100) : 0

  if (visibleBills.length === 0) {
    return (
      <div style={{ paddingTop: 8 }}>
        <div style={{ padding: '0 16px 12px' }}>
          <div
            style={{
              padding: '14px 16px',
              border: '1px solid var(--m-line)',
              borderRadius: 12,
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
              Materials
            </div>
            <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.45 }}>
              No material bills recorded yet. Vendor bills and rental dispatches scoped to this project land here as the
              job runs.
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Sort newest-first so the latest spend is at the top of the list.
  const sorted = [...visibleBills].sort((a, b) => (b.occurred_on ?? '').localeCompare(a.occurred_on ?? ''))

  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px 12px' }}>
        <MKpiRow cols={3}>
          <MKpi label="Bills" value={String(visibleBills.length)} />
          <MKpi label="Recorded" value={formatMoney(total)} />
          <MKpi
            label="Of bid"
            value={bid > 0 ? `${pctOfBid}%` : '—'}
            meta={bid > 0 ? `of ${formatMoney(bid)}` : 'No bid set'}
            metaTone={bid > 0 ? (pctOfBid < 25 ? 'green' : pctOfBid < 45 ? 'amber' : 'red') : undefined}
          />
        </MKpiRow>
      </div>
      <MSectionH>Recorded bills</MSectionH>
      <MListInset>
        {sorted.map((b) => (
          <MListRow
            key={b.id}
            leading={<MI.Truck size={18} />}
            headline={b.vendor || 'Unknown vendor'}
            supporting={materialBillSupporting(b)}
            trailing={<span className="num">{formatMoney(Number(b.amount ?? 0))}</span>}
          />
        ))}
      </MListInset>
      <div style={{ padding: '8px 20px 16px', fontSize: 11, color: 'var(--m-ink-3)', lineHeight: 1.45 }}>
        Recorded vendor bills only. Rental dispatch costs and in-flight invoices are not included in this total — see
        the Budget tab for the full bid-vs-actual rollup.
      </div>
    </div>
  )
}

function materialBillSupporting(bill: BootstrapResponse['materialBills'][number]): string {
  const parts: string[] = []
  if (bill.bill_type) parts.push(prettyBillType(bill.bill_type))
  if (bill.description) parts.push(bill.description)
  if (bill.occurred_on) parts.push(shortDate(bill.occurred_on))
  return parts.join(' · ') || 'Material bill'
}

function prettyBillType(type: string): string {
  return type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
