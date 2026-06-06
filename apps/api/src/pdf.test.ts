import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import {
  buildEstimatePdfInputFromSummary,
  buildEstimatePdfResponse,
  groupEstimatePdfLines,
  renderEstimatePdf,
  type EstimatePdfDivision,
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

describe('groupEstimatePdfLines (gap G4 grouped reports)', () => {
  const lines: EstimatePdfDivision[] = [
    { description: 'EPS', qty: 100, unit: 'sqft', rate: 12.5, ext: 1250, kind: 'material', division_code: 'D1' },
    { description: 'LAB', qty: 10, unit: 'hr', rate: 60, ext: 600, kind: 'labor', division_code: 'D1' },
    { description: 'DRY', qty: 50, unit: 'sqft', rate: 8, ext: 400, kind: 'material', division_code: 'D2' },
    { description: 'X', qty: 1, unit: 'ea', rate: 0, ext: 0, kind: null, division_code: null },
  ]

  it('groups + subtotals by division, sorted by subtotal desc, with a null bucket', () => {
    const { axis, groups } = groupEstimatePdfLines(lines, 'division')
    expect(axis).toBe('division')
    expect(groups.find((g) => g.key === 'D1')).toMatchObject({ subtotal: 1850, lineCount: 2 }) // 1250 + 600
    expect(groups.find((g) => g.key === 'D2')?.subtotal).toBe(400)
    expect(groups.find((g) => g.key === '(no division)')?.lineCount).toBe(1)
    expect(groups[0]!.key).toBe('D1') // highest subtotal first
  })

  it('groups + subtotals by cost type (kind)', () => {
    const { axis, groups } = groupEstimatePdfLines(lines, 'kind')
    expect(axis).toBe('cost type')
    expect(groups.find((g) => g.key === 'material')?.subtotal).toBe(1650) // 1250 + 400
    expect(groups.find((g) => g.key === 'labor')?.subtotal).toBe(600)
    expect(groups.find((g) => g.key === '(unclassified)')?.lineCount).toBe(1)
  })
})

describe('grouped report kinds (gap G4)', () => {
  const company = { name: 'LA Operations', slug: 'la-operations' }
  const taggedSummary = {
    ...baseSummary,
    estimateLines: [
      {
        service_item_code: 'EPS',
        quantity: 100,
        unit: 'sqft',
        rate: 12.5,
        amount: 1250,
        kind: 'material',
        division_code: 'D1',
      },
      { service_item_code: 'LAB', quantity: 10, unit: 'hr', rate: 60, amount: 600, kind: 'labor', division_code: 'D1' },
      {
        service_item_code: 'DRY',
        quantity: 50,
        unit: 'sqft',
        rate: 8,
        amount: 400,
        kind: 'material',
        division_code: 'D2',
      },
    ],
  }

  it('by_cost_type attaches a cost-type breakdown', () => {
    const input = buildEstimatePdfInputFromSummary({ company, report: 'by_cost_type', summary: taggedSummary })
    expect(input.breakdown?.axis).toBe('cost type')
    expect(input.breakdown?.groups.find((g) => g.key === 'material')?.subtotal).toBe(1650)
    expect(input.breakdown?.groups.find((g) => g.key === 'labor')?.subtotal).toBe(600)
  })

  it('by_division attaches a division breakdown', () => {
    const input = buildEstimatePdfInputFromSummary({ company, report: 'by_division', summary: taggedSummary })
    expect(input.breakdown?.axis).toBe('division')
    expect(input.breakdown?.groups.find((g) => g.key === 'D1')?.subtotal).toBe(1850)
  })

  it('non-grouped reports carry no breakdown', () => {
    const input = buildEstimatePdfInputFromSummary({ company, report: 'summary', summary: taggedSummary })
    expect(input.breakdown).toBeUndefined()
  })

  it('renders a valid PDF for the grouped kinds', async () => {
    for (const report of ['by_division', 'by_cost_type'] as const) {
      const input = buildEstimatePdfInputFromSummary({ company, report, summary: taggedSummary })
      const buf = await collectPdf(input)
      expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
      expect(buf.subarray(-32).toString('ascii')).toContain('%%EOF')
    }
  })
})
