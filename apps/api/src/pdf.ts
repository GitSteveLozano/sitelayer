/**
 * Estimate PDF rendering.
 *
 * Pure module — takes a `EstimatePdfInput` shape (the same payload returned by
 * `summarizeProject` plus a company stamp) and writes a PDF document to a
 * Node `Writable`. Kept narrow so the route handler in `server.ts` can stream
 * straight to the HTTP response, and the unit tests can stream into a
 * `PassThrough` and assert byte-level shape without a live database.
 */

import type { Writable } from 'node:stream'
import PDFDocument from 'pdfkit'

const MONEY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

function money(value: number | string | null | undefined): string {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return MONEY_FORMATTER.format(0)
  return MONEY_FORMATTER.format(n)
}

function safe(value: string | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined) return fallback
  const trimmed = String(value).trim()
  return trimmed === '' ? fallback : trimmed
}

export type EstimatePdfDivision = {
  description: string
  qty: number | string
  unit: string
  rate: number | string
  ext: number | string
  // Gap G4 grouped reports: per-line cost type + division so by_cost_type /
  // by_division can subtotal. Optional — flat reports ignore them.
  kind?: string | null
  division_code?: string | null
}

/**
 * PlanSwift-parity report types (Phase 3 — report builder). One estimate model,
 * four audiences:
 *   - summary      — internal estimate overview (the original; default).
 *   - customer     — client-facing proposal: line items + the sell total only;
 *                    NO internal cost breakdown / margin / tenant slug.
 *   - rfq          — request-for-quote to subs/suppliers: scope (desc/qty/unit)
 *                    with a blank "Your price" column; no rates/totals.
 *   - cost_vs_sell — internal margin analysis: cost vs sell + margin $ / %.
 */
export type ReportKind = 'summary' | 'customer' | 'rfq' | 'cost_vs_sell' | 'by_division' | 'by_cost_type'

type ReportConfig = {
  /** Document + heading title. */
  title: string
  /** Internal-only tenant slug in the header (off for client/sub-facing copies). */
  showTenantSlug: boolean
  /** Show the sell Rate column on each line. */
  showRate: boolean
  /** Show the extended sell amount column on each line. */
  showExt: boolean
  /** RFQ: a blank "Your price" column for the sub to fill in. */
  showPriceColumn: boolean
  /** Which totals block to render. */
  totals: 'costs' | 'sell_only' | 'cost_vs_sell' | 'none'
  /** Internal bid-vs-scope variance block. */
  showVariance: boolean
  /** Gap G4 grouped reports: render a per-axis subtotal breakdown section. */
  breakdownBy?: 'division' | 'kind'
}

export const REPORT_CONFIG: Record<ReportKind, ReportConfig> = {
  summary: {
    title: 'Estimate',
    showTenantSlug: true,
    showRate: true,
    showExt: true,
    showPriceColumn: false,
    totals: 'costs',
    showVariance: true,
  },
  customer: {
    title: 'Proposal',
    showTenantSlug: false,
    showRate: true,
    showExt: true,
    showPriceColumn: false,
    totals: 'sell_only',
    showVariance: false,
  },
  rfq: {
    title: 'Request for Quote',
    showTenantSlug: false,
    showRate: false,
    showExt: false,
    showPriceColumn: true,
    totals: 'none',
    showVariance: false,
  },
  cost_vs_sell: {
    title: 'Cost vs Sell',
    showTenantSlug: true,
    showRate: true,
    showExt: true,
    showPriceColumn: false,
    totals: 'cost_vs_sell',
    showVariance: true,
  },
  by_division: {
    title: 'Estimate by Division',
    showTenantSlug: true,
    showRate: true,
    showExt: true,
    showPriceColumn: false,
    totals: 'costs',
    showVariance: false,
    breakdownBy: 'division',
  },
  by_cost_type: {
    title: 'Estimate by Cost Type',
    showTenantSlug: true,
    showRate: true,
    showExt: true,
    showPriceColumn: false,
    totals: 'costs',
    showVariance: false,
    breakdownBy: 'kind',
  },
}

export function isReportKind(value: unknown): value is ReportKind {
  return (
    value === 'summary' ||
    value === 'customer' ||
    value === 'rfq' ||
    value === 'cost_vs_sell' ||
    value === 'by_division' ||
    value === 'by_cost_type'
  )
}

/**
 * Pure subtotal grouping for the grouped report kinds (gap G4). Groups the
 * estimate lines by division_code or kind (cost type), summing the extended
 * amount per group. Null/blank keys fall into a labeled bucket.
 */
export function groupEstimatePdfLines(
  divisions: EstimatePdfDivision[],
  axis: 'division' | 'kind',
): { axis: string; groups: Array<{ key: string; subtotal: number; lineCount: number }> } {
  const byKey = new Map<string, { subtotal: number; lineCount: number }>()
  for (const d of divisions) {
    const raw = axis === 'division' ? d.division_code : d.kind
    const key =
      raw && String(raw).trim() ? String(raw).trim() : axis === 'division' ? '(no division)' : '(unclassified)'
    const cur = byKey.get(key) ?? { subtotal: 0, lineCount: 0 }
    cur.subtotal += Number(d.ext) || 0
    cur.lineCount += 1
    byKey.set(key, cur)
  }
  const groups = Array.from(byKey.entries())
    .map(([key, v]) => ({ key, subtotal: v.subtotal, lineCount: v.lineCount }))
    .sort((a, b) => b.subtotal - a.subtotal || a.key.localeCompare(b.key))
  return { axis: axis === 'division' ? 'division' : 'cost type', groups }
}

export type EstimatePdfInput = {
  company: { name: string; slug: string }
  /** Which report to render. Defaults to 'summary' (the original estimate). */
  report?: ReportKind
  project: {
    name: string
    customer_name: string | null
    location?: string | null
    division_code?: string | null
    bid_total?: number | string | null
    /** Optional total-of-scope recorded against this project (estimate scope). */
    scope_total?: number | string | null
  }
  divisions: EstimatePdfDivision[]
  /** Gap G4 grouped reports: per-axis subtotal breakdown (by_division / by_cost_type). */
  breakdown?: { axis: string; groups: Array<{ key: string; subtotal: number; lineCount: number }> }
  totals: {
    labor: number
    material: number
    overhead: number
    /** Total COST (labor + material + overhead). */
    total: number
    /** Total SELL (what the client pays — sum of line ext / estimateTotal). */
    sell: number
  }
  generatedAt?: Date
  appUrl?: string
}

/**
 * Build a normalized `EstimatePdfInput` from the `/api/projects/:id/summary`
 * payload. Splitting this from the writer keeps the renderer dependency-free
 * and lets the test seed a synthetic payload directly.
 */
export function buildEstimatePdfInputFromSummary(args: {
  company: { name: string; slug: string }
  report?: ReportKind
  summary: {
    project: {
      name: string
      customer_name: string | null
      location?: string | null
      division_code?: string | null
      bid_total?: number | string | null
      scope_total?: number | string | null
    }
    metrics: {
      laborCost: number
      materialCost: number
      subCost: number
      totalCost: number
      estimateTotal: number
    }
    estimateLines: Array<{
      service_item_code: string
      quantity: number | string
      unit: string
      rate: number | string
      amount: number | string
      kind?: string | null
      division_code?: string | null
    }>
  }
  appUrl?: string
}): EstimatePdfInput {
  const { summary, company, appUrl } = args
  const sell = Number(summary.metrics.estimateTotal ?? 0)
  const divisions: EstimatePdfDivision[] = summary.estimateLines.map((line) => ({
    description: line.service_item_code,
    qty: line.quantity,
    unit: line.unit,
    rate: line.rate,
    ext: line.amount,
    kind: line.kind ?? null,
    division_code: line.division_code ?? null,
  }))

  // Grouped report kinds (gap G4) attach a per-axis subtotal breakdown.
  const cfg = REPORT_CONFIG[args.report ?? 'summary']
  const breakdown = cfg.breakdownBy ? groupEstimatePdfLines(divisions, cfg.breakdownBy) : undefined

  // Overhead: anything in totalCost beyond labor + material + sub. Defensive
  // against future cost categories without forcing a release.
  const labor = Number(summary.metrics.laborCost ?? 0)
  const material = Number(summary.metrics.materialCost ?? 0)
  const sub = Number(summary.metrics.subCost ?? 0)
  const total = Number(summary.metrics.totalCost ?? labor + material + sub)
  const overhead = Math.max(0, total - labor - material - sub)

  return {
    company,
    ...(args.report ? { report: args.report } : {}),
    project: {
      name: summary.project.name,
      customer_name: summary.project.customer_name,
      location: summary.project.location ?? null,
      division_code: summary.project.division_code ?? null,
      bid_total: summary.project.bid_total ?? null,
      scope_total: summary.project.scope_total ?? null,
    },
    divisions,
    ...(breakdown ? { breakdown } : {}),
    totals: {
      labor,
      material: material + sub,
      overhead,
      total,
      sell,
    },
    ...(appUrl ? { appUrl } : {}),
  }
}

/**
 * Render an estimate PDF to a `Writable` (e.g. `http.ServerResponse` or a
 * `PassThrough` in tests). Resolves once the document is fully written.
 */
export function renderEstimatePdf(input: EstimatePdfInput, sink: Writable): Promise<void> {
  const cfg = REPORT_CONFIG[input.report ?? 'summary']
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    info: {
      Title: `${cfg.title} — ${input.project.name}`,
      Author: input.company.name,
      Subject: `Sitelayer ${cfg.title}`,
    },
  })

  return new Promise((resolve, reject) => {
    sink.on('error', reject)
    doc.on('error', reject)
    doc.on('end', () => resolve())
    doc.pipe(sink)

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text(input.company.name, { continued: false })
    if (cfg.showTenantSlug) {
      doc.fontSize(9).font('Helvetica').fillColor('#555555').text(`Tenant slug: ${input.company.slug}`)
    }
    doc.moveDown(0.8)
    doc.fillColor('#000000')

    // Project block
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .text(`${cfg.title} · ${safe(input.project.name)}`)
    doc.fontSize(10).font('Helvetica')
    doc.text(`Customer: ${safe(input.project.customer_name)}`)
    doc.text(`Location: ${safe(input.project.location ?? null)}`)
    if (input.project.division_code) {
      doc.text(`Division: ${input.project.division_code}`)
    }
    doc.moveDown(0.6)

    // Divisions table — columns vary by report kind.
    const tableTop = doc.y
    const colX = {
      description: 54,
      qty: 320,
      unit: 380,
      rate: 430,
      ext: 500,
    }
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text('Description', colX.description, tableTop)
    doc.text('Qty', colX.qty, tableTop)
    doc.text('Unit', colX.unit, tableTop)
    if (cfg.showRate) doc.text('Rate', colX.rate, tableTop)
    if (cfg.showExt) doc.text('Ext', colX.ext, tableTop)
    if (cfg.showPriceColumn) doc.text('Your price', colX.rate, tableTop)
    doc
      .moveTo(54, tableTop + 14)
      .lineTo(558, tableTop + 14)
      .strokeColor('#999999')
      .stroke()

    let rowY = tableTop + 20
    doc.font('Helvetica').fontSize(10).fillColor('#000000')
    if (input.divisions.length === 0) {
      doc.fillColor('#888888').text('No estimate lines.', colX.description, rowY)
      rowY += 16
    } else {
      for (const line of input.divisions) {
        if (rowY > 700) {
          doc.addPage()
          rowY = 54
        }
        doc.fillColor('#000000')
        doc.text(safe(line.description), colX.description, rowY, { width: 250 })
        doc.text(String(line.qty ?? ''), colX.qty, rowY)
        doc.text(safe(line.unit), colX.unit, rowY)
        if (cfg.showRate) doc.text(money(line.rate), colX.rate, rowY)
        if (cfg.showExt) doc.text(money(line.ext), colX.ext, rowY)
        if (cfg.showPriceColumn) {
          // Blank ruled cell for the sub/supplier to write their unit price.
          doc
            .moveTo(colX.rate, rowY + 11)
            .lineTo(558, rowY + 11)
            .strokeColor('#cccccc')
            .stroke()
        }
        rowY += 18
      }
    }
    doc.moveDown(1)
    doc.y = Math.max(doc.y, rowY + 8)

    // Totals — block depends on the report's audience.
    if (cfg.totals !== 'none') {
      const cost = Number(input.totals.total) || 0
      const sell = Number(input.totals.sell) || 0
      let totalsLines: Array<[string, string]> = []
      let heading = 'Totals'
      if (cfg.totals === 'costs') {
        totalsLines = [
          ['Labor', money(input.totals.labor)],
          ['Material', money(input.totals.material)],
          ['Overhead', money(input.totals.overhead)],
          ['Total cost', money(cost)],
        ]
      } else if (cfg.totals === 'sell_only') {
        heading = 'Total'
        totalsLines = [['Total', money(sell)]]
      } else if (cfg.totals === 'cost_vs_sell') {
        const marginDollars = sell - cost
        const marginPct = sell > 0 ? (marginDollars / sell) * 100 : 0
        heading = 'Cost vs Sell'
        totalsLines = [
          ['Total cost', money(cost)],
          ['Sell price', money(sell)],
          ['Margin', money(marginDollars)],
          ['Margin %', `${marginPct.toFixed(1)}%`],
        ]
      }
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(heading, 54, doc.y)
      doc.font('Helvetica').fontSize(10)
      for (const [label, value] of totalsLines) {
        doc.text(label, 380, doc.y, { continued: true })
        doc.text(`  ${value}`, { align: 'right' })
      }
    }

    // Breakdown by axis (gap G4: by_division / by_cost_type report). Rendered
    // with the same label/right-aligned-value primitive as the totals block.
    if (input.breakdown && input.breakdown.groups.length > 0) {
      doc.moveDown(0.8)
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor('#000000')
        .text(`Breakdown by ${input.breakdown.axis}`, 54, doc.y)
      doc.font('Helvetica').fontSize(10)
      for (const g of input.breakdown.groups) {
        doc.text(`${g.key} (${g.lineCount})`, 380, doc.y, { continued: true })
        doc.text(`  ${money(g.subtotal)}`, { align: 'right' })
      }
    }

    // Bid vs Scope variance (internal reports only).
    if (cfg.showVariance) {
      const scope =
        input.project.scope_total === null || input.project.scope_total === undefined
          ? null
          : Number(input.project.scope_total)
      const bid =
        input.project.bid_total === null || input.project.bid_total === undefined
          ? null
          : Number(input.project.bid_total)
      if (scope !== null && Number.isFinite(scope) && bid !== null && Number.isFinite(bid)) {
        const variance = bid - scope
        doc.moveDown(0.6)
        doc.font('Helvetica-Bold').text('Bid vs Scope variance')
        doc.font('Helvetica')
        doc.text(`Bid total: ${money(bid)}`)
        doc.text(`Scope total: ${money(scope)}`)
        doc.text(`Variance (bid − scope): ${money(variance)}`)
      }
    }

    // Footer
    const generated = (input.generatedAt ?? new Date()).toISOString()
    doc.moveDown(2)
    doc
      .fontSize(8)
      .fillColor('#666666')
      .text(`Generated ${generated}  ·  ${input.appUrl ?? 'https://sitelayer.sandolab.xyz'}`, 54, 740, {
        align: 'center',
        width: 504,
      })

    doc.end()
  })
}

/**
 * Headless route helper used by both the live server and the route-level
 * test. Returns the response shape the server should write — the handler is
 * responsible for actually piping/streaming. Decoupling lets the unit test
 * assert role gating, payload lookup, and PDF body size without spinning up
 * the HTTP server.
 */
export type EstimatePdfRouteResult =
  | { kind: 'forbidden'; role: string; allowed: readonly string[] }
  | { kind: 'not_found' }
  | { kind: 'ok'; filename: string; pdf: Buffer }

export async function buildEstimatePdfResponse(args: {
  role: string
  allowed: readonly string[]
  company: { name: string; slug: string }
  report?: ReportKind
  fetchSummary: () => Promise<Parameters<typeof buildEstimatePdfInputFromSummary>[0]['summary'] | null>
  appUrl?: string
}): Promise<EstimatePdfRouteResult> {
  if (!args.allowed.includes(args.role)) {
    return { kind: 'forbidden', role: args.role, allowed: args.allowed }
  }
  const summary = await args.fetchSummary()
  if (!summary) return { kind: 'not_found' }
  const report = args.report ?? 'summary'
  const input = buildEstimatePdfInputFromSummary({
    company: args.company,
    report,
    summary,
    ...(args.appUrl ? { appUrl: args.appUrl } : {}),
  })
  const { PassThrough } = await import('node:stream')
  const sink = new PassThrough()
  const chunks: Buffer[] = []
  sink.on('data', (chunk) => {
    chunks.push(chunk as Buffer)
  })
  await renderEstimatePdf(input, sink)
  const namePart = (summary.project.name ?? 'estimate').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  const prefix = report === 'summary' ? 'estimate' : `${report.replace(/_/g, '-')}-report`
  const filename = `${prefix}-${namePart}.pdf`
  return { kind: 'ok', filename, pdf: Buffer.concat(chunks) }
}
