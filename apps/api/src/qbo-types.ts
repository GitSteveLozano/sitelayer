/**
 * Typed shapes for QuickBooks Online entities Sitelayer reads from Intuit's
 * REST API. Intuit returns PascalCase on most "real" responses but some
 * mock/legacy callers use camelCase, so each raw shape accepts both.
 *
 * The `Qbo*` types are the *normalized* structs callers should consume:
 * stable field names regardless of upstream casing. Raw shapes live next to
 * them as `Raw*` and are only used by the parsers in `qbo-parse.ts`.
 */

// ---------------------------------------------------------------------------
// Item (Service / Inventory)
// ---------------------------------------------------------------------------

export type RawQboItem = {
  Id?: string | number
  Name?: string
  UnitPrice?: number | string
  Type?: string
  // legacy / camelCase variant
  id?: string | number
  name?: string
  unitPrice?: number | string
  type?: string
}

export type QboItem = {
  id: string
  name: string
  unitPrice: number
  type?: string
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export type RawQboClass = {
  Id?: string | number
  Name?: string
  id?: string | number
  name?: string
}

export type QboClass = {
  id: string
  name: string
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export type RawQboCustomer = {
  Id?: string | number
  DisplayName?: string
  id?: string | number
  displayName?: string
}

export type QboCustomer = {
  id: string
  displayName: string
}

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------

export type RawQboVendor = {
  Id?: string | number
  DisplayName?: string
  id?: string | number
  displayName?: string
}

export type QboVendor = {
  id: string
  displayName: string
}

// ---------------------------------------------------------------------------
// Bill (response shape after creation)
// ---------------------------------------------------------------------------

export type RawQboBill = {
  Id?: string | number
  DocNumber?: string
  TotalAmt?: number | string
  id?: string | number
  docNumber?: string
  totalAmt?: number | string
}

export type QboBill = {
  id: string
  docNumber?: string
  totalAmt?: number
}

// ---------------------------------------------------------------------------
// Estimate-create response
//
// QBO returns the body as either `{ Estimate: { Id } }` (production) or
// occasionally as a flat `{ Id }` (mock, sandbox legacy). We accept both.
// ---------------------------------------------------------------------------

export type RawQboEstimateCreateResponse = {
  Estimate?: {
    Id?: string | number
    DocNumber?: string
    id?: string | number
    docNumber?: string
  }
  // flat / legacy variant
  Id?: string | number
  DocNumber?: string
  id?: string | number
  docNumber?: string
}

export type QboEstimateCreateResponse = {
  id: string
  docNumber?: string
}
