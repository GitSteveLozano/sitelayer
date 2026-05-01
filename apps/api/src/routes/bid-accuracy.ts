import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'

export type BidAccuracyRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  sendJson: (status: number, body: unknown) => void
}

interface AccuracyRow {
  project_id: string
  project_name: string
  customer_name: string | null
  status: string
  bid_total: string
  actual_material_cents: number
  actual_labor_cents: number
  actual_total_cents: number
  delta_cents: number
  delta_pct: number
  // Ordinal confidence per the AI Layer rule — never a numeric pct.
  // Mapping: |delta_pct| < 5 → high (we trust the bid was close);
  // 5 <= |delta_pct| < 15 → med; >= 15 → low (bid significantly off).
  confidence: 'low' | 'med' | 'high'
}

/**
 * GET /api/ai/bid-accuracy
 *
 * Cohort accuracy view: per-project bid_total vs realized actuals
 * (material_bills.amount + labor_entries.hours × standard rate). The
 * delta tells the owner where the bidding model is over- or
 * under-predicting; the confidence pill is a function of the delta
 * magnitude (ordinal, not a numeric pct, per the design rule).
 *
 * No LLM in this path — this is pure cohort statistics. The
 * takeoff-to-bid agent (which is LLM-driven) is a different endpoint.
 */
export async function handleBidAccuracyRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: BidAccuracyRouteCtx,
): Promise<boolean> {
  if (req.method !== 'GET') return false
  if (url.pathname !== '/api/ai/bid-accuracy') return false
  if (!ctx.requireRole(['admin', 'office'])) return true

  const result = await ctx.pool.query<{
    project_id: string
    project_name: string
    customer_name: string | null
    status: string
    bid_total: string
    actual_material_cents: string
    actual_labor_cents: string
  }>(
    `
    select
      p.id as project_id,
      p.name as project_name,
      p.customer_name,
      p.status,
      p.bid_total,
      coalesce((
        select sum(amount * 100)::bigint
        from material_bills mb
        where mb.company_id = p.company_id
          and mb.project_id = p.id
          and mb.deleted_at is null
      ), 0)::text as actual_material_cents,
      coalesce((
        select sum(le.hours * coalesce(p.labor_rate, 0) * 100)::bigint
        from labor_entries le
        where le.company_id = p.company_id
          and le.project_id = p.id
          and le.deleted_at is null
      ), 0)::text as actual_labor_cents
    from projects p
    where p.company_id = $1
      and p.deleted_at is null
      and p.bid_total > 0
    order by p.created_at desc
    limit 100
    `,
    [ctx.company.id],
  )

  const rows: AccuracyRow[] = result.rows.map((r) => {
    const material = Number(r.actual_material_cents) || 0
    const labor = Number(r.actual_labor_cents) || 0
    const total = material + labor
    const bidCents = Math.round(Number(r.bid_total) * 100)
    const delta = total - bidCents
    const deltaPct = bidCents > 0 ? (delta / bidCents) * 100 : 0
    const absPct = Math.abs(deltaPct)
    const confidence: 'low' | 'med' | 'high' = absPct < 5 ? 'high' : absPct < 15 ? 'med' : 'low'
    return {
      project_id: r.project_id,
      project_name: r.project_name,
      customer_name: r.customer_name,
      status: r.status,
      bid_total: r.bid_total,
      actual_material_cents: material,
      actual_labor_cents: labor,
      actual_total_cents: total,
      delta_cents: delta,
      delta_pct: Number(deltaPct.toFixed(1)),
      confidence,
    }
  })

  // Cohort summary — owner home pulls these headline numbers.
  const closed = rows.filter((r) => r.status === 'completed' || r.status === 'closed')
  const closedDeltas = closed.map((r) => r.delta_pct)
  const meanClosedPct = closedDeltas.length > 0 ? closedDeltas.reduce((a, b) => a + b, 0) / closedDeltas.length : 0

  const overUnder = rows.reduce(
    (acc, r) => {
      if (r.delta_cents > 0) acc.over_count += 1
      else if (r.delta_cents < 0) acc.under_count += 1
      else acc.exact_count += 1
      return acc
    },
    { over_count: 0, under_count: 0, exact_count: 0 },
  )

  ctx.sendJson(200, {
    projects: rows,
    summary: {
      project_count: rows.length,
      closed_project_count: closed.length,
      mean_closed_delta_pct: Number(meanClosedPct.toFixed(1)),
      ...overUnder,
      attribution: 'Computed from projects.bid_total vs material_bills + labor_entries × labor_rate',
    },
  })
  return true
}
