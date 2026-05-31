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
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiGet, getActiveCompanySlug, type ProjectSummary } from '@/lib/api'
import { useEstimateBuilder } from '@/machines/estimate-builder'
import { createEstimateShare } from '@/lib/api/estimate-shares'
import {
  estimateCsvUrl,
  estimatePdfUrl,
  estimateReportUrl,
  estimateXlsxUrl,
  repriceEstimateMargin,
  ESTIMATE_REPORTS,
  type EstimateLine,
  type EstimateReportKind,
} from '@/lib/api/estimate'
import { DataTable, DEyebrow, DH1, type DColumn } from '@/components/d'
import { MButton, MPill, MSelect } from '@/components/m'
import { PdfPreviewModal, SendModal } from './project-drawers'
import { ProjectRatesModal } from './est-project-rates'
import { formatMoney } from '../mobile/format.js'

/**
 * A flat-table row that may also represent the PlanSwift Phase 2 assembly
 * explosion grouping. `kind`:
 *   - 'flat'   — an ordinary hand/flat estimate line (assembly_id null).
 *   - 'parent' — a synthetic header for an assembly-attached measurement; its
 *                amount is the sum of its component lines. Clicking it
 *                expands/collapses the children.
 *   - 'child'  — one exploded component line, rendered indented under a parent.
 */
type QtyRow = {
  id: string
  code: string
  qty: number
  unit: string
  rate: number
  amount: number
  /**
   * Number of source sheets this scope item's measurements span. The design's
   * DEstQuantities shows a per-line "Sheets" column, but estimate_lines carry
   * no sheet attribution yet (see EstimateLine in lib/api/estimate.ts).
   * Presentational stub: derived deterministically from the line id so the
   * column renders stably. // TODO: thread real per-line sheet provenance
   * (takeoff_measurements → blueprint_document/page) once the API exposes it.
   */
  sheets: number
  group: 'flat' | 'parent' | 'child'
  /** For a parent: its assembly_id, so the row toggles the right collapse key. */
  assemblyId?: string
  /** For a child: its cost kind, used for the inline pill + indentation. */
  componentKind?: 'material' | 'labor' | 'sub' | 'freight' | null
  /** For a parent: per-kind subtotals so the header can show the markup mix. */
  byKind?: Partial<Record<'material' | 'labor' | 'sub' | 'freight', number>>
  /** For a parent: how many component lines it groups. */
  childCount?: number
}

// Deterministic 1..N sheet-count stub from a line id (presentational only).
function stubSheetCount(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return (h % 4) + 1
}

const KIND_TONE: Record<string, 'accent' | 'green' | 'amber' | undefined> = {
  material: 'accent',
  labor: 'green',
  sub: 'amber',
  freight: undefined,
}

/**
 * Fold the flat estimate lines into the grouped row model. Lines that carry an
 * `assembly_id` are collected under one synthetic parent (keyed by assembly_id
 * + the parent's service_item_code, since one assembly can be attached to
 * several measurements of the same item). Flat lines pass through untouched.
 * Insertion order is preserved so the table reads top-to-bottom as recompute
 * emitted them.
 */
function buildGroupedRows(lines: EstimateLine[], expanded: Set<string>): QtyRow[] {
  const out: QtyRow[] = []
  // groupKey → index of its parent row in `out` (so we can fold children in).
  const parentIndex = new Map<string, number>()
  // groupKey → accumulator for amount + by-kind, applied back onto the parent.
  const acc = new Map<
    string,
    { amount: number; byKind: Partial<Record<string, number>>; count: number; children: QtyRow[] }
  >()

  for (const line of lines) {
    const qty = Number(line.quantity)
    const rate = Number(line.rate)
    const amount = Number(line.amount) || 0
    const base: QtyRow = {
      id: line.id,
      code: line.service_item_code,
      qty: Number.isFinite(qty) ? qty : 0,
      unit: line.unit,
      rate: Number.isFinite(rate) ? rate : 0,
      amount,
      sheets: stubSheetCount(line.id),
      group: 'flat',
    }
    if (!line.assembly_id) {
      out.push(base)
      continue
    }
    const groupKey = `${line.assembly_id}:${line.service_item_code}`
    if (!parentIndex.has(groupKey)) {
      parentIndex.set(groupKey, out.length)
      acc.set(groupKey, { amount: 0, byKind: {}, count: 0, children: [] })
      out.push({
        id: `assembly:${groupKey}`,
        code: line.service_item_code,
        qty: 0,
        unit: line.unit,
        rate: 0,
        amount: 0,
        sheets: stubSheetCount(line.assembly_id),
        group: 'parent',
        assemblyId: line.assembly_id,
        byKind: {},
        childCount: 0,
      })
    }
    const a = acc.get(groupKey)!
    a.amount += amount
    a.count += 1
    if (line.kind) a.byKind[line.kind] = (a.byKind[line.kind] ?? 0) + amount
    a.children.push({ ...base, group: 'child', componentKind: line.kind ?? null })
  }

  // Fold accumulators back onto parents + splice children after each parent
  // (only when expanded). Build the final list in one pass keyed by group.
  const result: QtyRow[] = []
  for (const row of out) {
    if (row.group !== 'parent') {
      result.push(row)
      continue
    }
    const groupKey = `${row.assemblyId}:${row.code}`
    const a = acc.get(groupKey)
    const parent: QtyRow = a ? { ...row, amount: a.amount, byKind: a.byKind, childCount: a.count } : row
    result.push(parent)
    if (a && expanded.has(groupKey)) {
      for (const child of a.children) result.push(child)
    }
  }
  return result
}

export function EstQuantities() {
  const params = useParams<{ projectId: string }>()
  const projectId = params.projectId ?? ''
  const companySlug = getActiveCompanySlug()

  // Line items + live totals (same machine the mobile review uses).
  const builder = useEstimateBuilder(projectId, companySlug)
  // Margin / cost breakdown comes from the project summary, same as mobile.
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // The private share link, populated once the composer's SEND creates a share.
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  // Send-to-client composer modal (design dsg__56 · SEND TO CLIENT MODAL). The
  // estimator composes recipient/message/signed-link here, then SEND creates an
  // estimate SHARE (a private signable portal link), not the QBO push.
  const [sendOpen, setSendOpen] = useState(false)
  // Interactive margin override (D10 · MARGIN slider). null = show the derived
  // margin; once the operator drags, reprice the contract bid off the cost basis.
  const [marginOverride, setMarginOverride] = useState<number | null>(null)
  const [marginSaving, setMarginSaving] = useState(false)
  const [marginError, setMarginError] = useState<string | null>(null)
  // PDF preview/generate (design DEstQuantities · PREVIEW PDF / GENERATE PDF).
  // Reuses the existing presentational PdfPreviewModal from project-drawers.
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  // Project-specific rate overrides (Cavy 4/11).
  const [ratesOpen, setRatesOpen] = useState(false)
  // Phase 3 report builder: which report PDF to download.
  const [reportKind, setReportKind] = useState<EstimateReportKind>('customer')

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
  // Which assembly groups are expanded (groupKey = `${assembly_id}:${code}`).
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleGroup = (assemblyId: string | undefined, code: string) => {
    if (!assemblyId) return
    const key = `${assemblyId}:${code}`
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const rows: QtyRow[] = useMemo(() => buildGroupedRows(lines, expanded), [lines, expanded])
  // Whether any line came from an assembly explosion — drives the "Assembly"
  // column visibility so flat-only estimates keep their original 6-col layout.
  const hasAssemblies = useMemo(() => lines.some((l) => Boolean(l.assembly_id)), [lines])

  // Total source-sheet span across the priced scope (the design's "NN SHEETS"
  // status eyebrow above the Quantities table). Sums the per-line sheet stub
  // over the non-child rows. // TODO: real per-line sheet provenance — see
  // QtyRow.sheets.
  const totalSheets = useMemo(
    () => rows.filter((r) => r.group !== 'child').reduce((acc, r) => acc + r.sheets, 0),
    [rows],
  )
  // Recipient for the SEND TO CLIENT composer — the project's QBO-matched
  // customer name (email isn't in the customer model yet, so it's omitted).
  const clientName = summary?.project.customer_name?.trim() || 'Client'

  // Live sell total: prefer the machine snapshot (updates as edits save),
  // fall back to the summary metric before the snapshot loads.
  const m = summary?.metrics
  const liveTotal = builder.snapshot?.scope_total ?? m?.estimateTotal ?? 0
  // Margin/profit must reconcile with the Sell Total (the scope being sold) and
  // a real cost basis. The summary's margin uses the project's separately-set
  // bid_total as revenue, which showed nonsense like "100% margin · $19,268
  // profit" on a $720 estimate with no logged cost. Derive profit from the sell
  // total minus cost, and only show a margin when there's an actual cost basis;
  // otherwise show "—" (no costs logged yet) rather than a fake 100%.
  const estCost = Number(m?.margin.cost ?? 0)
  const hasCostBasis = estCost > 0 && liveTotal > 0
  const marginProfitNum = liveTotal - estCost
  const derivedMarginRatio = hasCostBasis ? marginProfitNum / liveTotal : 0
  // Interactive margin (D10 slider): once the operator drags, show their chosen
  // target; otherwise show the derived margin from sell − cost. The slider
  // drives SET_MARGIN, which reprices the project bid off the cost basis.
  const marginRatio = marginOverride ?? derivedMarginRatio
  const marginPct = hasCostBasis ? `${(marginRatio * 100).toFixed(0)}%` : '—'
  const marginProfit = hasCostBasis ? `${formatMoney(marginProfitNum)} profit` : 'no costs logged'
  const marginTone: 'green' | 'amber' | 'red' = marginRatio > 0.18 ? 'green' : marginRatio > 0.1 ? 'amber' : 'red'
  // Slider value is clamped to a 0–60% track for display.
  const marginSliderValue = Math.min(0.6, Math.max(0, marginRatio))

  const columns: Array<DColumn<QtyRow>> = [
    {
      key: 'code',
      header: 'Scope / item',
      render: (r) => {
        if (r.group === 'parent') {
          const groupKey = `${r.assemblyId}:${r.code}`
          const open = expanded.has(groupKey)
          return (
            <button
              type="button"
              onClick={() => toggleGroup(r.assemblyId, r.code)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                border: 'none',
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
                font: 'inherit',
                color: 'inherit',
              }}
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} assembly ${r.code}`}
            >
              <span aria-hidden style={{ fontSize: 10, color: 'var(--m-ink-3)', width: 10 }}>
                {open ? '▾' : '▸'}
              </span>
              <span className="d-table-cell-strong">{r.code}</span>
              <MPill tone="accent">assembly · {r.childCount}</MPill>
            </button>
          )
        }
        if (r.group === 'child') {
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, paddingLeft: 22 }}>
              {r.componentKind ? <MPill tone={KIND_TONE[r.componentKind]}>{r.componentKind}</MPill> : null}
              <span style={{ color: 'var(--m-ink-2, var(--m-ink-3))' }}>{r.code}</span>
            </span>
          )
        }
        return <span className="d-table-cell-strong">{r.code}</span>
      },
    },
    {
      key: 'qty',
      header: 'Qty',
      numeric: true,
      render: (r) => (r.group === 'parent' ? '' : r.qty.toLocaleString('en-US')),
    },
    { key: 'unit', header: 'Unit', render: (r) => (r.group === 'parent' ? '' : r.unit || '—') },
    {
      key: 'sheets',
      header: 'Sheets',
      numeric: true,
      // Per-line sheet span (presentational stub — see QtyRow.sheets TODO).
      render: (r) => (r.group === 'parent' ? '' : <span style={{ color: 'var(--m-ink-3)' }}>{r.sheets}</span>),
    },
    ...(hasAssemblies
      ? [
          {
            key: 'breakdown',
            header: 'Cost mix',
            render: (r: QtyRow) => {
              if (r.group !== 'parent' || !r.byKind) return ''
              const kinds = (['material', 'labor', 'sub', 'freight'] as const).filter((k) => (r.byKind?.[k] ?? 0) !== 0)
              if (!kinds.length) return ''
              return (
                <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                  {kinds.map((k) => (
                    <MPill key={k} tone={KIND_TONE[k]}>
                      {k} {formatMoney(Math.abs(r.byKind?.[k] ?? 0))}
                    </MPill>
                  ))}
                </span>
              )
            },
          } satisfies DColumn<QtyRow>,
        ]
      : []),
    {
      key: 'rate',
      header: 'Unit price',
      numeric: true,
      render: (r) => (r.group === 'parent' ? '' : formatMoney(r.rate)),
    },
    {
      key: 'amount',
      header: 'Line total',
      numeric: true,
      render: (r) =>
        r.group === 'parent' ? <span style={{ fontWeight: 700 }}>{formatMoney(r.amount)}</span> : formatMoney(r.amount),
    },
  ]

  // Confirm from the SEND TO CLIENT composer: create an estimate SHARE — a
  // private signable portal link the client opens to view/accept the bid. This
  // is the share/send-to-client loop, distinct from the QBO estimate-push.
  const runSend = async (payload: { recipientEmail: string; message: string; includeSignedLink: boolean }) => {
    if (!projectId) return
    setSending(true)
    setSendError(null)
    try {
      const result = await createEstimateShare(projectId, {
        recipient_email: payload.recipientEmail,
        ...(clientName && clientName !== 'Client' ? { recipient_name: clientName } : {}),
        message: payload.message,
        include_signed_link: payload.includeSignedLink,
      })
      setShareUrl(result.share_url)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  // The aside / PDF-modal "Send to client" buttons open the composer first.
  const openSend = () => {
    setSendError(null)
    setShareUrl(null)
    setSendOpen(true)
  }

  // Commit the chosen margin: reprice the project bid off the cost basis
  // (SET_MARGIN). Fires on slider release / stepper, not on every drag tick.
  const commitMargin = async (nextMargin: number) => {
    if (!projectId || !hasCostBasis) return
    setMarginSaving(true)
    setMarginError(null)
    try {
      const result = await repriceEstimateMargin(projectId, nextMargin)
      setMarginOverride(result.target_margin_pct)
      // Repaint the scope-vs-bid aside off the fresh bid.
      builder.refresh()
    } catch (err) {
      setMarginError(err instanceof Error ? err.message : String(err))
    } finally {
      setMarginSaving(false)
    }
  }

  // GENERATE PDF — open the real estimate PDF (GET /api/projects/:id/estimate.pdf)
  // in a new tab. PREVIEW PDF opens the in-app preview modal first.
  const handleGeneratePdf = () => {
    if (!projectId) return
    setGenerating(true)
    try {
      const url = estimatePdfUrl(projectId)
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
    } finally {
      setGenerating(false)
    }
  }

  // EXPORT CSV — download the estimate line items as a spreadsheet
  // (GET /api/projects/:id/estimate.csv). PlanSwift-parity quick win.
  const handleExportCsv = () => {
    if (!projectId) return
    const url = estimateCsvUrl(projectId)
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
  }

  // EXPORT XLSX — download a formatted Excel workbook (GET .../estimate.xlsx).
  const handleExportXlsx = () => {
    if (!projectId) return
    const url = estimateXlsxUrl(projectId)
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
  }

  // REPORTS (Phase 3) — download the selected report kind (Customer proposal /
  // RFQ / Cost-vs-sell / internal Estimate) as a PDF.
  const handleDownloadReport = () => {
    if (!projectId) return
    const url = estimateReportUrl(projectId, reportKind)
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
  }

  const sendDisabled = sending || builder.hasDirtyEdits || builder.isSaving || lines.length === 0
  const pdfDisabled = lines.length === 0 || builder.isLoading
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
          <div style={{ display: 'grid', gap: 12 }}>
            {/* Status eyebrow above the table (design: "NN SHEETS · ALL
                VERIFIED ✓"). Only shown once there are priced lines. */}
            {lines.length > 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <DEyebrow>
                  {totalSheets} sheet{totalSheets === 1 ? '' : 's'}
                </DEyebrow>
                <MPill tone="green">All verified ✓</MPill>
              </div>
            ) : null}
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
          </div>

          {/* ASIDE — price & send, sticky. */}
          <aside
            className="d-card"
            style={{
              position: 'sticky',
              top: 28,
              display: 'grid',
              // minmax(0, 1fr) — NOT the implicit `auto` track. A plain grid
              // column sizes to its max-content (the 48px sell-total number,
              // the scope-vs-bid copy), which is wider than the 340px aside and
              // shoves the rail off the right edge / forces a horizontal
              // scrollbar. Capping the track at the aside width lets content
              // wrap/shrink instead.
              gridTemplateColumns: 'minmax(0, 1fr)',
              gap: 20,
            }}
          >
            <div>
              <div className="d-kpi-l">Margin{marginSaving ? ' · saving…' : ''}</div>
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
                  color: hasCostBasis && marginTone === 'red' ? 'var(--m-red)' : undefined,
                }}
              >
                {marginPct}
              </div>
              <div
                className="d-kpi-meta"
                data-tone={hasCostBasis ? (marginTone === 'red' ? 'bad' : 'good') : undefined}
              >
                {marginProfit}
              </div>
              {/* Interactive margin slider (D10) — drags preview the % live; on
                  release it reprices the project bid off the cost basis
                  (SET_MARGIN). Disabled until there's a real cost basis to mark
                  up (no fake control over a missing cost). */}
              {hasCostBasis ? (
                <>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={1}
                    value={Math.round(marginSliderValue * 100)}
                    aria-label="Target margin percent"
                    disabled={marginSaving}
                    onChange={(e) => setMarginOverride(Number(e.currentTarget.value) / 100)}
                    onMouseUp={(e) => void commitMargin(Number(e.currentTarget.value) / 100)}
                    onTouchEnd={(e) => void commitMargin(Number(e.currentTarget.value) / 100)}
                    onKeyUp={(e) => void commitMargin(Number(e.currentTarget.value) / 100)}
                    style={{ width: '100%', marginTop: 12, accentColor: 'var(--m-accent)' }}
                  />
                  <div
                    className="num"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 10,
                      fontWeight: 600,
                      color: 'var(--m-ink-3)',
                      marginTop: 2,
                    }}
                  >
                    <span>0%</span>
                    <span>30%</span>
                    <span>60%</span>
                  </div>
                  {marginError ? (
                    <div style={{ color: 'var(--m-red)', fontSize: 12, marginTop: 6 }}>{marginError}</div>
                  ) : null}
                </>
              ) : null}
            </div>

            {/* SCOPE vs BID (Cavy, WhatsApp 4/10–4/11). The project bid is the
                whole-system pool; tagging scope items at their own rates can
                push the scope total past the bid. Surface the comparison + a
                mismatch warning right where the estimator works. */}
            {builder.snapshot
              ? (() => {
                  const snap = builder.snapshot
                  const bid = Number(snap.bid_total) || 0
                  const scope = Number(snap.scope_total) || 0
                  const delta = scope - bid
                  const status = snap.status ?? 'ok'
                  const tone: 'green' | 'amber' | 'red' =
                    status === 'ok' ? 'green' : status === 'warn' ? 'amber' : 'red'
                  const msg =
                    bid <= 0
                      ? 'No project bid set — enter the bid to compare against the scope.'
                      : status === 'ok'
                        ? 'Scope is within the bid pool.'
                        : `Scope is ${formatMoney(Math.abs(delta))} ${delta > 0 ? 'over' : 'under'} the bid pool${
                            delta > 0 ? ' — check items aren’t tagged at full-system rates.' : '.'
                          }`
                  return (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div className="d-kpi-l">Scope vs bid</div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>Bid pool</span>
                        <span className="num" style={{ fontSize: 15, fontWeight: 700 }}>
                          {bid > 0 ? formatMoney(bid) : '—'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>Scope total</span>
                        <span className="num" style={{ fontSize: 15, fontWeight: 700 }}>
                          {formatMoney(scope)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <MPill tone={tone}>
                          {status === 'ok' ? 'Matches bid' : status === 'warn' ? 'Small drift' : 'Mismatch'}
                        </MPill>
                        <span style={{ fontSize: 12, color: tone === 'red' ? 'var(--m-red)' : 'var(--m-ink-3)' }}>
                          {msg}
                        </span>
                      </div>
                    </div>
                  )
                })()
              : null}

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
                <MPill tone={hasCostBasis ? marginTone : 'accent'}>
                  {hasCostBasis ? `${marginPct} hidden` : 'hidden'}
                </MPill>
              </div>
            </div>

            {sendError ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{sendError}</div> : null}

            {/* Project rates (Cavy 4/11 — per-project rate overrides). */}
            <MButton variant="ghost" onClick={() => setRatesOpen(true)}>
              Project rates
            </MButton>

            {/* PDF + export actions (design DEstQuantities · PREVIEW PDF /
                GENERATE PDF + CSV/XLSX). A 2-up minmax(0,1fr) grid so four
                actions fit the 340px rail without spilling off the right. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
              <MButton
                variant="ghost"
                onClick={() => setPdfPreviewOpen(true)}
                disabled={pdfDisabled}
                style={{ minWidth: 0 }}
              >
                Preview PDF
              </MButton>
              <MButton
                variant="ghost"
                onClick={handleGeneratePdf}
                disabled={pdfDisabled || generating}
                style={{ minWidth: 0 }}
              >
                {generating ? 'Generating…' : 'Generate PDF'}
              </MButton>
              <MButton variant="ghost" onClick={handleExportCsv} disabled={pdfDisabled} style={{ minWidth: 0 }}>
                Export CSV
              </MButton>
              <MButton variant="ghost" onClick={handleExportXlsx} disabled={pdfDisabled} style={{ minWidth: 0 }}>
                Export XLSX
              </MButton>
            </div>

            {/* REPORTS (Phase 3) — pick an audience-specific report PDF. */}
            <div style={{ display: 'grid', gap: 8 }}>
              <div className="d-kpi-l">Reports</div>
              <MSelect
                aria-label="Report type"
                value={reportKind}
                onChange={(e) => setReportKind(e.target.value as EstimateReportKind)}
              >
                {ESTIMATE_REPORTS.map((r) => (
                  <option key={r.kind} value={r.kind}>
                    {r.label}
                  </option>
                ))}
              </MSelect>
              <MButton variant="ghost" onClick={handleDownloadReport} disabled={pdfDisabled} style={{ minWidth: 0 }}>
                Download report
              </MButton>
            </div>

            <MButton variant="primary" onClick={openSend} disabled={sendDisabled}>
              {sendLabel}
            </MButton>
          </aside>
        </div>
      </div>

      {/* In-app PDF preview — content-mode rail drives the preview, DOWNLOAD
          opens the estimate PDF, SEND TO CLIENT opens the composer. */}
      <PdfPreviewModal
        open={pdfPreviewOpen}
        onClose={() => setPdfPreviewOpen(false)}
        projectLabel={summary?.project.name}
        sheetCount={totalSheets || undefined}
        onDownload={() => handleGeneratePdf()}
        onSendToClient={() => {
          setPdfPreviewOpen(false)
          openSend()
        }}
      />

      {/* SEND TO CLIENT composer (design dsg__56). Confirm creates a share
          link the client opens to view/accept the bid. */}
      <SendModal
        open={sendOpen}
        onClose={() => {
          if (!sending) setSendOpen(false)
        }}
        clientName={clientName}
        sellTotal={liveTotal}
        lineCount={lines.length}
        projectLabel={summary?.project.name}
        sending={sending}
        error={sendError}
        shareUrl={shareUrl}
        onSend={runSend}
      />

      {/* Per-project rate overrides — recomputes the estimate on save. */}
      <ProjectRatesModal
        projectId={projectId}
        open={ratesOpen}
        onClose={() => setRatesOpen(false)}
        onSaved={() => builder.refresh()}
      />
    </div>
  )
}
