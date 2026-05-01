import type http from 'node:http'
import type { Pool } from 'pg'
import {
  calculateWorkerBurden,
  splitStraightAndOt,
  summarizeLaborBurden,
  type LaborBurdenSummary,
  type LaborBurdenWorkerResult,
} from '@sitelayer/domain'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { isValidDateInput, isValidUuid } from '../http-utils.js'

export type LaborBurdenRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  sendJson: (status: number, body: unknown) => void
}

interface BurdenResponse extends LaborBurdenSummary {
  /** Sum of `daily_budget_cents` across the projects under consideration. */
  total_budget_cents: number
  /** Total burden as a fraction of total_budget_cents (0 when budget=0). */
  burden_pct_of_budget: number
}

/**
 * GET /api/labor-burden/today?project_id=<uuid>
 *
 * Computes today's labor burden by summing each worker's clock spans
 * (in/out pairs from clock_events for today, voided rows excluded),
 * splitting into straight + OT against the 8h threshold, and applying
 * the per-worker burden multipliers. Joins `daily_budget_cents` from
 * the affected projects so the UI can render the "% under plan" pill.
 *
 * Defaults:
 *   - date  = today (server timezone)
 *   - scope = company-wide (project_id optional)
 *
 * Permissions: foreman / admin / office. Workers don't see this surface
 * (no design for a worker-facing burden card).
 */
export async function handleLaborBurdenRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: LaborBurdenRouteCtx,
): Promise<boolean> {
  if (req.method !== 'GET') return false
  if (url.pathname !== '/api/labor-burden/today') return false
  if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true

  const dateParam = String(url.searchParams.get('date') ?? '').trim()
  const projectIdParam = String(url.searchParams.get('project_id') ?? '').trim()
  if (dateParam && !isValidDateInput(dateParam)) {
    ctx.sendJson(400, { error: 'date must be YYYY-MM-DD' })
    return true
  }
  if (projectIdParam && !isValidUuid(projectIdParam)) {
    ctx.sendJson(400, { error: 'project_id must be a valid uuid' })
    return true
  }
  const targetDate = dateParam || new Date().toISOString().slice(0, 10)

  // Pull today's clock events with the worker's burden columns joined
  // in. Voided rows excluded. Ordered chronologically so the pair-up
  // works deterministically.
  const events = await ctx.pool.query<{
    worker_id: string | null
    project_id: string | null
    event_type: string
    occurred_at: string
    base_hourly_cents: number
    insurance_pct: string
    benefits_pct: string
    ot_premium_pct: string
  }>(
    `select e.worker_id, e.project_id, e.event_type, e.occurred_at,
            w.base_hourly_cents, w.insurance_pct, w.benefits_pct, w.ot_premium_pct
     from clock_events e
     left join workers w on w.id = e.worker_id and w.company_id = e.company_id
     where e.company_id = $1
       and e.voided_at is null
       and e.worker_id is not null
       and ($3 = '' or e.project_id = $3::uuid)
       and e.occurred_at >= ($2::date)
       and e.occurred_at < ($2::date + interval '1 day')
     order by e.worker_id, e.occurred_at asc`,
    [ctx.company.id, targetDate, projectIdParam],
  )

  // Pair events into spans per worker, then split straight + ot.
  type WorkerEvent = (typeof events.rows)[number]
  const byWorker = new Map<string, WorkerEvent[]>()
  for (const row of events.rows) {
    if (!row.worker_id) continue
    const list = byWorker.get(row.worker_id) ?? []
    list.push(row)
    byWorker.set(row.worker_id, list)
  }

  const nowMs = Date.now()
  // Cap open spans at end-of-day for historical dates so a never-closed
  // clock-in from a past day doesn't accrue against today's clock. For
  // today, we cap at now() so a currently-clocked-in worker sees their
  // span tick up live.
  const dayEndMs = Date.parse(`${targetDate}T23:59:59.999Z`)
  const openCloseMs = nowMs < dayEndMs ? nowMs : dayEndMs
  const results: LaborBurdenWorkerResult[] = []
  for (const [workerId, rows] of byWorker) {
    let totalHours = 0
    let openInMs: number | null = null
    for (const e of rows) {
      const ms = Date.parse(e.occurred_at)
      if (e.event_type === 'in') {
        if (openInMs !== null) {
          // Implicit close on a new in.
          totalHours += Math.max(0, (ms - openInMs) / (1000 * 60 * 60))
        }
        openInMs = ms
      } else {
        if (openInMs !== null) {
          totalHours += Math.max(0, (ms - openInMs) / (1000 * 60 * 60))
          openInMs = null
        }
      }
    }
    // Open span — count up to now (today) or end-of-day (past dates).
    if (openInMs !== null) {
      totalHours += Math.max(0, (openCloseMs - openInMs) / (1000 * 60 * 60))
    }
    const split = splitStraightAndOt(totalHours)
    const first = rows[0]
    if (!first) continue
    results.push(
      calculateWorkerBurden({
        worker_id: workerId,
        straight_hours: split.straight_hours,
        ot_hours: split.ot_hours,
        base_hourly_cents: Number(first.base_hourly_cents) || 0,
        insurance_pct: Number(first.insurance_pct) || 0,
        benefits_pct: Number(first.benefits_pct) || 0,
        ot_premium_pct: Number(first.ot_premium_pct) || 0,
      }),
    )
  }

  const summary = summarizeLaborBurden(results)

  // Sum daily_budget_cents across projects involved in today's events
  // (or the single explicit project filter).
  let totalBudgetCents = 0
  if (projectIdParam) {
    const single = await ctx.pool.query<{ daily_budget_cents: number }>(
      `select daily_budget_cents from projects where company_id = $1 and id = $2`,
      [ctx.company.id, projectIdParam],
    )
    totalBudgetCents = Number(single.rows[0]?.daily_budget_cents ?? 0) || 0
  } else {
    const projectIds = Array.from(
      new Set(events.rows.map((r) => r.project_id).filter((id): id is string => Boolean(id))),
    )
    if (projectIds.length > 0) {
      const budgets = await ctx.pool.query<{ daily_budget_cents: number }>(
        `select daily_budget_cents from projects where company_id = $1 and id = any($2::uuid[])`,
        [ctx.company.id, projectIds],
      )
      totalBudgetCents = budgets.rows.reduce((sum, r) => sum + (Number(r.daily_budget_cents) || 0), 0)
    }
  }

  const body: BurdenResponse = {
    ...summary,
    total_budget_cents: totalBudgetCents,
    burden_pct_of_budget: totalBudgetCents > 0 ? summary.total_cents / totalBudgetCents : 0,
  }
  ctx.sendJson(200, body)
  return true
}
