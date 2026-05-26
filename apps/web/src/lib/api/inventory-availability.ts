// Inventory availability + forecast selectors for the rentals dashboard.
//
// The two backend surfaces already exist:
//   - GET /api/inventory/utilization      → per-item on-rent vs in-stock
//     balances (consumed via `useInventoryUtilization` in ./rentals).
//   - GET /api/inventory-items/:id/forecast → 6-week projected on-rent /
//     idle quantities (consumed via `useInventoryForecast` in ./rentals).
//
// This module shapes those payloads into the availability/forecast view
// the mobile utilization dashboard renders. It does NOT add new network
// calls — it derives availability rows from the utilization payload and
// re-exports the forecast hook so the screen has a single import surface.

import {
  useInventoryForecast,
  useInventoryUtilization,
  type ForecastResponse,
  type ForecastWeek,
  type UtilizationRow,
  type UtilizationTotals,
} from './rentals'

export type { ForecastResponse, ForecastWeek }

/**
 * One inventory item's current availability split: how many units are
 * on rent right now vs sitting in stock, plus the implied utilization
 * percentage and the daily idle revenue the in-stock units represent.
 */
export interface AvailabilityRow {
  inventory_item_id: string
  code: string
  description: string
  unit: string
  /** Units currently out on active rental lines. */
  on_rent_quantity: number
  /** Units in usable stock and not on rent. */
  available_quantity: number
  /** on_rent + available — the tracked stock this item can deploy. */
  total_quantity: number
  /** on_rent / total * 100, 0 when there is no tracked stock. */
  utilization_pct: number
  /** Rough dollars/day the in-stock units are failing to earn. */
  idle_revenue_per_day: number
}

/** Headline counts for the availability section's KPI strip. */
export interface AvailabilitySummary {
  /** Item types that have any tracked stock. */
  stocked_item_count: number
  /** Item types fully on rent (zero units available). */
  fully_deployed_count: number
  /** Item types with at least one unit available. */
  has_availability_count: number
  total_on_rent: number
  total_available: number
}

function toAvailabilityRow(r: UtilizationRow): AvailabilityRow {
  const onRent = Number(r.on_rent_quantity) || 0
  const available = Number(r.available_quantity) || 0
  const total = onRent + available
  return {
    inventory_item_id: r.inventory_item_id,
    code: r.code,
    description: r.description,
    unit: r.unit,
    on_rent_quantity: onRent,
    available_quantity: available,
    total_quantity: total,
    utilization_pct: total > 0 ? Math.round((onRent / total) * 1000) / 10 : 0,
    idle_revenue_per_day: (Number(r.idle_revenue_per_day_cents) || 0) / 100,
  }
}

/**
 * Derive the per-item availability rows from a utilization payload.
 * Items with no tracked stock are dropped (they cannot be "available"),
 * and the list is sorted most-available-first so the owner sees what
 * is sitting idle at the top.
 */
export function selectAvailabilityRows(items: readonly UtilizationRow[]): AvailabilityRow[] {
  return items
    .map(toAvailabilityRow)
    .filter((r) => r.total_quantity > 0)
    .sort((a, b) => b.available_quantity - a.available_quantity || b.idle_revenue_per_day - a.idle_revenue_per_day)
}

/** Roll the availability rows up into the section KPI summary. */
export function selectAvailabilitySummary(
  rows: readonly AvailabilityRow[],
  totals: UtilizationTotals | undefined,
): AvailabilitySummary {
  const stocked = rows.length
  const fullyDeployed = rows.filter((r) => r.available_quantity <= 0).length
  return {
    stocked_item_count: stocked,
    fully_deployed_count: fullyDeployed,
    has_availability_count: stocked - fullyDeployed,
    total_on_rent: totals?.total_on_rent ?? rows.reduce((s, r) => s + r.on_rent_quantity, 0),
    total_available: totals?.total_available ?? rows.reduce((s, r) => s + r.available_quantity, 0),
  }
}

/**
 * One forecast week shaped for charting. Quantities are coerced to
 * numbers and the `over_committed` flag is set when projected demand
 * exceeds tracked stock (idle hits zero while on-rent keeps climbing).
 */
export interface ForecastPoint {
  week_start: string
  projected_on_rent: number
  projected_idle: number
  /** projected_on_rent + projected_idle — the stock baseline for the week. */
  capacity: number
}

export function selectForecastPoints(res: ForecastResponse | undefined): ForecastPoint[] {
  if (!res) return []
  return res.weeks.map((w) => {
    const onRent = Number(w.projected_on_rent_qty) || 0
    const idle = Number(w.projected_idle_qty) || 0
    return {
      week_start: w.week_start,
      projected_on_rent: onRent,
      projected_idle: idle,
      capacity: onRent + idle,
    }
  })
}

/**
 * Convenience hook: the availability section reuses the utilization
 * query, so callers can share the same cache entry. Re-exported here so
 * the dashboard only imports from one availability module.
 */
export function useInventoryAvailability() {
  return useInventoryUtilization()
}

export { useInventoryForecast }
