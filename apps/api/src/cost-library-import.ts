/**
 * Cost-library price-book parser (Takeoff Deep Dive M5).
 *
 * Pure, DB-free parsing of an uploaded price book into normalized
 * `ParsedCostLibraryRow`s. Two formats:
 *
 *   - CSV  — parsed here (small, dependency-free; handles quoted fields,
 *            embedded commas, CRLF/LF, and a BOM).
 *   - XLSX — parsed via the existing `exceljs` dependency (the same one the
 *            estimate export already uses). Reads the first worksheet.
 *
 * Both formats share one column-mapping pass: the first row is a header; we
 * map a small set of aliases (case/space/underscore-insensitive) onto the
 * canonical columns. Unknown columns are ignored. This mirrors the
 * takeoff-import "column mapping is unsexy but reliable" UX rule.
 *
 * Keeping this a pure function (string/Buffer in, rows out) is what lets the
 * import endpoint be tested without a database — see cost-library-import.test.ts.
 */

import ExcelJS from 'exceljs'

export interface ParsedCostLibraryRow {
  trade: string
  code: string
  name: string | null
  unit: string
  material_rate: number | null
  labor_rate: number | null
  region: string | null
  source: string
}

export class CostLibraryImportError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message)
    this.name = 'CostLibraryImportError'
  }
}

/** Canonical column → accepted header aliases (normalized: lowercased, non-alnum stripped). */
const COLUMN_ALIASES: Record<string, readonly string[]> = {
  trade: ['trade', 'category', 'division', 'group'],
  code: ['code', 'csi', 'csicode', 'masterformat', 'masterformatcode', 'serviceitemcode', 'itemcode', 'sku'],
  name: ['name', 'description', 'desc', 'item', 'label'],
  unit: ['unit', 'uom', 'units'],
  material_rate: ['materialrate', 'material', 'materialcost', 'matcost', 'matrate'],
  labor_rate: ['laborrate', 'labor', 'laborcost', 'labour', 'labourrate', 'labourcost'],
  // A single combined cost column maps onto material_rate when no explicit
  // material/labor split is present.
  rate: ['rate', 'cost', 'unitcost', 'unitprice', 'price'],
  region: ['region', 'area', 'zone', 'market', 'location'],
  source: ['source', 'origin', 'pricebook', 'book'],
}

function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Build a map of canonical-column-name → column index from a header row. */
function mapHeader(headerCells: readonly string[]): Map<string, number> {
  const map = new Map<string, number>()
  headerCells.forEach((cell, idx) => {
    const norm = normalizeHeader(cell ?? '')
    if (!norm) return
    for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(norm) && !map.has(canonical)) {
        map.set(canonical, idx)
      }
    }
  })
  return map
}

/** Parse a numeric cell that may carry a currency symbol, thousands separators, or be blank. */
function parseRate(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  if (!s) return null
  // Strip currency symbols, thousands separators, and surrounding whitespace.
  const cleaned = s.replace(/[$,\s]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

function trimToNull(raw: unknown, maxLen = 512): string | null {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  if (!s) return null
  return s.slice(0, maxLen)
}

/**
 * Turn a header-mapped row of string cells into a normalized library row.
 * Returns null when the row has no usable `code` (blank trailing rows,
 * separators) so the caller can skip it without erroring.
 */
function buildRow(
  cells: readonly unknown[],
  header: Map<string, number>,
  defaultSource: string,
): ParsedCostLibraryRow | null {
  const at = (col: string): unknown => {
    const idx = header.get(col)
    return idx === undefined ? undefined : cells[idx]
  }

  const code = trimToNull(at('code'), 128)
  if (!code) return null

  const material = parseRate(at('material_rate'))
  const labor = parseRate(at('labor_rate'))
  // When neither split column is present, fold a combined rate/cost column
  // into material_rate so a single-cost price book still resolves a price.
  const combined = material === null && labor === null ? parseRate(at('rate')) : null

  return {
    trade: trimToNull(at('trade'), 128) ?? 'general',
    code,
    name: trimToNull(at('name'), 512),
    unit: trimToNull(at('unit'), 32) ?? 'ea',
    material_rate: material ?? combined,
    labor_rate: labor,
    region: trimToNull(at('region'), 128),
    source: trimToNull(at('source'), 64) ?? defaultSource,
  }
}

/**
 * Split a CSV line respecting double-quoted fields (RFC-4180-ish: `""` is an
 * escaped quote inside a quoted field). Good enough for price-book exports
 * from Excel / Google Sheets / PlanSwift.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
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
    } else if (ch === ',') {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out
}

/** Parse CSV text into raw rows of string cells (header included). */
function parseCsvCells(csv: string): string[][] {
  // Strip a UTF-8 BOM, normalize line endings, drop a trailing newline.
  const text = csv.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const rows: string[][] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    rows.push(splitCsvLine(line))
  }
  return rows
}

export interface ParsePriceBookOptions {
  /** Default `source` applied to rows whose source column is blank. */
  defaultSource?: string
  /** Hard cap on data rows; exceeding throws a 413-style error. */
  maxRows?: number
}

const DEFAULT_MAX_ROWS = 5000

/** Parse a CSV price book (text) into normalized rows. */
export function parseCsvPriceBook(csv: string, options: ParsePriceBookOptions = {}): ParsedCostLibraryRow[] {
  const cells = parseCsvCells(csv)
  if (cells.length === 0) {
    throw new CostLibraryImportError('price book is empty')
  }
  const header = mapHeader(cells[0]!)
  if (!header.has('code')) {
    throw new CostLibraryImportError('price book must have a "code" (or CSI / service_item_code) column')
  }
  return finalizeRows(cells.slice(1), header, options)
}

/** Parse an XLSX price book (Buffer) into normalized rows via exceljs. */
export async function parseXlsxPriceBook(
  buffer: Buffer,
  options: ParsePriceBookOptions = {},
): Promise<ParsedCostLibraryRow[]> {
  const wb = new ExcelJS.Workbook()
  try {
    // exceljs accepts a Node Buffer here; its types want a non-Node Buffer,
    // hence the cast. Mirrors the load shape used elsewhere in the codebase.
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch {
    throw new CostLibraryImportError('could not parse .xlsx file')
  }
  const ws = wb.worksheets[0]
  if (!ws) {
    throw new CostLibraryImportError('.xlsx file has no worksheets')
  }

  const rows: unknown[][] = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: unknown[] = []
    // exceljs rows are 1-indexed; index 0 of `values` is a placeholder.
    const values = Array.isArray(row.values) ? row.values : []
    for (let i = 1; i < values.length; i++) {
      const v = values[i]
      // Cell objects (formulas, rich text, hyperlinks) carry the rendered
      // value under `.result` / `.text`; fall back to the raw value.
      if (v && typeof v === 'object') {
        const obj = v as { result?: unknown; text?: unknown; richText?: Array<{ text?: string }> }
        if (obj.result !== undefined) cells[i - 1] = obj.result
        else if (obj.text !== undefined) cells[i - 1] = obj.text
        else if (Array.isArray(obj.richText)) cells[i - 1] = obj.richText.map((r) => r.text ?? '').join('')
        else cells[i - 1] = v
      } else {
        cells[i - 1] = v
      }
    }
    rows.push(cells)
  })

  if (rows.length === 0) {
    throw new CostLibraryImportError('price book is empty')
  }
  const header = mapHeader(rows[0]!.map((c) => (c === undefined || c === null ? '' : String(c))))
  if (!header.has('code')) {
    throw new CostLibraryImportError('price book must have a "code" (or CSI / service_item_code) column')
  }
  return finalizeRows(rows.slice(1), header, options)
}

function finalizeRows(
  dataRows: readonly unknown[][],
  header: Map<string, number>,
  options: ParsePriceBookOptions,
): ParsedCostLibraryRow[] {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const defaultSource = options.defaultSource ?? 'import'
  const out: ParsedCostLibraryRow[] = []
  for (const cells of dataRows) {
    const row = buildRow(cells, header, defaultSource)
    if (row) out.push(row)
    if (out.length > maxRows) {
      throw new CostLibraryImportError(`price book exceeds ${maxRows} rows`, 413)
    }
  }
  return out
}

/**
 * Entry point used by the route: dispatch on declared format. `content` is the
 * raw text (CSV) or a Buffer (XLSX, decoded from base64 by the route).
 */
export async function parsePriceBook(
  format: 'csv' | 'xlsx',
  content: string | Buffer,
  options: ParsePriceBookOptions = {},
): Promise<ParsedCostLibraryRow[]> {
  if (format === 'csv') {
    return parseCsvPriceBook(typeof content === 'string' ? content : content.toString('utf8'), options)
  }
  if (format === 'xlsx') {
    const buf = typeof content === 'string' ? Buffer.from(content, 'base64') : content
    return parseXlsxPriceBook(buf, options)
  }
  throw new CostLibraryImportError(`unsupported format: ${String(format)}`)
}
