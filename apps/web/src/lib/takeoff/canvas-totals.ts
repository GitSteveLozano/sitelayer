// Shared takeoff scope-total + quantity-formatting helpers.
//
// The desktop (`screens/desktop/est-canvas.tsx`) and mobile
// (`screens/mobile/takeoff-mobile.tsx`) takeoff canvases both roll committed
// measurements up into per-service-item scope totals and format quantities for
// the readout. The desktop version is the source of truth here because it
// carries the cutout/deduct sign logic that matches the server's signed
// estimate-line derivation. Pure.
//
// NOTE: as of the Blocker-1 extraction, the mobile copy of `buildScopeTotals`
// had DRIFTED — it summed `quantity` without the `is_deduction` sign — so the
// mobile screen keeps its own local copy and is NOT repointed here. Only the
// identical helpers (`formatQty`) are shared with mobile. See the PR for the
// drift note.

import type { TakeoffMeasurement } from '@/lib/api'
import { round2 } from './canvas-math'

export interface ScopeTotal {
  code: string
  quantity: number
  unit: string
  count: number
  mixedUnits: boolean
}

/**
 * Roll committed measurements up into per-service-item scope totals. Cutout /
 * deduct measurements subtract their area from the net for the item, matching
 * the signed estimate-line derivation on the server. Sorted by descending
 * quantity. Pure.
 */
export function buildScopeTotals(measurements: TakeoffMeasurement[]): ScopeTotal[] {
  const buckets = new Map<string, { quantity: number; units: Set<string>; count: number }>()
  for (const m of measurements) {
    const bucket = buckets.get(m.service_item_code) ?? { quantity: 0, units: new Set<string>(), count: 0 }
    // Cutout/deduct measurements subtract their area from the net for the item,
    // matching the signed estimate-line derivation on the server.
    const sign = m.is_deduction ? -1 : 1
    bucket.quantity += (Number(m.quantity) || 0) * sign
    bucket.units.add(m.unit)
    bucket.count += 1
    buckets.set(m.service_item_code, bucket)
  }
  return Array.from(buckets.entries())
    .map(([code, b]) => ({
      code,
      quantity: round2(b.quantity),
      unit: b.units.size === 1 ? (Array.from(b.units)[0] ?? '') : 'mixed',
      count: b.count,
      mixedUnits: b.units.size > 1,
    }))
    .sort((a, b) => b.quantity - a.quantity)
}

/** Format a board quantity for display (thousands grouping, ≤1 fraction digit). */
export function formatQty(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (Number.isInteger(n)) return String(n)
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}
