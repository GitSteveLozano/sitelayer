/**
 * Estimator desktop — EST · QUANTITIES + PRICE & SEND (Desktop v2 · 03).
 *
 * Reuses the SAME data approach as the mobile estimate review
 * (screens/mobile/estimate-review.tsx): the editable line list + live
 * totals come from the `useEstimateBuilder` machine
 * (GET /api/projects/:id/estimate/scope-vs-bid) and the margin / cost
 * breakdown comes from GET /api/projects/:id/summary. Send goes through the
 * existing `createEstimatePush` action, exactly like mobile. This is just a
 * dense desktop composition over that same hook surface.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, getActiveCompanySlug, type ProjectSummary } from '@/lib/api'
import { useEstimateBuilder } from '@/machines/estimate-builder'
import { createEstimatePush } from '@/lib/api/estimate-pushes'
import { DataTable, DEyebrow, DH1, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

type QtyRow = {
  id: string
  code: string
  qty: number
  unit: string
  rate: number
  amount: number
}

export function EstQuantities() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const companySlug = getActiveCompanySlug()

  // Line items + live totals (same machine the mobile review uses).
  const builder = useEstimateBuilder(projectId, companySlug)
  // Margin / cost breakdown comes from the project summary, same as mobile.
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    apiGet<ProjectSummary>(`/api/projects/${projectId}/summary`, companySlug)
      .then((s) => {
        if (!cancelled) setSummary(s)
      })
      .catch((err) => {
        if (!cancelled) setSummaryError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, companySlug])

  const lines = builder.lines
  const rows: QtyRow[] = lines.map((line) => {
    const qty = Number(line.quantity)
    const rate = Number(line.rate)
    return {
      id: line.id,
      code: line.service_item_code,
      qty: Number.isFinite(qty) ? qty : 0,
      unit: line.unit,
      rate: Number.isFinite(rate) ? rate : 0,
      amount: Number(line.amount) || 0,
    }
  })

  // Live sell total: prefer the machine snapshot (updates as edits save),
  // fall back to the summary metric before the snapshot loads.
  const m = summary?.metrics
  const liveTotal = builder.snapshot?.scope_total ?? m?.estimateTotal ?? 0
  const marginRatio = m?.margin.margin ?? 0
  const marginPct = m ? `${(marginRatio * 100).toFixed(0)}%` : '—'
  const marginProfit = m ? formatMoney(m.margin.profit) : '—'
  const marginTone: 'green' | 'amber' | 'red' = marginRatio > 0.18 ? 'green' : marginRatio > 0.1 ? 'amber' : 'red'

  const columns: Array<DColumn<QtyRow>> = [
    { key: 'code', header: 'Scope / item', render: (r) => <span className="d-table-cell-strong">{r.code}</span> },
    { key: 'qty', header: 'Qty', numeric: true, render: (r) => r.qty.toLocaleString('en-US') },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    { key: 'rate', header: 'Unit price', numeric: true, render: (r) => formatMoney(r.rate) },
    { key: 'amount', header: 'Line total', numeric: true, render: (r) => formatMoney(r.amount) },
  ]

  const handleSend = async () => {
    if (!projectId) return
    setSending(true)
    setSendError(null)
    try {
      const result = await createEstimatePush(projectId)
      const pushId = result.kind === 'created' ? result.pushId : result.openId
      navigate(`/projects/${projectId}/estimate-push/${pushId}`)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const sendDisabled = sending || builder.hasDirtyEdits || builder.isSaving || lines.length === 0
  const sendLabel = sending
    ? 'Drafting…'
    : builder.hasDirtyEdits || builder.isSaving
      ? 'Saving edits…'
      : 'Send to client'

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Estimator · Estimate</DEyebrow>
          <DH1>{summary?.project.name ?? (summaryError ? 'Estimate' : 'Loading…')}</DH1>
        </div>

        <div className="d-split">
          {/* MAIN — quantities table from the estimate lines/scope. */}
          <DataTable<QtyRow>
            title={builder.isSaving ? 'Quantities · saving…' : 'Quantities'}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            empty={
              builder.isLoading
                ? 'Loading line items…'
                : 'No line items yet. Run takeoff first, then recompute the estimate.'
            }
          />

          {/* ASIDE — price & send, sticky. */}
          <aside className="d-card" style={{ position: 'sticky', top: 28, display: 'grid', gap: 20 }}>
            <div>
              <div className="d-kpi-l">Margin</div>
              <div
                className="num"
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 44,
                  letterSpacing: '-0.035em',
                  lineHeight: 0.9,
                  marginTop: 6,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {marginPct}
              </div>
              <div className="d-kpi-meta" data-tone={m ? (marginTone === 'red' ? 'bad' : 'good') : undefined}>
                {marginProfit} profit
              </div>
            </div>

            <div
              style={{
                background: 'var(--m-accent)',
                color: 'var(--m-accent-ink)',
                margin: '0 -22px',
                padding: '16px 22px',
              }}
            >
              <div className="d-kpi-l" style={{ color: 'var(--m-accent-ink)' }}>
                Sell total
              </div>
              <div
                className="num"
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 48,
                  letterSpacing: '-0.035em',
                  lineHeight: 0.85,
                  marginTop: 6,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatMoney(liveTotal)}
              </div>
            </div>

            {/* CLIENT SEES — what lands on the share. */}
            <div style={{ display: 'grid', gap: 10 }}>
              <div className="d-kpi-l">Client sees</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Sell total</span>
                <span className="num" style={{ fontSize: 15, fontWeight: 700 }}>
                  {formatMoney(liveTotal)}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Line items</span>
                <MPill tone="accent">{lines.length} priced</MPill>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Margin</span>
                <MPill tone={marginTone}>{marginPct} hidden</MPill>
              </div>
            </div>

            {sendError ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{sendError}</div> : null}

            <MButton variant="primary" onClick={handleSend} disabled={sendDisabled}>
              {sendLabel}
            </MButton>
          </aside>
        </div>
      </div>
    </div>
  )
}
