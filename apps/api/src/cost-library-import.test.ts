import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import {
  CostLibraryImportError,
  parseCsvPriceBook,
  parsePriceBook,
  parseXlsxPriceBook,
} from './cost-library-import.js'

describe('parseCsvPriceBook', () => {
  it('maps canonical columns and splits material/labor rates', () => {
    const csv = ['trade,code,name,unit,material_rate,labor_rate', 'cladding,CLAD-FC,Fiber cement,sqft,3.50,1.25'].join(
      '\n',
    )
    const rows = parseCsvPriceBook(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      trade: 'cladding',
      code: 'CLAD-FC',
      name: 'Fiber cement',
      unit: 'sqft',
      material_rate: 3.5,
      labor_rate: 1.25,
      region: null,
      source: 'import',
    })
  })

  it('accepts header aliases (CSI / description / cost) case- and space-insensitively', () => {
    const csv = ['CSI Code, Description , UOM , Unit Cost ', '09 24 00, Stucco basecoat , SF , $2.40 '].join('\n')
    const rows = parseCsvPriceBook(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.code).toBe('09 24 00')
    expect(rows[0]?.name).toBe('Stucco basecoat')
    expect(rows[0]?.unit).toBe('SF')
    // A single "Unit Cost" column with a currency symbol folds into material_rate.
    expect(rows[0]?.material_rate).toBe(2.4)
    expect(rows[0]?.labor_rate).toBeNull()
  })

  it('handles quoted fields with embedded commas and escaped quotes', () => {
    const csv = ['code,name,rate', '"FRM-2X4","2x4 stud, 8"" KD",1.95'].join('\n')
    const rows = parseCsvPriceBook(csv)
    expect(rows[0]?.code).toBe('FRM-2X4')
    expect(rows[0]?.name).toBe('2x4 stud, 8" KD')
    expect(rows[0]?.material_rate).toBe(1.95)
  })

  it('strips a UTF-8 BOM, tolerates CRLF, and skips blank rows', () => {
    const csv = '﻿trade,code,rate\r\ncladding,A,1\r\n\r\ncladding,B,2\r\n'
    const rows = parseCsvPriceBook(csv)
    expect(rows.map((r) => r.code)).toEqual(['A', 'B'])
  })

  it('defaults trade/unit/source and nulls unparseable rates', () => {
    const csv = ['code,material_rate', 'X,not-a-number'].join('\n')
    const rows = parseCsvPriceBook(csv, { defaultSource: 'rsmeans' })
    expect(rows[0]).toMatchObject({
      trade: 'general',
      unit: 'ea',
      source: 'rsmeans',
      material_rate: null,
    })
  })

  it('skips rows without a code', () => {
    const csv = ['code,rate', ',5', 'KEEP,6'].join('\n')
    const rows = parseCsvPriceBook(csv)
    expect(rows.map((r) => r.code)).toEqual(['KEEP'])
  })

  it('throws when the price book has no code column', () => {
    const csv = ['trade,unit,rate', 'cladding,sqft,5'].join('\n')
    expect(() => parseCsvPriceBook(csv)).toThrow(CostLibraryImportError)
  })

  it('throws on an empty price book', () => {
    expect(() => parseCsvPriceBook('')).toThrow(CostLibraryImportError)
  })

  it('enforces the row cap', () => {
    const lines = ['code,rate']
    for (let i = 0; i < 6; i++) lines.push(`C${i},1`)
    expect(() => parseCsvPriceBook(lines.join('\n'), { maxRows: 3 })).toThrow(/exceeds 3 rows/)
  })

  it('rejects negative rates (treats them as null)', () => {
    const csv = ['code,material_rate,labor_rate', 'X,-5,2'].join('\n')
    const rows = parseCsvPriceBook(csv)
    expect(rows[0]?.material_rate).toBeNull()
    expect(rows[0]?.labor_rate).toBe(2)
  })
})

describe('parseXlsxPriceBook', () => {
  // Build a real .xlsx in-memory via exceljs so the parse round-trips through
  // the same dependency the route uses — no committed binary fixture needed.
  async function buildXlsx(rows: Array<Array<string | number>>): Promise<Buffer> {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Prices')
    for (const r of rows) ws.addRow(r)
    const buf = await wb.xlsx.writeBuffer()
    return Buffer.from(buf as ArrayBuffer)
  }

  it('parses a first-worksheet price book with split rates', async () => {
    const buffer = await buildXlsx([
      ['Trade', 'Code', 'Name', 'Unit', 'Material Rate', 'Labor Rate', 'Region'],
      ['framing', 'FRM-STUD', '2x4 stud', 'ea', 1.95, 0.5, 'CA'],
      ['cladding', 'CLAD-FC', 'Fiber cement', 'sqft', 3.5, 1.25, 'CA'],
    ])
    const rows = await parseXlsxPriceBook(buffer)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      trade: 'framing',
      code: 'FRM-STUD',
      unit: 'ea',
      material_rate: 1.95,
      labor_rate: 0.5,
      region: 'CA',
      source: 'import',
    })
    expect(rows[1]?.code).toBe('CLAD-FC')
  })

  it('folds a single numeric Cost column into material_rate', async () => {
    const buffer = await buildXlsx([
      ['Code', 'Cost'],
      ['EPS', 2.4],
    ])
    const rows = await parseXlsxPriceBook(buffer)
    expect(rows[0]?.material_rate).toBe(2.4)
    expect(rows[0]?.labor_rate).toBeNull()
  })

  it('throws when the .xlsx has no code column', async () => {
    const buffer = await buildXlsx([
      ['Trade', 'Cost'],
      ['cladding', 5],
    ])
    await expect(parseXlsxPriceBook(buffer)).rejects.toBeInstanceOf(CostLibraryImportError)
  })

  it('throws on a non-xlsx buffer', async () => {
    await expect(parseXlsxPriceBook(Buffer.from('not a workbook'))).rejects.toBeInstanceOf(CostLibraryImportError)
  })
})

describe('parsePriceBook dispatch', () => {
  it('parses CSV text', async () => {
    const rows = await parsePriceBook('csv', 'code,rate\nX,5')
    expect(rows[0]?.code).toBe('X')
    expect(rows[0]?.material_rate).toBe(5)
  })

  it('decodes a base64 .xlsx string', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.addRow(['code', 'rate'])
    ws.addRow(['Y', 7])
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    const rows = await parsePriceBook('xlsx', buf.toString('base64'))
    expect(rows[0]?.code).toBe('Y')
    expect(rows[0]?.material_rate).toBe(7)
  })

  it('rejects an unsupported format', async () => {
    await expect(parsePriceBook('json' as unknown as 'csv', 'x')).rejects.toBeInstanceOf(CostLibraryImportError)
  })
})
