/**
 * Takeoff CSV / bulk-import resource layer (Phase 2.2).
 *
 * The integration play: estimators living in Bluebeam / PlanSwift / OST keep
 * their existing takeoff workflow, export to CSV, and drop the file (or paste
 * the rows) into Sitelayer. The structured rows land as `takeoff_measurements`
 * via `POST /api/projects/:id/takeoff/import`.
 *
 * The server is intentionally stateless about CSV dialects/encoding/column
 * mapping (see `apps/api/src/routes/takeoff-import.ts`) — it accepts
 * JSON-shaped rows only. So parsing + preview happen entirely in the browser
 * here, and the commit mutation posts the cleaned rows.
 *
 * This module deliberately stands alone (its own parse helpers + commit
 * mutation) rather than reaching into `takeoff.ts`, so the bulk-import flow
 * owns its own contract.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

// ---------------------------------------------------------------------------
// Wire contract — mirrors the API's ImportRow.
// ---------------------------------------------------------------------------

export interface TakeoffImportRow {
  service_item_code: string
  quantity: number
  unit?: string
  rate?: number
  notes?: string
}

export interface TakeoffImportInput {
  rows: TakeoffImportRow[]
  /** Free-text origin label, shown back as a `[imported:<label>]` notes prefix. */
  source_label?: string
  /** Optional blueprint page to associate the imported measurements with. */
  page_id?: string
}

export interface TakeoffImportResult {
  imported: number
  source_label: string
  measurements: Array<{ measurement_id: string; tag_id: string }>
}

/** Server cap (`apps/api/src/routes/takeoff-import.ts`): imports are 1000 rows max. */
export const TAKEOFF_IMPORT_MAX_ROWS = 1000

// ---------------------------------------------------------------------------
// Client-side parse / preview.
//
// The API has no parse endpoint by design, so preview is local: split a
// pasted/dropped CSV-or-TSV blob into header + rows, map the known columns,
// and surface per-row validation so the estimator can fix the file before
// committing. Nothing here touches the network.
// ---------------------------------------------------------------------------

export interface TakeoffImportPreviewRow {
  /** 1-based source line number (excluding the header), for error display. */
  line: number
  row: TakeoffImportRow
  /** Validation message when the row can't be imported as-is; null when valid. */
  error: string | null
}

export interface TakeoffImportPreview {
  /** Detected/normalized header cells, in source order. */
  headers: string[]
  /** Which header index maps to each known field (-1 = not found). */
  columns: {
    service_item_code: number
    quantity: number
    unit: number
    rate: number
    notes: number
  }
  rows: TakeoffImportPreviewRow[]
  /** Rows with `error === null`. */
  validRows: TakeoffImportRow[]
  /** Count of rows that failed validation. */
  invalidCount: number
}

const COLUMN_ALIASES: Record<keyof TakeoffImportPreview['columns'], string[]> = {
  service_item_code: ['service_item_code', 'service item code', 'service item', 'code', 'item', 'item code', 'scope'],
  quantity: ['quantity', 'qty', 'amount', 'count'],
  unit: ['unit', 'units', 'uom'],
  rate: ['rate', 'unit rate', 'price', 'unit price', 'cost'],
  notes: ['notes', 'note', 'description', 'desc', 'comment', 'comments'],
}

function normalizeHeader(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
}

/** Split a single CSV/TSV line, honoring double-quoted fields with embedded commas. */
function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out.map((c) => c.trim())
}

/** Tab if the first non-empty line has more tabs than commas, else comma. */
function detectDelimiter(firstLine: string): string {
  const tabs = (firstLine.match(/\t/g) ?? []).length
  const commas = (firstLine.match(/,/g) ?? []).length
  return tabs > commas ? '\t' : ','
}

function findColumn(headers: string[], aliases: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    if (aliases.includes(headers[i]!)) return i
  }
  return -1
}

/**
 * Parse a pasted/dropped CSV or TSV blob into a previewable structure.
 * Expects a header row. Unknown columns are ignored; missing required
 * columns (`service_item_code`, `quantity`) surface as per-row errors.
 */
export function parseTakeoffImport(text: string): TakeoffImportPreview {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0)

  if (lines.length === 0) {
    return {
      headers: [],
      columns: { service_item_code: -1, quantity: -1, unit: -1, rate: -1, notes: -1 },
      rows: [],
      validRows: [],
      invalidCount: 0,
    }
  }

  const delimiter = detectDelimiter(lines[0]!)
  const rawHeaders = splitDelimited(lines[0]!, delimiter)
  const headers = rawHeaders.map(normalizeHeader)

  const columns = {
    service_item_code: findColumn(headers, COLUMN_ALIASES.service_item_code),
    quantity: findColumn(headers, COLUMN_ALIASES.quantity),
    unit: findColumn(headers, COLUMN_ALIASES.unit),
    rate: findColumn(headers, COLUMN_ALIASES.rate),
    notes: findColumn(headers, COLUMN_ALIASES.notes),
  }

  const rows: TakeoffImportPreviewRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitDelimited(lines[i]!, delimiter)
    const at = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx]!.trim() : '')

    const code = at(columns.service_item_code)
    const qtyRaw = at(columns.quantity)
    const qty = Number(qtyRaw.replace(/,/g, ''))
    const unit = at(columns.unit)
    const rateRaw = at(columns.rate).replace(/[$,]/g, '')
    const rate = rateRaw ? Number(rateRaw) : undefined
    const notes = at(columns.notes)

    let error: string | null = null
    if (columns.service_item_code < 0) error = 'Missing a "service_item_code" column'
    else if (columns.quantity < 0) error = 'Missing a "quantity" column'
    else if (!code) error = 'Empty service item code'
    else if (!qtyRaw) error = 'Empty quantity'
    else if (!Number.isFinite(qty) || qty < 0) error = `Quantity "${qtyRaw}" is not a number ≥ 0`
    else if (rate !== undefined && !Number.isFinite(rate)) error = `Rate "${at(columns.rate)}" is not a number`

    const row: TakeoffImportRow = {
      service_item_code: code,
      quantity: Number.isFinite(qty) ? qty : 0,
      ...(unit ? { unit } : {}),
      ...(rate !== undefined && Number.isFinite(rate) ? { rate } : {}),
      ...(notes ? { notes } : {}),
    }
    rows.push({ line: i, row, error })
  }

  const validRows = rows.filter((r) => r.error === null).map((r) => r.row)
  return {
    headers,
    columns,
    rows,
    validRows,
    invalidCount: rows.length - validRows.length,
  }
}

// ---------------------------------------------------------------------------
// Commit mutation.
// ---------------------------------------------------------------------------

/**
 * Bulk-import parsed rows into the project's takeoff. Imports stay live (no
 * offline queue): this is an office/estimator action on a stable connection,
 * and a failure should surface immediately rather than silently queue.
 *
 * On success the `['takeoff']` query family is invalidated so the active
 * draft's measurements + running totals refetch, plus `['blueprints']`
 * because per-page measurement counts may shift when `page_id` is supplied.
 */
export function useTakeoffImport(projectId: string) {
  const qc = useQueryClient()
  return useMutation<TakeoffImportResult, Error, TakeoffImportInput>({
    mutationFn: (input) =>
      request(`/api/projects/${encodeURIComponent(projectId)}/takeoff/import`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['takeoff'] })
      qc.invalidateQueries({ queryKey: ['blueprints'] })
    },
  })
}
