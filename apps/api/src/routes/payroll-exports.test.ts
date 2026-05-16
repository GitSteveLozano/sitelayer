import { describe, expect, it } from 'vitest'
import { ALLOWED_FORMATS, renderPayrollExport, type EntryRow, type RunInfo } from './payroll-exports.js'

const run: RunInfo = {
  period_start: '2026-05-01',
  period_end: '2026-05-15',
  state: 'approved',
  total_hours: '90',
  total_cents: '450000',
}

function entry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    worker_id: 'w-1',
    worker_name: 'Alex Rivera',
    worker_email: 'alex@example.com',
    project_name: 'Project A',
    service_item_code: 'EIFS-STD',
    hours: '10',
    sqft_done: '0',
    occurred_on: '2026-05-02',
    ...overrides,
  }
}

describe('payroll-exports', () => {
  it('lists the new formats in ALLOWED_FORMATS', () => {
    expect(ALLOWED_FORMATS.has('gusto_csv')).toBe(true)
    expect(ALLOWED_FORMATS.has('adp_csv')).toBe(true)
  })

  describe('gusto_csv', () => {
    it('splits 10 hours into 8 regular + 2 overtime', () => {
      const out = renderPayrollExport('gusto_csv', run, [entry({ hours: '10' })])
      const body = String(out.body)
      expect(body).toContain('First Name,Last Name,Date,Hours,Hours Type,Note')
      expect(body).toMatch(/Alex,Rivera,2026-05-02,8,Regular,/)
      expect(body).toMatch(/Alex,Rivera,2026-05-02,2,Overtime,/)
    })

    it('emits a single Regular row when under threshold', () => {
      const out = renderPayrollExport('gusto_csv', run, [entry({ hours: '6' })])
      const body = String(out.body)
      expect(body).toMatch(/Alex,Rivera,2026-05-02,6,Regular,/)
      expect(body).not.toMatch(/Overtime/)
    })
  })

  describe('adp_csv', () => {
    it('splits and tags as REG / OT using the worker email as file number', () => {
      const out = renderPayrollExport('adp_csv', run, [entry({ hours: '12' })])
      const body = String(out.body)
      expect(body).toContain('Co Code,File Number,Pay Date,Hours Code,Hours,Dept Code')
      // Order: REG line first, then OT.
      const lines = body.trim().split('\n').slice(1)
      expect(lines[0]).toMatch(/,alex@example\.com,2026-05-02,REG,8,EIFS-STD/)
      expect(lines[1]).toMatch(/,alex@example\.com,2026-05-02,OT,4,EIFS-STD/)
    })

    it('lower-cases the worker email for stable file-number lookup', () => {
      const out = renderPayrollExport('adp_csv', run, [entry({ worker_email: 'Alex@Example.com', hours: '4' })])
      expect(String(out.body)).toMatch(/alex@example\.com/)
      expect(String(out.body)).not.toMatch(/Alex@Example\.com/)
    })
  })
})
