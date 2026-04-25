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
}

export type EstimatePdfInput = {
  company: { name: string; slug: string }
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
  totals: {
    labor: number
    material: number
    overhead: number
    total: number
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
    }>
  }
  appUrl?: string
}): EstimatePdfInput {
  const { summary, company, appUrl } = args
  const divisions: EstimatePdfDivision[] = summary.estimateLines.map((line) => ({
    description: line.service_item_code,
    qty: line.quantity,
    unit: line.unit,
    rate: line.rate,
    ext: line.amount,
  }))

  // Overhead: anything in totalCost beyond labor + material + sub. Defensive
  // against future cost categories without forcing a release.
  const labor = Number(summary.metrics.laborCost ?? 0)
  const material = Number(summary.metrics.materialCost ?? 0)
  const sub = Number(summary.metrics.subCost ?? 0)
  const total = Number(summary.metrics.totalCost ?? labor + material + sub)
  const overhead = Math.max(0, total - labor - material - sub)

  return {
    company,
    project: {
      name: summary.project.name,
      customer_name: summary.project.customer_name,
      location: summary.project.location ?? null,
      division_code: summary.project.division_code ?? null,
      bid_total: summary.project.bid_total ?? null,
      scope_total: summary.project.scope_total ?? null,
    },
    divisions,
    totals: {
      labor,
      material: material + sub,
      overhead,
      total,
    },
    ...(appUrl ? { appUrl } : {}),
  }
}

/**
 * Render an estimate PDF to a `Writable` (e.g. `http.ServerResponse` or a
 * `PassThrough` in tests). Resolves once the document is fully written.
 */
export function renderEstimatePdf(input: EstimatePdfInput, sink: Writable): Promise<void> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    info: {
      Title: `Estimate — ${input.project.name}`,
      Author: input.company.name,
      Subject: 'Sitelayer Estimate',
    },
  })

  return new Promise((resolve, reject) => {
    sink.on('error', reject)
    doc.on('error', reject)
    doc.on('end', () => resolve())
    doc.pipe(sink)

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text(input.company.name, { continued: false })
    doc.fontSize(9).font('Helvetica').fillColor('#555555').text(`Tenant slug: ${input.company.slug}`)
    doc.moveDown(0.8)
    doc.fillColor('#000000')

    // Project block
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .text(`Estimate · ${safe(input.project.name)}`)
    doc.fontSize(10).font('Helvetica')
    doc.text(`Customer: ${safe(input.project.customer_name)}`)
    doc.text(`Location: ${safe(input.project.location ?? null)}`)
    if (input.project.division_code) {
      doc.text(`Division: ${input.project.division_code}`)
    }
    doc.moveDown(0.6)

    // Divisions table
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
    doc.text('Rate', colX.rate, tableTop)
    doc.text('Ext', colX.ext, tableTop)
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
        doc.text(safe(line.description), colX.description, rowY, { width: 250 })
        doc.text(String(line.qty ?? ''), colX.qty, rowY)
        doc.text(safe(line.unit), colX.unit, rowY)
        doc.text(money(line.rate), colX.rate, rowY)
        doc.text(money(line.ext), colX.ext, rowY)
        rowY += 18
      }
    }
    doc.moveDown(1)
    doc.y = Math.max(doc.y, rowY + 8)

    // Totals
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text('Totals', 54, doc.y)
    doc.font('Helvetica').fontSize(10)
    const totalsLines: Array<[string, string]> = [
      ['Labor', money(input.totals.labor)],
      ['Material', money(input.totals.material)],
      ['Overhead', money(input.totals.overhead)],
      ['Total', money(input.totals.total)],
    ]
    for (const [label, value] of totalsLines) {
      doc.text(label, 380, doc.y, { continued: true })
      doc.text(`  ${value}`, { align: 'right' })
    }

    // Bid vs Scope variance
    const scope =
      input.project.scope_total === null || input.project.scope_total === undefined
        ? null
        : Number(input.project.scope_total)
    const bid =
      input.project.bid_total === null || input.project.bid_total === undefined ? null : Number(input.project.bid_total)
    if (scope !== null && Number.isFinite(scope) && bid !== null && Number.isFinite(bid)) {
      const variance = bid - scope
      doc.moveDown(0.6)
      doc.font('Helvetica-Bold').text('Bid vs Scope variance')
      doc.font('Helvetica')
      doc.text(`Bid total: ${money(bid)}`)
      doc.text(`Scope total: ${money(scope)}`)
      doc.text(`Variance (bid − scope): ${money(variance)}`)
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
  fetchSummary: () => Promise<Parameters<typeof buildEstimatePdfInputFromSummary>[0]['summary'] | null>
  appUrl?: string
}): Promise<EstimatePdfRouteResult> {
  if (!args.allowed.includes(args.role)) {
    return { kind: 'forbidden', role: args.role, allowed: args.allowed }
  }
  const summary = await args.fetchSummary()
  if (!summary) return { kind: 'not_found' }
  const input = buildEstimatePdfInputFromSummary({
    company: args.company,
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
  const filename = `estimate-${(summary.project.name ?? 'estimate').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)}.pdf`
  return { kind: 'ok', filename, pdf: Buffer.concat(chunks) }
}
