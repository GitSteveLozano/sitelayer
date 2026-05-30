import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import {
  buildEstimatePdfInputFromSummary,
  buildEstimatePdfResponse,
  renderEstimatePdf,
  type EstimatePdfInput,
} from './pdf.js'

async function collectPdf(input: EstimatePdfInput): Promise<Buffer> {
  const sink = new PassThrough()
  const chunks: Buffer[] = []
  sink.on('data', (chunk) => {
    chunks.push(chunk as Buffer)
  })
  await renderEstimatePdf(input, sink)
  return Buffer.concat(chunks)
}

const baseSummary = {
  project: {
    name: 'Maple Hills Phase 2',
    customer_name: 'Maple Builders Inc',
    location: '123 Maple St',
    division_code: 'D1',
    bid_total: 50_000,
    scope_total: 47_500,
  },
  metrics: {
    laborCost: 12_000,
    materialCost: 18_000,
    subCost: 5_000,
    totalCost: 38_500,
    estimateTotal: 47_500,
  },
  estimateLines: [
    { service_item_code: 'EPS', quantity: 100, unit: 'sqft', rate: 12.5, amount: 1250 },
    { service_item_code: 'DRY', quantity: 50, unit: 'sqft', rate: 8, amount: 400 },
  ],
}

describe('buildEstimatePdfInputFromSummary', () => {
  it('flattens summary metrics into PDF totals (overhead = total - labor - material - sub)', () => {
    const input = buildEstimatePdfInputFromSummary({
      company: { name: 'LA Operations', slug: 'la-operations' },
      summary: baseSummary,
    })

    expect(input.totals.labor).toBe(12_000)
    expect(input.totals.material).toBe(18_000 + 5_000)
    expect(input.totals.overhead).toBe(38_500 - 12_000 - 18_000 - 5_000)
    expect(input.totals.total).toBe(38_500)
    expect(input.divisions).toHaveLength(2)
    expect(input.divisions[0]).toMatchObject({ description: 'EPS', qty: 100, unit: 'sqft' })
  })

  it('clamps negative overhead to zero when totals do not reconcile', () => {
    const input = buildEstimatePdfInputFromSummary({
      company: { name: 'Co', slug: 'co' },
      summary: {
        ...baseSummary,
        metrics: { ...baseSummary.metrics, totalCost: 100, laborCost: 50, materialCost: 60, subCost: 20 },
      },
    })
    expect(input.totals.overhead).toBe(0)
  })
})

describe('renderEstimatePdf', () => {
  it('writes a valid PDF with non-zero length and the %PDF magic header', async () => {
    const input = buildEstimatePdfInputFromSummary({
      company: { name: 'LA Operations', slug: 'la-operations' },
      summary: baseSummary,
      appUrl: 'https://example.test',
    })
    const buf = await collectPdf(input)
    expect(buf.length).toBeGreaterThan(500)
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF')
    // Trailer should be present at the end of any valid PDF.
    expect(buf.slice(-32).toString('ascii')).toContain('%%EOF')
  })

  it('renders without crashing when there are zero estimate lines', async () => {
    const input = buildEstimatePdfInputFromSummary({
      company: { name: 'LA Operations', slug: 'la-operations' },
      summary: { ...baseSummary, estimateLines: [] },
    })
    const buf = await collectPdf(input)
    expect(buf.length).toBeGreaterThan(500)
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF')
  })
})

describe('buildEstimatePdfResponse (route handler shape)', () => {
  const company = { name: 'LA Operations', slug: 'la-operations' }
  const allowed = ['admin', 'office'] as const

  it('returns 200 (kind=ok) with content-type-equivalent PDF buffer when role permitted', async () => {
    const result = await buildEstimatePdfResponse({
      role: 'admin',
      allowed,
      company,
      fetchSummary: async () => baseSummary,
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    // status 200 + content-type=application/pdf + content-length > 0 are
    // emitted by the server adapter; the route helper proves the buffer.
    expect(result.pdf.length).toBeGreaterThan(0)
    expect(result.pdf.slice(0, 4).toString('ascii')).toBe('%PDF')
    expect(result.filename).toMatch(/\.pdf$/)
  })

  it('returns 403 (kind=forbidden) for foreman / member roles', async () => {
    for (const role of ['foreman', 'member']) {
      const result = await buildEstimatePdfResponse({
        role,
        allowed,
        company,
        fetchSummary: async () => baseSummary,
      })
      expect(result.kind).toBe('forbidden')
    }
  })

  it('returns 404 (kind=not_found) when project missing', async () => {
    const result = await buildEstimatePdfResponse({
      role: 'admin',
      allowed,
      company,
      fetchSummary: async () => null,
    })
    expect(result.kind).toBe('not_found')
  })
})

describe('report kinds (Phase 3 report builder)', () => {
  const company = { name: 'LA Operations', slug: 'la-operations' }
  const allowed = ['admin', 'office'] as const

  it('threads the report kind + sell total into the input', () => {
    const input = buildEstimatePdfInputFromSummary({ company, report: 'customer', summary: baseSummary })
    expect(input.report).toBe('customer')
    expect(input.totals.sell).toBe(47_500) // estimateTotal
    expect(input.totals.total).toBe(38_500) // cost
  })

  it('defaults to the summary report when no kind is given', () => {
    const input = buildEstimatePdfInputFromSummary({ company, summary: baseSummary })
    expect(input.report).toBeUndefined()
  })

  it('renders a valid PDF for every report kind', async () => {
    for (const report of ['summary', 'customer', 'rfq', 'cost_vs_sell'] as const) {
      const input = buildEstimatePdfInputFromSummary({ company, report, summary: baseSummary })
      const buf = await collectPdf(input)
      expect(buf.length).toBeGreaterThan(500)
      expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF')
    }
  })

  it('buildEstimatePdfResponse filename prefix reflects the report kind', async () => {
    const cases: Array<['summary' | 'customer' | 'rfq' | 'cost_vs_sell' | undefined, RegExp]> = [
      [undefined, /^estimate-/],
      ['summary', /^estimate-/],
      ['customer', /^customer-report-/],
      ['rfq', /^rfq-report-/],
      ['cost_vs_sell', /^cost-vs-sell-report-/],
    ]
    for (const [report, pattern] of cases) {
      const result = await buildEstimatePdfResponse({
        role: 'admin',
        allowed,
        company,
        ...(report ? { report } : {}),
        fetchSummary: async () => baseSummary,
      })
      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') expect(result.filename).toMatch(pattern)
    }
  })
})
