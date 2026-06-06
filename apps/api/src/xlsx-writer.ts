import { deflateRawSync, crc32 } from 'node:zlib'

/**
 * Minimal single-sheet XLSX writer.
 *
 * Produces an Office Open XML file (Excel 2007+) without external deps.
 * Cells are either strings or numbers. Strings live inline (no shared
 * strings table) to keep the writer one-shot. Use this only for export
 * shapes that fit on a single sheet with no styling — payroll exports,
 * BOM dumps, audit reports. Anything richer should pull in exceljs.
 *
 * Behaviour:
 *   - First row of `rows` is treated as the header (no styling).
 *   - Numeric cells (typeof === 'number' and finite) render as Number.
 *   - null / undefined → blank cell.
 *   - Strings are XML-escaped; '\n' is preserved (Excel renders it when
 *     the cell wraps).
 */

export type XlsxCell = string | number | null | undefined

export function renderXlsxSingleSheet(sheetName: string, rows: ReadonlyArray<ReadonlyArray<XlsxCell>>): Buffer {
  const safeSheetName = sanitizeSheetName(sheetName)
  const sheetXml = buildSheetXml(rows)
  const workbookXml = buildWorkbookXml(safeSheetName)
  const workbookRels = buildWorkbookRels()
  const contentTypes = buildContentTypes()
  const rootRels = buildRootRels()

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ]

  return zip(entries)
}

// ---------------------------------------------------------------------------
// XLSX part generators
// ---------------------------------------------------------------------------

function sanitizeSheetName(name: string): string {
  // Excel disallows : \ / ? * [ ]  and caps at 31 chars.
  const cleaned = name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31)
  return cleaned || 'Sheet1'
}

function buildContentTypes(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
}

function buildRootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
}

function buildWorkbookXml(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
}

function buildWorkbookRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
}

function buildSheetXml(rows: ReadonlyArray<ReadonlyArray<XlsxCell>>): string {
  const parts: string[] = []
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
  rows.forEach((row, rIdx) => {
    const rowNum = rIdx + 1
    parts.push(`<row r="${rowNum}">`)
    row.forEach((cell, cIdx) => {
      if (cell === null || cell === undefined || cell === '') return
      const ref = `${columnLetter(cIdx)}${rowNum}`
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        parts.push(`<c r="${ref}"><v>${cell}</v></c>`)
      } else {
        const text = String(cell)
        parts.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`)
      }
    })
    parts.push('</row>')
  })
  parts.push('</sheetData></worksheet>')
  return parts.join('')
}

function columnLetter(idx: number): string {
  let result = ''
  let n = idx
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26) - 1
  }
  return result
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (deflate compression). Each entry gets a local file
// header, deflate-raw compressed bytes, and a central directory record;
// the archive ends with an end-of-central-directory marker.
// ---------------------------------------------------------------------------

type ZipEntry = { name: string; data: Buffer }

const DOS_TIME = 0
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1 // 1980-01-01

function zip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0) // local file header signature
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0x0800, 6) // flags: UTF-8 filename
    localHeader.writeUInt16LE(8, 8) // method: deflate
    localHeader.writeUInt16LE(DOS_TIME, 10)
    localHeader.writeUInt16LE(DOS_DATE, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(raw.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra length

    const localChunk = Buffer.concat([localHeader, nameBuf, compressed])
    localChunks.push(localChunk)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0) // central dir signature
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt16LE(DOS_TIME, 12)
    centralHeader.writeUInt16LE(DOS_DATE, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(raw.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32) // comment length
    centralHeader.writeUInt16LE(0, 34) // disk number
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42) // local header offset

    centralChunks.push(Buffer.concat([centralHeader, nameBuf]))
    offset += localChunk.length
  }

  const localBlob = Buffer.concat(localChunks)
  const centralBlob = Buffer.concat(centralChunks)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // disk
  eocd.writeUInt16LE(0, 6) // disk with cd
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBlob.length, 12)
  eocd.writeUInt32LE(localBlob.length, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([localBlob, centralBlob, eocd])
}
