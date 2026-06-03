import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { withCompanyClient } from '../mutation-tx.js'

/**
 * Per-tenant data export — admin-only, strictly company-scoped.
 *
 * Table-stakes for a paying pilot: portability + offboarding ("give me my
 * data") and the precursor to a per-tenant restore. A company admin exports
 * THEIR company's rows as a single JSON bundle (default) or a CSV bundle
 * (one section per table) via:
 *
 *   GET /api/company/export            -> JSON bundle (default)
 *   GET /api/company/export?format=json
 *   GET /api/company/export?format=csv -> CSV bundle (concatenated sections)
 *
 * Isolation is belt-and-suspenders:
 *   1. The whole read runs inside `withCompanyClient(companyId, …)`, which
 *      `SET LOCAL app.company_id` so RLS scopes every row to this company.
 *   2. Every per-table SELECT ALSO carries an explicit `where company_id = $1`.
 *      RLS-FORCE is the backstop; the explicit predicate is the primary control
 *      and survives even on the dev/CI BYPASSRLS role.
 *
 * The set of tables is discovered from the live catalog (every `public` table
 * with a `company_id` column) so the export tracks schema growth automatically,
 * MINUS the registry / append-only / cross-tenant tables that are not a tenant's
 * own portable business data (see EXPORT_TABLE_DENYLIST).
 */
export type CompanyExportRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  sendJson: (status: number, body: unknown) => void
  res: http.ServerResponse
}

/**
 * Tables that have a `company_id` column but are NOT part of a tenant's portable
 * business data. Excluded from the export with a reason each:
 *   - append-only audit / queue / ledger internals (operational, not customer data)
 *   - cross-tenant / platform internals
 *   - bootstrap/provisioning caches
 * Everything else with a `company_id` column is exported.
 */
export const EXPORT_TABLE_DENYLIST: Readonly<Record<string, string>> = {
  // Append-only audit / sync / outbox internals — operational ledgers, not the
  // company's own business rows. (Also the ENABLE-not-FORCE pg_dump set.)
  audit_events: 'append-only audit trail (operational ledger)',
  mutation_outbox: 'outbound sync queue (operational)',
  sync_events: 'directional sync ledger (operational)',
  workflow_event_log: 'append-only workflow event log (operational)',
  audit_escrow_entries: 'append-only escrow ledger (operational)',
  audit_escrow_keys: 'escrow signing keys (operational/secret)',

  // Bootstrap / provisioning / usage internals.
  company_bootstrap_state: 'internal bootstrap-token cache',
  tenant_provisions: 'cross-tenant provisioning ledger',
  company_usage_log: 'internal usage metering',

  // Integration secrets — tokens, not portable business data. (Mappings/config
  // are exported via integration_mappings; the secret tokens are excluded.)
  integration_connections: 'OAuth tokens / webhook secrets (do not export secrets)',
  integration_circuit_state: 'integration circuit-breaker state (operational)',

  // Support/debug internals.
  support_debug_packets: 'support debug packets (operational)',
  support_packet_access_log: 'support packet access log (operational)',
  impersonation_sessions: 'platform-admin impersonation sessions (cross-tenant internal)',
  mesh_trace_forward_state: 'mesh trace forwarding state (operational)',
}

/** Catalog query: every `public` table that has a `company_id` column. */
export const COMPANY_EXPORT_TABLE_SQL = `
  SELECT DISTINCT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN information_schema.columns col
      ON col.table_schema = 'public'
     AND col.table_name = c.relname
     AND col.column_name = 'company_id'
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
   ORDER BY c.relname
`

/**
 * Pure selection: given every catalog table that has a `company_id` column,
 * return the sorted list of tables to export (catalog tables minus the denylist).
 * Separated from the DB so it is unit-testable without Postgres.
 */
export function selectExportTables(
  companyIdTables: readonly string[],
  denylist: Readonly<Record<string, string>> = EXPORT_TABLE_DENYLIST,
): string[] {
  return companyIdTables
    .filter((t) => !Object.prototype.hasOwnProperty.call(denylist, t))
    .slice()
    .sort()
}

/** A safe SQL identifier (table name from the catalog). Defensive belt. */
function isSafeIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(name)
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/[",\n\r]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return text
}

/**
 * Render an export bundle (a map of table -> rows) into a single CSV document
 * with one section per table. Pure / testable.
 */
export function renderCsvBundle(bundle: Record<string, Array<Record<string, unknown>>>): string {
  const sections: string[] = []
  for (const table of Object.keys(bundle).sort()) {
    const rows = bundle[table] ?? []
    sections.push(`# table: ${table} (${rows.length} row${rows.length === 1 ? '' : 's'})`)
    if (rows.length === 0) {
      sections.push('')
      continue
    }
    // Union of keys across rows (stable order: first-seen then sorted remainder).
    const header: string[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key)
          header.push(key)
        }
      }
    }
    sections.push(header.map(csvEscape).join(','))
    for (const row of rows) {
      sections.push(header.map((key) => csvEscape(row[key])).join(','))
    }
    sections.push('')
  }
  return sections.join('\n')
}

/**
 * Handle GET /api/company/export. Admin-only. Streams a JSON (default) or CSV
 * bundle of the requesting company's rows. Every read is scoped to the company
 * by the GUC AND an explicit `where company_id = $1` predicate.
 */
export async function handleCompanyExportRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: CompanyExportRouteCtx,
): Promise<boolean> {
  if (req.method !== 'GET' || url.pathname !== '/api/company/export') return false
  if (!ctx.requireRole(['admin'])) return true

  const format = (url.searchParams.get('format') ?? 'json').toLowerCase()
  if (format !== 'json' && format !== 'csv') {
    ctx.sendJson(400, { error: "format must be 'json' or 'csv'" })
    return true
  }

  const companyId = ctx.company.id

  // Discover the exportable tables and read every one inside a single
  // company-scoped read transaction (one GUC binding for the whole export).
  const bundle = await withCompanyClient(companyId, async (client) => {
    const catalog = await client.query<{ table_name: string }>(COMPANY_EXPORT_TABLE_SQL)
    const tables = selectExportTables(catalog.rows.map((r) => r.table_name)).filter(isSafeIdentifier)

    const out: Record<string, Array<Record<string, unknown>>> = {}
    for (const table of tables) {
      // Explicit company_id predicate in addition to the bound GUC. The table
      // name is catalog-sourced and identifier-validated above, so the
      // interpolation is safe; the company_id is parameterized.
      const result = await client.query<Record<string, unknown>>(`select * from "${table}" where company_id = $1`, [
        companyId,
      ])
      out[table] = result.rows
    }
    return out
  })

  const tableCount = Object.keys(bundle).length
  const rowCount = Object.values(bundle).reduce((sum, rows) => sum + rows.length, 0)
  const timestamp = new Date().toISOString()
  const filenameStamp = timestamp.replace(/[:.]/g, '-')

  if (format === 'csv') {
    const body = renderCsvBundle(bundle)
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    ctx.res.setHeader('Content-Disposition', `attachment; filename="company-export-${companyId}-${filenameStamp}.csv"`)
    ctx.res.setHeader('Cache-Control', 'private, no-store')
    ctx.res.end(body)
    return true
  }

  const payload = {
    company_id: companyId,
    company_slug: ctx.company.slug,
    exported_at: timestamp,
    table_count: tableCount,
    row_count: rowCount,
    tables: bundle,
  }
  const body = JSON.stringify(payload, null, 2)
  ctx.res.statusCode = 200
  ctx.res.setHeader('Content-Type', 'application/json; charset=utf-8')
  ctx.res.setHeader('Content-Disposition', `attachment; filename="company-export-${companyId}-${filenameStamp}.json"`)
  ctx.res.setHeader('Cache-Control', 'private, no-store')
  ctx.res.end(body)
  return true
}
