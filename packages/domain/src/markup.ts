/**
 * Transparent markup math — the PlanSwift gap.
 *
 * Estimators want to see exactly how the bill of materials becomes the
 * final per-line price: "Labor $1,200 × 1.15 burden = $1,380; Materials
 * $2,500 × 1.10 waste = $2,750; …". Today the estimate-builder hides
 * that logic behind a flat per-line rate. This helper produces the
 * per-row breakdown the UI panels render.
 *
 * The math is pure on plain data — no DB, no I/O. Routes hydrate the
 * `subtotalsByKind` from `resolveAssembly` (when an assembly drives a
 * line) or from raw labor/material cost inputs (when an estimator types
 * in a line by hand), look up the pricing profile from
 * `pricing_profiles`, and call this.
 *
 * --------------------------------------------------------------------
 * Pricing profile config shape (extends the existing `config` jsonb on
 * `pricing_profiles`; older keys like `template` and `divisions` are
 * preserved untouched — this layer just consumes the markup fields):
 *
 *   {
 *     // …existing keys (e.g. `template: 'la-operations'`, division
 *     //  rate tables) survive untouched.
 *
 *     // Waste % applied to material subtotals before profit.
 *     // (10 means "+10%".)
 *     material_waste_pct?: number
 *
 *     // Labor burden % covering insurance, benefits, payroll taxes —
 *     // applied to the raw labor subtotal before profit.
 *     labor_burden_pct?: number
 *
 *     // Markup on subcontractor pass-through cost.
 *     sub_markup_pct?: number
 *
 *     // Markup on freight pass-through cost.
 *     freight_markup_pct?: number
 *
 *     // Profit margin applied to the post-burden, post-waste subtotal.
 *     // This is a TARGET MARGIN expressed as a percentage of revenue
 *     // (so 20 means "revenue must be 25% above cost to leave a 20%
 *     // margin"), to match how shop owners talk about it. See
 *     // applyProfitMargin below for the formula.
 *     profit_margin_pct?: number
 *   }
 * --------------------------------------------------------------------
 *
 * Defaults match construction industry rules of thumb so a brand-new
 * pricing profile with an empty `config` already produces sensible
 * (and transparent) numbers.
 */

import type { AssemblyKind } from './assembly.js'

export interface MarkupProfileConfig {
  /** Waste % on materials, e.g. 10 = +10%. */
  material_waste_pct?: number
  /** Labor burden %, e.g. 15 = +15%. */
  labor_burden_pct?: number
  /** Subcontractor markup %, e.g. 8 = +8%. */
  sub_markup_pct?: number
  /** Freight markup %, e.g. 5 = +5%. */
  freight_markup_pct?: number
  /** Target profit margin as a % of revenue, e.g. 20 = 20% gross margin. */
  profit_margin_pct?: number
}

/**
 * Industry-default markups. Any of these can be overridden via the
 * pricing profile's `config` jsonb. Values picked to match common
 * residential / light-commercial shop heuristics; an empty config still
 * produces transparent, defensible numbers.
 */
export const DEFAULT_MARKUP_CONFIG: Required<MarkupProfileConfig> = {
  material_waste_pct: 10,
  labor_burden_pct: 15,
  sub_markup_pct: 8,
  freight_markup_pct: 5,
  profit_margin_pct: 0,
}

/** Subtotals fed into the markup pipeline, grouped by assembly kind. */
export type SubtotalsByKind = Partial<Record<AssemblyKind, number>>

/**
 * A single row in the breakdown panel — what the UI renders.
 *
 *   label       e.g. "Labor (burden 15%)"
 *   basis       canonical key (material / labor / sub / freight / profit)
 *   multiplier  e.g. 1.15 — the multiplier that takes `before` -> `after`
 *   before      input dollars at this step
 *   after       output dollars at this step
 *
 * Rows are emitted in pipeline order: material, labor, sub, freight,
 * then a single `profit` row if profit_margin_pct > 0. Zero-input kinds
 * are skipped so the panel doesn't pad with $0 rows the estimator
 * doesn't care about.
 */
export interface MarkupBreakdownRow {
  label: string
  basis: 'material' | 'labor' | 'sub' | 'freight' | 'profit'
  multiplier: number
  before: number
  after: number
}

export interface MarkupBreakdown {
  /** Effective config used — defaults merged with the profile's config. */
  config: Required<MarkupProfileConfig>
  /** One row per non-zero kind, plus an optional profit row. */
  lines: MarkupBreakdownRow[]
  /** Subtotal across the kinds before profit is layered on top. */
  subtotal_before_profit: number
  /** Final dollar total after profit. */
  total: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

/**
 * Validate and normalise a raw config jsonb. Anything that isn't a
 * finite number falls back to the default for that key. Unknown keys on
 * the source object are ignored — this is the EXTEND-not-REPLACE
 * contract: the caller can keep template/divisions/etc. on the profile
 * and we only read the markup fields.
 */
export function normalizeMarkupConfig(
  rawConfig: unknown,
  defaults: Required<MarkupProfileConfig> = DEFAULT_MARKUP_CONFIG,
): Required<MarkupProfileConfig> {
  const config: Required<MarkupProfileConfig> = { ...defaults }
  if (rawConfig === null || typeof rawConfig !== 'object') return config
  const src = rawConfig as Record<string, unknown>
  for (const key of [
    'material_waste_pct',
    'labor_burden_pct',
    'sub_markup_pct',
    'freight_markup_pct',
    'profit_margin_pct',
  ] as const) {
    const raw = src[key]
    if (raw === undefined || raw === null) continue
    const n = Number(raw)
    if (!Number.isFinite(n)) continue
    // Reject obviously-broken values (negative, or larger than 1000%
    // which is a typo-rather-than-intent indicator).
    if (n < 0 || n > 1000) continue
    config[key] = n
  }
  return config
}

/**
 * Apply pricing-profile markups to a per-kind subtotal map and return
 * the breakdown rows + total.
 *
 *   subtotalsByKind = { material: 2500, labor: 1200 }
 *
 * Each kind's subtotal is multiplied by `(1 + pct/100)` and emitted as
 * one row. Then a profit row (if `profit_margin_pct > 0`) takes the
 * sum of those `after` columns and lifts it by the profit-from-revenue
 * formula:
 *
 *   target_revenue = subtotal_before_profit / (1 - margin)
 *
 * so the resulting line shows "X × 1.25 = Y" when margin=20% (since
 * 1/(1-0.20) = 1.25). That's how shop owners actually communicate
 * margin — see DEFAULT_BONUS_RULE in `index.ts` which uses the same
 * "margin as % of revenue" convention.
 *
 * Anything that comes in as NaN/non-finite is treated as zero. Kinds
 * with zero subtotal are omitted from the rows so the panel stays
 * focused.
 */
export function applyMarkup(subtotalsByKind: SubtotalsByKind, profileConfig: unknown): MarkupBreakdown {
  const config = normalizeMarkupConfig(profileConfig)

  const rows: MarkupBreakdownRow[] = []
  const kindOrder: Array<{
    kind: AssemblyKind
    label: string
    pct: number
    basis: MarkupBreakdownRow['basis']
  }> = [
    { kind: 'material', label: 'Materials', pct: config.material_waste_pct, basis: 'material' },
    { kind: 'labor', label: 'Labor', pct: config.labor_burden_pct, basis: 'labor' },
    { kind: 'sub', label: 'Subcontractors', pct: config.sub_markup_pct, basis: 'sub' },
    { kind: 'freight', label: 'Freight', pct: config.freight_markup_pct, basis: 'freight' },
  ]

  let runningTotal = 0
  for (const { kind, label, pct, basis } of kindOrder) {
    const raw = Number(subtotalsByKind[kind] ?? 0)
    if (!Number.isFinite(raw) || raw === 0) continue
    const multiplier = round4(1 + pct / 100)
    const before = round2(raw)
    const after = round2(raw * multiplier)
    const detailLabel = labelFor(label, kind, pct)
    rows.push({ label: detailLabel, basis, multiplier, before, after })
    runningTotal = round2(runningTotal + after)
  }

  const subtotalBeforeProfit = runningTotal
  let total = subtotalBeforeProfit

  if (config.profit_margin_pct > 0 && subtotalBeforeProfit > 0) {
    // margin = profit / revenue; revenue = cost / (1 - margin).
    // Cap at 99% to keep the math finite — anyone setting 100% margin
    // is misconfigured anyway.
    const marginFraction = Math.min(config.profit_margin_pct, 99) / 100
    const multiplier = round4(1 / (1 - marginFraction))
    const before = subtotalBeforeProfit
    const after = round2(subtotalBeforeProfit * multiplier)
    rows.push({
      label: `Profit margin (${config.profit_margin_pct}% of revenue)`,
      basis: 'profit',
      multiplier,
      before,
      after,
    })
    total = after
  }

  return {
    config,
    lines: rows,
    subtotal_before_profit: round2(subtotalBeforeProfit),
    total: round2(total),
  }
}

function labelFor(base: string, kind: AssemblyKind, pct: number): string {
  if (pct === 0) return `${base} (pass-through)`
  if (kind === 'material') return `Materials (+${pct}% waste)`
  if (kind === 'labor') return `Labor (+${pct}% burden)`
  return `${base} (+${pct}% markup)`
}
