import { describe, expect, it } from 'vitest'
import { EXPORT_TABLE_DENYLIST, renderCsvBundle, selectExportTables } from './company-export.js'

describe('company-export', () => {
  describe('selectExportTables', () => {
    it('keeps tenant business tables and drops denylisted operational tables', () => {
      const catalog = [
        'projects',
        'customers',
        'labor_entries',
        'audit_events', // denylisted
        'mutation_outbox', // denylisted
        'integration_connections', // denylisted (secrets)
      ]
      const selected = selectExportTables(catalog)
      expect(selected).toEqual(['customers', 'labor_entries', 'projects'])
      expect(selected).not.toContain('audit_events')
      expect(selected).not.toContain('mutation_outbox')
      expect(selected).not.toContain('integration_connections')
    })

    it('returns a sorted list (deterministic bundle order)', () => {
      const selected = selectExportTables(['workers', 'customers', 'projects'])
      expect(selected).toEqual(['customers', 'projects', 'workers'])
    })

    it('never exports integration secrets or append-only ledgers', () => {
      // Spot-check the security-relevant denylist entries are present.
      expect(EXPORT_TABLE_DENYLIST).toHaveProperty('integration_connections')
      expect(EXPORT_TABLE_DENYLIST).toHaveProperty('audit_escrow_keys')
      expect(EXPORT_TABLE_DENYLIST).toHaveProperty('impersonation_sessions')
      const selected = selectExportTables(Object.keys(EXPORT_TABLE_DENYLIST))
      expect(selected).toEqual([])
    })
  })

  describe('renderCsvBundle', () => {
    it('emits one section per table with a header and rows', () => {
      const csv = renderCsvBundle({
        projects: [
          { id: 'p1', company_id: 'c1', name: 'Alpha' },
          { id: 'p2', company_id: 'c1', name: 'Beta' },
        ],
        customers: [{ id: 'cu1', company_id: 'c1', name: 'Acme, Inc.' }],
      })
      // Sections are emitted in sorted table order.
      const customersIdx = csv.indexOf('# table: customers')
      const projectsIdx = csv.indexOf('# table: projects')
      expect(customersIdx).toBeGreaterThanOrEqual(0)
      expect(projectsIdx).toBeGreaterThan(customersIdx)

      expect(csv).toContain('# table: projects (2 rows)')
      expect(csv).toContain('id,company_id,name')
      expect(csv).toContain('p1,c1,Alpha')
      // CSV-escapes a value with a comma.
      expect(csv).toContain('"Acme, Inc."')
    })

    it('handles an empty table section without a header row', () => {
      const csv = renderCsvBundle({ projects: [] })
      expect(csv).toContain('# table: projects (0 rows)')
      expect(csv).not.toContain('id,company_id')
    })

    it('serializes object/array cell values as JSON and escapes them', () => {
      const csv = renderCsvBundle({
        projects: [{ id: 'p1', meta: { tags: ['a', 'b'] } }],
      })
      // JSON contains a comma -> wrapped in quotes, inner quotes doubled.
      expect(csv).toContain('"{""tags"":[""a"",""b""]}"')
    })

    it('unions keys across heterogeneous rows so no column is dropped', () => {
      const csv = renderCsvBundle({
        notes: [
          { id: 'n1', a: 1 },
          { id: 'n2', b: 2 },
        ],
      })
      const headerLine = csv.split('\n').find((l) => l.startsWith('id,'))
      expect(headerLine).toBe('id,a,b')
    })
  })
})
