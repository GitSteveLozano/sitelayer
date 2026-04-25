/**
 * Labor reporting splits.
 *
 * Three GET endpoints:
 *   - /api/analytics/labor/by-item    — sum hours + cost grouped by service item
 *   - /api/analytics/labor/by-worker  — sum hours + cost grouped by worker
 *   - /api/analytics/labor/by-week    — sum hours + cost grouped by ISO week
 *
 * Cost math: labor_entries don't carry a per-entry rate. Cost is computed as
 * `hours * projects.labor_rate` joined per row. This matches `summarizeProject`
 * (server.ts) which is the existing source of truth for project cost.
 *
 * Each helper returns a SQL + values pair so server.ts can call pool.query()
 * directly. The unit test exercises the in-memory aggregation math on a seeded
 * row-set so we don't have to stand up Postgres just to prove the grouping.
 */

import type { QueryResult, QueryResultRow } from 'pg'

export type LaborReportFilters = {
  start: string | null
  end: string | null
}

export type LaborQueryClient = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>
}

/**
 * Minimal subset of `URLSearchParams` we read in handlers — pulled out so
 * tests can pass a literal Map.
 */
export type LaborReportParams = {
  get(key: string): string | null
}

export function parseLaborReportFilters(params: LaborReportParams): LaborReportFilters {
  const start = (params.get('start') ?? '').trim()
  const end = (params.get('end') ?? '').trim()
  return { start: start ? start : null, end: end ? end : null }
}

function buildWhere(values: unknown[], companyId: string, filters: LaborReportFilters): string {
  values.push(companyId)
  const clauses: string[] = [`le.company_id = $${values.length}`, `le.deleted_at is null`]
  if (filters.start) {
    values.push(filters.start)
    clauses.push(`le.occurred_on >= $${values.length}::date`)
  }
  if (filters.end) {
    values.push(filters.end)
    clauses.push(`le.occurred_on < $${values.length}::date`)
  }
  return clauses.join(' and ')
}

export type LaborByItemRow = {
  service_item_code: string
  service_item_name: string | null
  hours: number
  cost: number
}

export async function listLaborByItem(
  client: LaborQueryClient,
  companyId: string,
  filters: LaborReportFilters,
): Promise<LaborByItemRow[]> {
  const values: unknown[] = []
  const where = buildWhere(values, companyId, filters)
  const sql = `
    select
      le.service_item_code,
      coalesce(si.name, le.service_item_code) as service_item_name,
      sum(le.hours)::float8 as hours,
      sum(le.hours * coalesce(p.labor_rate, 0))::float8 as cost
    from labor_entries le
    join projects p
      on p.id = le.project_id and p.company_id = le.company_id
    left join service_items si
      on si.code = le.service_item_code and si.company_id = le.company_id
    where ${where}
    group by le.service_item_code, si.name
    order by hours desc
  `
  const result = await client.query<LaborByItemRow>(sql, values)
  return result.rows.map((row) => ({
    service_item_code: row.service_item_code,
    service_item_name: row.service_item_name ?? row.service_item_code,
    hours: Number(row.hours ?? 0),
    cost: Number(row.cost ?? 0),
  }))
}

export type LaborByWorkerRow = {
  worker_id: string | null
  worker_name: string
  hours: number
  cost: number
}

export async function listLaborByWorker(
  client: LaborQueryClient,
  companyId: string,
  filters: LaborReportFilters,
): Promise<LaborByWorkerRow[]> {
  const values: unknown[] = []
  const where = buildWhere(values, companyId, filters)
  const sql = `
    select
      le.worker_id,
      coalesce(w.name, '(unassigned)') as worker_name,
      sum(le.hours)::float8 as hours,
      sum(le.hours * coalesce(p.labor_rate, 0))::float8 as cost
    from labor_entries le
    join projects p
      on p.id = le.project_id and p.company_id = le.company_id
    left join workers w
      on w.id = le.worker_id and w.company_id = le.company_id
    where ${where}
    group by le.worker_id, w.name
    order by hours desc
  `
  const result = await client.query<LaborByWorkerRow>(sql, values)
  return result.rows.map((row) => ({
    worker_id: row.worker_id ?? null,
    worker_name: row.worker_name ?? '(unassigned)',
    hours: Number(row.hours ?? 0),
    cost: Number(row.cost ?? 0),
  }))
}

export type LaborByWeekRow = {
  week_start: string
  hours: number
  cost: number
}

export async function listLaborByWeek(
  client: LaborQueryClient,
  companyId: string,
  filters: LaborReportFilters,
): Promise<LaborByWeekRow[]> {
  const values: unknown[] = []
  const where = buildWhere(values, companyId, filters)
  const sql = `
    select
      date_trunc('week', le.occurred_on)::date as week_start,
      sum(le.hours)::float8 as hours,
      sum(le.hours * coalesce(p.labor_rate, 0))::float8 as cost
    from labor_entries le
    join projects p
      on p.id = le.project_id and p.company_id = le.company_id
    where ${where}
    group by date_trunc('week', le.occurred_on)
    order by week_start asc
  `
  const result = await client.query<{ week_start: string | Date; hours: number | string; cost: number | string }>(
    sql,
    values,
  )
  return result.rows.map((row) => ({
    week_start: row.week_start instanceof Date ? row.week_start.toISOString().slice(0, 10) : String(row.week_start),
    hours: Number(row.hours ?? 0),
    cost: Number(row.cost ?? 0),
  }))
}

/**
 * Pure-JS aggregation that mirrors the SQL grouping. Used by the unit test
 * to prove the math without a live Postgres, by feeding a stub query client
 * that runs this function and returns a Postgres-shaped `QueryResult`.
 */
export type SeedLaborEntry = {
  service_item_code: string
  service_item_name?: string | null
  worker_id: string | null
  worker_name: string
  hours: number
  occurred_on: string // YYYY-MM-DD
  labor_rate: number
}

export function aggregateLaborByItem(entries: SeedLaborEntry[]): LaborByItemRow[] {
  const acc = new Map<string, LaborByItemRow>()
  for (const e of entries) {
    const key = e.service_item_code
    const cur = acc.get(key) ?? {
      service_item_code: e.service_item_code,
      service_item_name: e.service_item_name ?? e.service_item_code,
      hours: 0,
      cost: 0,
    }
    cur.hours += e.hours
    cur.cost += e.hours * e.labor_rate
    acc.set(key, cur)
  }
  return [...acc.values()].sort((a, b) => b.hours - a.hours)
}

export function aggregateLaborByWorker(entries: SeedLaborEntry[]): LaborByWorkerRow[] {
  const acc = new Map<string, LaborByWorkerRow>()
  for (const e of entries) {
    const key = e.worker_id ?? `name:${e.worker_name}`
    const cur = acc.get(key) ?? {
      worker_id: e.worker_id,
      worker_name: e.worker_name,
      hours: 0,
      cost: 0,
    }
    cur.hours += e.hours
    cur.cost += e.hours * e.labor_rate
    acc.set(key, cur)
  }
  return [...acc.values()].sort((a, b) => b.hours - a.hours)
}

/**
 * ISO week starts on Monday. Given `YYYY-MM-DD`, return the Monday of that
 * week as `YYYY-MM-DD`. Mirrors Postgres `date_trunc('week', ...)`.
 */
export function weekStartIso(yyyymmdd: string): string {
  const date = new Date(`${yyyymmdd}T00:00:00Z`)
  // getUTCDay: Sunday=0, Monday=1, ... Saturday=6
  const day = date.getUTCDay()
  const diffToMonday = (day + 6) % 7 // Mon=0, Tue=1, ... Sun=6
  const monday = new Date(date.getTime() - diffToMonday * 86_400_000)
  return monday.toISOString().slice(0, 10)
}

export function aggregateLaborByWeek(entries: SeedLaborEntry[]): LaborByWeekRow[] {
  const acc = new Map<string, LaborByWeekRow>()
  for (const e of entries) {
    const key = weekStartIso(e.occurred_on)
    const cur = acc.get(key) ?? { week_start: key, hours: 0, cost: 0 }
    cur.hours += e.hours
    cur.cost += e.hours * e.labor_rate
    acc.set(key, cur)
  }
  return [...acc.values()].sort((a, b) => a.week_start.localeCompare(b.week_start))
}
