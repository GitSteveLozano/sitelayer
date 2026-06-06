/**
 * Runtime validators for QuickBooks Online entity payloads.
 *
 * Intuit's REST API returns PascalCase field names in its production
 * responses, but our existing test mocks (and some legacy paths) use
 * camelCase. Rather than sprinkle `as any` field access at every call site,
 * each `parseQbo*` function accepts an `unknown` blob, normalizes the
 * casing, validates the required fields, and returns a typed struct.
 *
 * Failed validation throws `QboParseError` with the offending raw blob in
 * the message. Callers should catch and record it as a `sync_event` row
 * with status='failed' instead of silently dropping fields.
 */

import type {
  QboBill,
  QboClass,
  QboCustomer,
  QboEstimateCreateResponse,
  QboItem,
  QboVendor,
  RawQboBill,
  RawQboClass,
  RawQboCustomer,
  RawQboEstimateCreateResponse,
  RawQboItem,
  RawQboVendor,
} from './qbo-types.js'

export class QboParseError extends Error {
  readonly raw: unknown
  constructor(message: string, raw: unknown) {
    let preview: string
    try {
      const json = JSON.stringify(raw)
      preview = json === undefined ? String(raw) : json
    } catch {
      preview = String(raw)
    }
    if (preview.length > 500) preview = `${preview.slice(0, 500)}...`
    super(`${message} :: raw=${preview}`)
    this.name = 'QboParseError'
    this.raw = raw
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}

function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '') {
      const parsed = Number(v)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------

export function parseQboItem(raw: unknown): QboItem {
  if (!isObject(raw)) throw new QboParseError('QBO Item is not an object', raw)
  const r = raw as RawQboItem & Record<string, unknown>
  const id = pickString(r as Record<string, unknown>, 'Id', 'id')
  if (!id) throw new QboParseError('QBO Item missing Id/id', raw)
  const name = pickString(r as Record<string, unknown>, 'Name', 'name') ?? `qbo-${id}`
  const unitPrice = pickNumber(r as Record<string, unknown>, 'UnitPrice', 'unitPrice') ?? 0
  const type = pickString(r as Record<string, unknown>, 'Type', 'type')
  const out: QboItem = { id, name, unitPrice }
  if (type !== undefined) out.type = type
  return out
}

export function parseQboClass(raw: unknown): QboClass {
  if (!isObject(raw)) throw new QboParseError('QBO Class is not an object', raw)
  const r = raw as RawQboClass & Record<string, unknown>
  const id = pickString(r as Record<string, unknown>, 'Id', 'id')
  const name = pickString(r as Record<string, unknown>, 'Name', 'name')
  if (!id) throw new QboParseError('QBO Class missing Id/id', raw)
  if (!name) throw new QboParseError('QBO Class missing Name/name', raw)
  return { id, name }
}

export function parseQboCustomer(raw: unknown): QboCustomer {
  if (!isObject(raw)) throw new QboParseError('QBO Customer is not an object', raw)
  const r = raw as RawQboCustomer & Record<string, unknown>
  const id = pickString(r as Record<string, unknown>, 'Id', 'id')
  if (!id) throw new QboParseError('QBO Customer missing Id/id', raw)
  const displayName = pickString(r as Record<string, unknown>, 'DisplayName', 'displayName') ?? id
  return { id, displayName }
}

export function parseQboVendor(raw: unknown): QboVendor {
  if (!isObject(raw)) throw new QboParseError('QBO Vendor is not an object', raw)
  const r = raw as RawQboVendor & Record<string, unknown>
  const id = pickString(r as Record<string, unknown>, 'Id', 'id')
  if (!id) throw new QboParseError('QBO Vendor missing Id/id', raw)
  const displayName = pickString(r as Record<string, unknown>, 'DisplayName', 'displayName') ?? id
  return { id, displayName }
}

export function parseQboBill(raw: unknown): QboBill {
  if (!isObject(raw)) throw new QboParseError('QBO Bill is not an object', raw)
  const r = raw as RawQboBill & Record<string, unknown>
  const id = pickString(r as Record<string, unknown>, 'Id', 'id')
  if (!id) throw new QboParseError('QBO Bill missing Id/id', raw)
  const docNumber = pickString(r as Record<string, unknown>, 'DocNumber', 'docNumber')
  const totalAmt = pickNumber(r as Record<string, unknown>, 'TotalAmt', 'totalAmt')
  const out: QboBill = { id }
  if (docNumber !== undefined) out.docNumber = docNumber
  if (totalAmt !== undefined) out.totalAmt = totalAmt
  return out
}

/**
 * QBO estimate-create returns either `{ Estimate: { Id } }` (production) or a
 * flat `{ Id }` (sandbox/mock). Accept both.
 */
export function parseQboEstimateCreateResponse(raw: unknown): QboEstimateCreateResponse {
  if (!isObject(raw)) {
    throw new QboParseError('QBO Estimate response is not an object', raw)
  }
  const r = raw as RawQboEstimateCreateResponse & Record<string, unknown>

  // Prefer the wrapped form.
  const wrapped = r['Estimate'] ?? r['estimate']
  if (isObject(wrapped)) {
    const id = pickString(wrapped, 'Id', 'id')
    if (!id) throw new QboParseError('QBO Estimate response missing Estimate.Id', raw)
    const docNumber = pickString(wrapped, 'DocNumber', 'docNumber')
    const out: QboEstimateCreateResponse = { id }
    if (docNumber !== undefined) out.docNumber = docNumber
    return out
  }

  // Fall back to flat shape.
  const id = pickString(r as Record<string, unknown>, 'Id', 'id')
  if (!id) {
    throw new QboParseError('QBO Estimate response missing Id (no wrapped Estimate, no flat Id)', raw)
  }
  const docNumber = pickString(r as Record<string, unknown>, 'DocNumber', 'docNumber')
  const out: QboEstimateCreateResponse = { id }
  if (docNumber !== undefined) out.docNumber = docNumber
  return out
}
