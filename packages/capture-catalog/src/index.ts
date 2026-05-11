import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { randomUUID } from 'node:crypto'

import type {
  CatalogItem,
  CsiDivisionRollup,
  PricedEstimate,
  PricedLine,
  TakeoffQuantity,
  TakeoffResult,
} from '@sitelayer/capture-schema'
import {
  DEFAULT_OVERHEAD_AND_PROFIT,
  divisionNameFor,
  divisionOf,
  validateCatalogItem,
  validatePricedEstimate,
  validateTakeoffResult,
} from '@sitelayer/capture-schema'

export interface PriceEstimateOptions {
  laborRate: number
  overheadAndProfit?: number
  companyId: string
  projectId: string
}

export interface UnmatchedQuantity {
  takeoffQuantityId: string
  description: string
  masterformatCode: string | undefined
  uniformatCode: string | undefined
  unit: string
  reason: 'no_masterformat' | 'no_sku_for_code'
}

/**
 * `priceEstimate` returns a `PricedEstimate` plus warnings for quantities we
 * could not price. Both are returned in a small wrapper so we don't pollute the
 * canonical `PricedEstimate` shape. See NOTES.md for contract reconciliation.
 */
export interface PriceEstimateResult {
  estimate: PricedEstimate
  unmatched: UnmatchedQuantity[]
}

// ──────────────────────────────────────────────────────────────────────────
// Catalog loading
// ──────────────────────────────────────────────────────────────────────────

function defaultSeedPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, 'seed.yaml')
}

/**
 * Load the YAML catalog. Defaults to the bundled seed.yaml shipped next to
 * this module. Validates every row through `validateCatalogItem`. Throws if
 * any row fails validation.
 */
export function loadCatalog(yamlPath?: string): CatalogItem[] {
  const path = yamlPath ?? defaultSeedPath()
  const raw = readFileSync(path, 'utf8')
  const parsed = parseYaml(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`Catalog YAML at ${path} did not parse to an array (got ${typeof parsed})`)
  }
  return parsed.map((row, idx) => {
    try {
      return validateCatalogItem(row)
    } catch (err) {
      const sku =
        row && typeof row === 'object' && 'sku' in row ? String((row as { sku: unknown }).sku) : `<row ${idx}>`
      throw new Error(
        `Catalog row ${idx} (${sku}) failed validation: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  })
}

export function lookupBySku(catalog: CatalogItem[], sku: string): CatalogItem | undefined {
  return catalog.find((item) => item.sku === sku)
}

/**
 * Look up catalog rows by CSI code. Matches on the full `csiCode` (e.g.
 * `"09 29 00"`) first; if no full match is found, falls back to all rows whose
 * 2-digit division matches.
 */
export function lookupByCsi(catalog: CatalogItem[], csiCode: string): CatalogItem[] {
  const exact = catalog.filter((item) => item.csiCode === csiCode)
  if (exact.length > 0) return exact
  const division = csiCode.match(/^\d{2}/)?.[0]
  if (!division) return []
  return catalog.filter((item) => item.csiCode.startsWith(division))
}

// ──────────────────────────────────────────────────────────────────────────
// Pricing
// ──────────────────────────────────────────────────────────────────────────

interface MatchResult {
  item: CatalogItem
  unitMatched: boolean
}

function matchCatalogItem(catalog: CatalogItem[], qty: TakeoffQuantity): MatchResult | undefined {
  const code = qty.masterformatCode
  if (!code) return undefined
  const candidates = lookupByCsi(catalog, code)
  if (candidates.length === 0) return undefined
  const unitMatch = candidates.find((c) => c.unit === qty.unit)
  if (unitMatch) return { item: unitMatch, unitMatched: true }
  // Fall back to first candidate; caller will decay confidence for unit mismatch.
  return { item: candidates[0]!, unitMatched: false }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Build a priced estimate from a TakeoffResult. See research/05-pricing.md §7
 * for the formula. Each line's `rate = (material + labor + waste) / qty`,
 * preserving sitelayer's `estimate_lines.amount = qty × rate` math.
 */
export function priceEstimate(takeoff: TakeoffResult, opts: PriceEstimateOptions): PricedEstimate {
  return priceEstimateWithDetails(takeoff, opts).estimate
}

/**
 * Same as `priceEstimate` but also returns the list of quantities we couldn't
 * price. Use this from the CLI / orchestrator where we want to surface skipped
 * lines to the operator.
 */
export function priceEstimateWithDetails(takeoff: TakeoffResult, opts: PriceEstimateOptions): PriceEstimateResult {
  // Guard: validate input before pricing (per CONTRACT.md guardrail #3).
  const validated = validateTakeoffResult(takeoff)

  const catalog = loadCatalog()
  const opAndP = opts.overheadAndProfit ?? DEFAULT_OVERHEAD_AND_PROFIT
  const lines: PricedLine[] = []
  const unmatched: UnmatchedQuantity[] = []

  for (const qty of validated.quantities) {
    if (!qty.masterformatCode) {
      unmatched.push({
        takeoffQuantityId: qty.id,
        description: qty.description,
        masterformatCode: qty.masterformatCode,
        uniformatCode: qty.uniformatCode,
        unit: qty.unit,
        reason: 'no_masterformat',
      })
      continue
    }
    const match = matchCatalogItem(catalog, qty)
    if (!match) {
      unmatched.push({
        takeoffQuantityId: qty.id,
        description: qty.description,
        masterformatCode: qty.masterformatCode,
        uniformatCode: qty.uniformatCode,
        unit: qty.unit,
        reason: 'no_sku_for_code',
      })
      continue
    }
    const item = match.item
    const quantity = qty.value
    if (quantity === 0) {
      // Pricing a zero quantity yields a zero line; preserve it for
      // round-trip determinism but skip the math.
      lines.push({
        id: randomUUID(),
        serviceItemCode: item.sku,
        csiCode: item.csiCode,
        divisionCode: divisionOf(item.csiCode),
        description: item.description,
        quantity: 0,
        unit: item.unit,
        rate: 0,
        amount: 0,
        breakdown: { material: 0, labor: 0, waste: 0, laborHours: 0 },
        source: item.source,
        confidence: qty.confidence * item.confidence,
        takeoffQuantityId: qty.id,
      })
      continue
    }

    const material = quantity * item.unitPrice
    const laborHours = quantity * item.laborHoursPerUnit
    const labor = laborHours * opts.laborRate
    const waste = material * item.wasteFactor
    const rate = round2((material + labor + waste) / quantity)
    const amount = round2(quantity * rate)

    // Confidence: combine takeoff quantity confidence with catalog confidence,
    // and decay 30% if we had to fall back on unit mismatch (per spec).
    let lineConfidence = qty.confidence * item.confidence
    if (!match.unitMatched) lineConfidence *= 0.7

    lines.push({
      id: randomUUID(),
      serviceItemCode: item.sku,
      csiCode: item.csiCode,
      divisionCode: divisionOf(item.csiCode),
      description: item.description,
      quantity,
      unit: item.unit,
      rate,
      amount,
      breakdown: {
        material: round2(material),
        labor: round2(labor),
        waste: round2(waste),
        laborHours: round2(laborHours),
      },
      source: item.source,
      confidence: Math.max(0, Math.min(1, lineConfidence)),
      takeoffQuantityId: qty.id,
    })
  }

  // Rollups.
  const rollupAcc = new Map<
    string,
    { divisionCode: string; divisionName: string; material: number; labor: number; total: number }
  >()
  for (const line of lines) {
    const key = line.divisionCode
    const existing = rollupAcc.get(key) ?? {
      divisionCode: key,
      divisionName: divisionNameFor(key),
      material: 0,
      labor: 0,
      total: 0,
    }
    existing.material += line.breakdown.material + line.breakdown.waste
    existing.labor += line.breakdown.labor
    existing.total += line.amount
    rollupAcc.set(key, existing)
  }
  const rollupsByCsiDivision: CsiDivisionRollup[] = [...rollupAcc.values()]
    .map((r) => ({
      divisionCode: r.divisionCode,
      divisionName: r.divisionName,
      material: round2(r.material),
      labor: round2(r.labor),
      total: round2(r.total),
    }))
    .sort((a, b) => a.divisionCode.localeCompare(b.divisionCode))

  // Totals.
  const materialSubtotal = round2(lines.reduce((acc, l) => acc + l.breakdown.material, 0))
  const laborSubtotal = round2(lines.reduce((acc, l) => acc + l.breakdown.labor, 0))
  const wasteSubtotal = round2(lines.reduce((acc, l) => acc + l.breakdown.waste, 0))
  const baseTotal = materialSubtotal + laborSubtotal + wasteSubtotal
  const overheadAndProfit = round2(baseTotal * opAndP)
  const grandTotal = round2(baseTotal + overheadAndProfit)

  const estimate: PricedEstimate = {
    projectRef: { companyId: opts.companyId, projectId: opts.projectId },
    currency: 'USD',
    pricedAt: new Date().toISOString(),
    precedenceUsed: 'seeded_fallback',
    lines,
    rollupsByCsiDivision,
    totals: {
      materialSubtotal,
      laborSubtotal,
      wasteSubtotal,
      overheadAndProfit,
      grandTotal,
    },
  }

  // Validate output before returning (per CONTRACT.md guardrail #3).
  validatePricedEstimate(estimate)

  return { estimate, unmatched }
}

// ──────────────────────────────────────────────────────────────────────────
// HTML rendering
// ──────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtQty(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
}

const REVIEW_FLOOR = 0.7

/**
 * Render a printable HTML estimate. No external CSS — fully inline so the file
 * stands alone for printing or email.
 */
export function renderEstimateHtml(priced: PricedEstimate): string {
  const reviewFlagged = priced.lines.filter((l) => l.confidence < REVIEW_FLOOR)
  const reviewBanner =
    reviewFlagged.length > 0
      ? `<div style="background:#fff3cd;border:1px solid #ffeeba;padding:12px 16px;margin:16px 0;border-radius:4px;">
          <strong style="color:#856404">Review required</strong>
          — ${reviewFlagged.length} line(s) have confidence &lt; ${REVIEW_FLOOR}.
        </div>`
      : ''

  // Group lines by division.
  const byDivision = new Map<string, PricedLine[]>()
  for (const line of priced.lines) {
    const arr = byDivision.get(line.divisionCode) ?? []
    arr.push(line)
    byDivision.set(line.divisionCode, arr)
  }
  const divisionOrder = [...byDivision.keys()].sort()

  const divisionTables = divisionOrder
    .map((divCode) => {
      const divLines = byDivision.get(divCode) ?? []
      const rollup = priced.rollupsByCsiDivision.find((r) => r.divisionCode === divCode)
      const rows = divLines
        .map((line) => {
          const flagged = line.confidence < REVIEW_FLOOR
          const bg = flagged ? 'background:#fff3cd;' : ''
          return `<tr style="${bg}">
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;">${escapeHtml(line.csiCode)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;">${escapeHtml(line.description)}<br><span style="color:#888;font-size:10px;">SKU ${escapeHtml(line.serviceItemCode)}</span></td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${fmtQty(line.quantity)} ${escapeHtml(line.unit)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${fmtMoney(line.rate)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${fmtMoney(line.amount)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:11px;">${escapeHtml(line.source)}<br><span style="color:${flagged ? '#856404' : '#888'};">conf ${line.confidence.toFixed(2)}</span></td>
          </tr>`
        })
        .join('\n')
      const rollupTotal = rollup ? fmtMoney(rollup.total) : '—'
      return `<section style="margin:24px 0;">
        <h2 style="font-size:14px;border-bottom:2px solid #333;padding-bottom:4px;margin-bottom:8px;">
          Division ${escapeHtml(divCode)} — ${escapeHtml(rollup?.divisionName ?? '')}
        </h2>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #333;">CSI</th>
              <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #333;">Description</th>
              <th style="padding:6px 8px;text-align:right;border-bottom:2px solid #333;">Qty</th>
              <th style="padding:6px 8px;text-align:right;border-bottom:2px solid #333;">Rate</th>
              <th style="padding:6px 8px;text-align:right;border-bottom:2px solid #333;">Amount</th>
              <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #333;">Source / Conf</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr style="background:#fafafa;">
              <td colspan="4" style="padding:6px 8px;text-align:right;font-weight:600;">Division ${escapeHtml(divCode)} subtotal</td>
              <td style="padding:6px 8px;text-align:right;font-weight:700;">${rollupTotal}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </section>`
    })
    .join('\n')

  const totals = priced.totals
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Estimate — ${escapeHtml(priced.projectRef.projectId)}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 24px; color: #222;">
  <header style="border-bottom: 3px solid #222; padding-bottom: 12px; margin-bottom: 16px;">
    <h1 style="margin:0 0 4px 0;font-size:22px;">Construction Estimate</h1>
    <div style="font-size:12px;color:#555;">
      Project <strong>${escapeHtml(priced.projectRef.projectId)}</strong>
      · Company <strong>${escapeHtml(priced.projectRef.companyId)}</strong>
      · Priced ${escapeHtml(priced.pricedAt)}
      · Precedence <code>${escapeHtml(priced.precedenceUsed)}</code>
    </div>
  </header>
  ${reviewBanner}
  ${divisionTables}
  <section style="margin-top: 24px; padding-top: 12px; border-top: 2px solid #222;">
    <table style="width: 360px; margin-left: auto; font-size: 13px;">
      <tr><td style="padding:4px 8px;">Material subtotal</td><td style="padding:4px 8px;text-align:right;">${fmtMoney(totals.materialSubtotal)}</td></tr>
      <tr><td style="padding:4px 8px;">Labor subtotal</td><td style="padding:4px 8px;text-align:right;">${fmtMoney(totals.laborSubtotal)}</td></tr>
      <tr><td style="padding:4px 8px;">Waste subtotal</td><td style="padding:4px 8px;text-align:right;">${fmtMoney(totals.wasteSubtotal)}</td></tr>
      <tr><td style="padding:4px 8px;">Overhead &amp; profit</td><td style="padding:4px 8px;text-align:right;">${fmtMoney(totals.overheadAndProfit)}</td></tr>
      <tr style="background:#222;color:#fff;"><td style="padding:8px;font-weight:700;">Grand total</td><td style="padding:8px;text-align:right;font-weight:700;">${fmtMoney(totals.grandTotal)}</td></tr>
    </table>
  </section>
  <footer style="margin-top:32px;font-size:10px;color:#888;border-top:1px solid #ccc;padding-top:8px;">
    Generated by sitelayer-capture/catalog. Prices snapshotted ${escapeHtml(priced.pricedAt)} from public catalog data; refresh quarterly.
  </footer>
</body>
</html>`
}
