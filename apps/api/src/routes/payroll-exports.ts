import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { renderXlsxSingleSheet, type XlsxCell } from '../xlsx-writer.js'
import { splitStraightAndOt, DEFAULT_OVERTIME_HOUR_THRESHOLD } from '@sitelayer/domain'

/**
 * Payroll exports: CSV / Xero CSV / Payworks CSV / JSON.
 *
 * labor_payroll_runs already drives the QBO TimeActivity push. This route
 * issues export-format requests (audit row in payroll_exports) and renders
 * the bytes on demand at GET /api/labor-payroll-runs/:id/exports/:exportId/download.
 *
 * XLSX is intentionally not in the first cut — adding an OOXML dep is a
 * follow-up. The route still allows requesting it; download returns 503
 * until the renderer ships.
 */
export type PayrollExportRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  // Direct response write for streaming the rendered file back to the caller.
  res: http.ServerResponse
}

const COLUMNS = `
  id, company_id, payroll_run_id, format, storage_path, download_url,
  presigned_expires_at, byte_size, row_count, status, error,
  requested_by_user_id, requested_at, completed_at, origin
`
export const ALLOWED_FORMATS = new Set([
  'xlsx',
  'csv',
  'xero_csv',
  'payworks_csv',
  'gusto_csv',
  'adp_csv',
  'json',
])

export async function handlePayrollExportRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: PayrollExportRouteCtx,
): Promise<boolean> {
  const listMatch = url.pathname.match(/^\/api\/labor-payroll-runs\/([^/]+)\/exports$/)
  if (req.method === 'GET' && listMatch) {
    const runId = listMatch[1]!
    const result = await ctx.pool.query(
      `select ${COLUMNS} from payroll_exports
       where company_id = $1 and payroll_run_id = $2
       order by requested_at desc`,
      [ctx.company.id, runId],
    )
    ctx.sendJson(200, { exports: result.rows })
    return true
  }
  if (req.method === 'POST' && listMatch) {
    if (!ctx.requireRole(['admin', 'office', 'bookkeeper'])) return true
    const runId = listMatch[1]!
    const body = await ctx.readBody()
    const format = String(body.format ?? '').trim()
    if (!ALLOWED_FORMATS.has(format)) {
      ctx.sendJson(400, { error: `format must be one of: ${[...ALLOWED_FORMATS].join(', ')}` })
      return true
    }
    // De-dupe: if a pending or ready row exists for (run, format) within
    // the last hour, return that instead of stacking up duplicates.
    const existing = await ctx.pool.query(
      `select ${COLUMNS} from payroll_exports
       where company_id = $1 and payroll_run_id = $2 and format = $3
         and status in ('pending', 'ready')
         and requested_at > now() - interval '1 hour'
       order by requested_at desc limit 1`,
      [ctx.company.id, runId, format],
    )
    if (existing.rows[0]) {
      ctx.sendJson(200, existing.rows[0])
      return true
    }
    // Render is on demand at the download endpoint. The row goes straight
    // to 'ready' so the consumer knows the artifact exists.
    const result = await ctx.pool.query(
      `insert into payroll_exports (company_id, payroll_run_id, format, requested_by_user_id, status, completed_at)
       values ($1, $2, $3, $4, 'ready', now())
       returning ${COLUMNS}`,
      [ctx.company.id, runId, format, ctx.currentUserId],
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  const downloadMatch = url.pathname.match(/^\/api\/labor-payroll-runs\/([^/]+)\/exports\/([^/]+)\/download$/)
  if (req.method === 'GET' && downloadMatch) {
    if (!ctx.requireRole(['admin', 'office', 'bookkeeper'])) return true
    const runId = downloadMatch[1]!
    const exportId = downloadMatch[2]!

    const exportRow = await ctx.pool.query<{ format: string; status: string }>(
      `select format, status from payroll_exports
       where company_id = $1 and id = $2 and payroll_run_id = $3 limit 1`,
      [ctx.company.id, exportId, runId],
    )
    if (!exportRow.rows[0]) {
      ctx.sendJson(404, { error: 'export not found' })
      return true
    }
    const format = exportRow.rows[0].format
    const run = await ctx.pool.query<{
      period_start: string
      period_end: string
      state: string
      total_hours: string
      total_cents: string
      covered_labor_entry_ids: string[]
    }>(
      `select to_char(period_start, 'YYYY-MM-DD') as period_start,
              to_char(period_end, 'YYYY-MM-DD') as period_end,
              state, total_hours, total_cents, covered_labor_entry_ids
       from labor_payroll_runs
       where company_id = $1 and id = $2 and deleted_at is null limit 1`,
      [ctx.company.id, runId],
    )
    if (!run.rows[0]) {
      ctx.sendJson(404, { error: 'payroll run not found' })
      return true
    }
    const entryIds = run.rows[0].covered_labor_entry_ids ?? []
    const entries = entryIds.length
      ? await ctx.pool.query<{
          worker_id: string | null
          worker_name: string | null
          worker_email: string | null
          project_name: string
          service_item_code: string
          hours: string
          sqft_done: string
          occurred_on: string
        }>(
          `select le.worker_id,
                  w.name as worker_name,
                  w.email as worker_email,
                  p.name as project_name,
                  le.service_item_code,
                  le.hours,
                  le.sqft_done,
                  to_char(le.occurred_on, 'YYYY-MM-DD') as occurred_on
             from labor_entries le
             join projects p on p.company_id = le.company_id and p.id = le.project_id
             left join workers w on w.company_id = le.company_id and w.id = le.worker_id
            where le.company_id = $1 and le.id = ANY($2::uuid[]) and le.deleted_at is null
            order by le.occurred_on asc, le.id asc`,
          [ctx.company.id, entryIds],
        )
      : { rows: [] }

    const rendered = renderPayrollExport(format, run.rows[0], entries.rows)
    const filename = `payroll-${run.rows[0].period_start}-to-${run.rows[0].period_end}.${rendered.ext}`
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', rendered.contentType)
    ctx.res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    ctx.res.setHeader('Cache-Control', 'private, no-store')
    ctx.res.end(rendered.body)
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// On-demand renderers. CSV is the canonical text format; xero_csv and
// payworks_csv re-shape the same rows into the columns those products
// expect. JSON is a debug dump.
// ---------------------------------------------------------------------------

export type RunInfo = {
  period_start: string
  period_end: string
  state: string
  total_hours: string
  total_cents: string
}

export type EntryRow = {
  worker_id: string | null
  worker_name: string | null
  worker_email: string | null
  project_name: string
  service_item_code: string
  hours: string
  sqft_done: string
  occurred_on: string
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return text
}

function csvJoin(rows: Array<Array<unknown>>): string {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n'
}

export function renderPayrollExport(
  format: string,
  run: RunInfo,
  entries: EntryRow[],
): { contentType: string; ext: string; body: string | Buffer } {
  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      ext: 'json',
      body: JSON.stringify({ run, entries }, null, 2),
    }
  }
  if (format === 'xlsx') {
    const rows: XlsxCell[][] = [
      ['Worker', 'Email', 'Date', 'Project', 'Service Item', 'Hours', 'Sqft Done'],
      ...entries.map((entry) => [
        entry.worker_name ?? '',
        entry.worker_email ?? '',
        entry.occurred_on,
        entry.project_name,
        entry.service_item_code,
        Number(entry.hours),
        Number(entry.sqft_done),
      ]),
    ]
    return {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ext: 'xlsx',
      body: renderXlsxSingleSheet(`Payroll ${run.period_start}`, rows),
    }
  }
  if (format === 'xero_csv') {
    // Xero "Pay Items" CSV: minimum columns Xero accepts for time-based
    // earnings — Employee, Date, Pay Item, Units (Hours), Rate, Description.
    const header = ['Employee', 'Date', 'Pay Item', 'Units', 'Rate', 'Description']
    const lines = entries.map((entry) => [
      entry.worker_name ?? entry.worker_email ?? entry.worker_id ?? '',
      entry.occurred_on,
      entry.service_item_code,
      entry.hours,
      '',
      entry.project_name,
    ])
    return {
      contentType: 'text/csv; charset=utf-8',
      ext: 'csv',
      body: csvJoin([header, ...lines]),
    }
  }
  if (format === 'payworks_csv') {
    // Payworks Time Import: Employee Number / Date / Hours Code / Hours /
    // Department / Notes. Employee Number maps to worker email lower-cased
    // as a stable identifier the bookkeeper can rekey to their Payworks id
    // before upload.
    const header = ['Employee Number', 'Date', 'Hours Code', 'Hours', 'Department', 'Notes']
    const lines = entries.map((entry) => [
      (entry.worker_email ?? entry.worker_id ?? '').toLowerCase(),
      entry.occurred_on,
      entry.service_item_code,
      entry.hours,
      entry.project_name,
      `sqft_done=${entry.sqft_done}`,
    ])
    return {
      contentType: 'text/csv; charset=utf-8',
      ext: 'csv',
      body: csvJoin([header, ...lines]),
    }
  }
  if (format === 'gusto_csv') {
    // Gusto Time Tracking Import: First Name, Last Name, Date, Hours,
    // Hours Type (Regular | Overtime | Double Time), Note. We split each
    // worker's daily hours into straight vs OT using the configured
    // threshold (default 8 hr/day) so the row imports correctly without
    // a payroll admin re-typing the split.
    const header = ['First Name', 'Last Name', 'Date', 'Hours', 'Hours Type', 'Note']
    const lines: string[][] = []
    for (const entry of entries) {
      const [first, ...rest] = (entry.worker_name ?? entry.worker_email ?? '').split(' ')
      const last = rest.join(' ')
      const total = Number(entry.hours)
      const { straight_hours, ot_hours } = splitStraightAndOt(total, DEFAULT_OVERTIME_HOUR_THRESHOLD)
      const note = `${entry.project_name} / ${entry.service_item_code}`
      if (straight_hours > 0) {
        lines.push([first ?? '', last, entry.occurred_on, String(straight_hours), 'Regular', note])
      }
      if (ot_hours > 0) {
        lines.push([first ?? '', last, entry.occurred_on, String(ot_hours), 'Overtime', note])
      }
    }
    return {
      contentType: 'text/csv; charset=utf-8',
      ext: 'csv',
      body: csvJoin([header, ...lines]),
    }
  }
  if (format === 'adp_csv') {
    // ADP Run Time Import: Co Code (blank for manual rekey) / File Number
    // (blank — worker email lower-cased so the bookkeeper can lookup) /
    // Pay Date / Hours Code (REG | OT) / Hours / Dept Code. Same daily-OT
    // split as Gusto.
    const header = ['Co Code', 'File Number', 'Pay Date', 'Hours Code', 'Hours', 'Dept Code']
    const lines: string[][] = []
    for (const entry of entries) {
      const fileNumber = (entry.worker_email ?? entry.worker_id ?? '').toLowerCase()
      const total = Number(entry.hours)
      const { straight_hours, ot_hours } = splitStraightAndOt(total, DEFAULT_OVERTIME_HOUR_THRESHOLD)
      const dept = entry.service_item_code
      if (straight_hours > 0) {
        lines.push(['', fileNumber, entry.occurred_on, 'REG', String(straight_hours), dept])
      }
      if (ot_hours > 0) {
        lines.push(['', fileNumber, entry.occurred_on, 'OT', String(ot_hours), dept])
      }
    }
    return {
      contentType: 'text/csv; charset=utf-8',
      ext: 'csv',
      body: csvJoin([header, ...lines]),
    }
  }
  // generic CSV
  const header = ['Worker', 'Email', 'Date', 'Project', 'Service Item', 'Hours', 'Sqft Done']
  const lines = entries.map((entry) => [
    entry.worker_name ?? '',
    entry.worker_email ?? '',
    entry.occurred_on,
    entry.project_name,
    entry.service_item_code,
    entry.hours,
    entry.sqft_done,
  ])
  return {
    contentType: 'text/csv; charset=utf-8',
    ext: 'csv',
    body: csvJoin([header, ...lines]),
  }
}
