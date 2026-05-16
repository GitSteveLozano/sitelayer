import { useMemo } from 'react'
import { applyMarkup, type MarkupBreakdown, type SubtotalsByKind } from '@sitelayer/domain'
import { useAssemblyByServiceItem } from '@/lib/api/assemblies'

/**
 * Transparent markup breakdown — closes the PlanSwift gap.
 *
 * Renders the per-line math for an estimate line so estimators can see
 *
 *   "Labor $1,200 × 1.15 burden = $1,380;
 *    Materials $2,500 × 1.10 waste = $2,750;
 *    Subtotal $4,130 × 1.25 profit = $5,162.50"
 *
 * instead of a flat dollar total. Two render paths:
 *
 *   1. When the line is driven by a service-item assembly (the
 *      PlanSwift recipe model), we feed each component's amount into
 *      the matching kind bucket and call `applyMarkup` on the bucket
 *      sums. Estimators see the labor / material / sub / freight
 *      breakdown.
 *
 *   2. When no assembly exists for the line, we synthesise a
 *      labor-only subtotal from the line's qty × rate and still run
 *      `applyMarkup` so the burden + profit math is visible. The first
 *      breakdown row is labelled "Labor (no assembly)" so estimators
 *      know the line could be enriched.
 *
 * The component is fully collapsed by default (rendered inside
 * `<details>`). We don't want to add visual noise to every line — the
 * breakdown is on-demand. Use it inline in the line-row drill-down.
 */

export interface EstimateMarkupBreakdownProps {
  serviceItemCode: string
  /** Final per-line subtotal the user sees in the line row (qty × rate). */
  lineAmount: number
  /** Pricing-profile `config` jsonb. Pass through unchanged from the API. */
  pricingProfileConfig: unknown
  /** Optional label for the no-assembly fallback row. */
  noAssemblyLaborLabel?: string
}

export function EstimateMarkupBreakdown({
  serviceItemCode,
  lineAmount,
  pricingProfileConfig,
  noAssemblyLaborLabel,
}: EstimateMarkupBreakdownProps) {
  const assembly = useAssemblyByServiceItem(serviceItemCode)

  const { subtotals, source } = useMemo<{
    subtotals: SubtotalsByKind
    source: 'assembly' | 'flat-labor'
  }>(() => {
    if (assembly.data && assembly.data.components.length > 0) {
      const byKind: SubtotalsByKind = { material: 0, labor: 0, sub: 0, freight: 0 }
      for (const c of assembly.data.components) {
        const qty = Number(c.quantity_per_unit)
        const cost = Number(c.unit_cost)
        const waste = Number(c.waste_pct)
        if (!Number.isFinite(qty) || !Number.isFinite(cost)) continue
        const wasteFactor = Number.isFinite(waste) ? 1 + waste / 100 : 1
        const contribution = qty * wasteFactor * cost
        byKind[c.kind] = (byKind[c.kind] ?? 0) + contribution
      }
      return { subtotals: byKind, source: 'assembly' }
    }
    // No assembly — treat the whole line as labor so the burden +
    // profit math is still visible. This is the "flat per-line rate"
    // case the panel exists to make transparent.
    return {
      subtotals: { labor: Number.isFinite(lineAmount) ? lineAmount : 0 },
      source: 'flat-labor',
    }
  }, [assembly.data, lineAmount])

  const breakdown = useMemo<MarkupBreakdown>(
    () => applyMarkup(subtotals, pricingProfileConfig),
    [subtotals, pricingProfileConfig],
  )

  if (assembly.isPending) {
    return <div className="text-[11px] text-ink-3 py-2">Loading markup breakdown…</div>
  }

  if (breakdown.lines.length === 0) {
    return (
      <div className="text-[11px] text-ink-3 py-2">
        No markup applied — pricing profile has zero burden/margin and the line has no cost.
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Markup breakdown</div>
      <ul className="divide-y divide-line">
        {breakdown.lines.map((row, index) => (
          <li
            key={`${row.basis}-${index}`}
            className="py-1.5 flex items-baseline gap-2 text-[12px]"
            data-testid={`markup-row-${row.basis}`}
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">
                {row.basis === 'labor' && source === 'flat-labor'
                  ? (noAssemblyLaborLabel ?? row.label.replace('Labor', 'Labor (no assembly)'))
                  : row.label}
              </div>
              <div className="text-[10.5px] text-ink-3 num">
                ${row.before.toLocaleString(undefined, { maximumFractionDigits: 2 })} × {row.multiplier.toFixed(2)}
              </div>
            </div>
            <div className="num text-[12px] font-semibold shrink-0">
              ${row.after.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-baseline justify-between pt-1.5 border-t border-dashed border-line">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">Final line total</div>
        <div className="num text-[13px] font-semibold">
          ${breakdown.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
      </div>
      {source === 'flat-labor' ? (
        <div className="text-[10.5px] text-ink-3 pt-1">
          No assembly defined for {serviceItemCode} — burden and margin shown against the flat line rate. Configure an
          assembly in Settings → Pricebook to break this down by material / labor / sub.
        </div>
      ) : null}
    </div>
  )
}
