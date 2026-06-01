import type { QboPullFn } from '@sitelayer/queue'
import { Sentry } from './instrument.js'
import { withFreshToken, type IntegrationConnectionTokens, type RefreshDeps } from './qbo-token-refresh.js'

// QBO REST integration for the reference-data PULL (QBO Customers + Items +
// Classes → sitelayer customers / service_items / integration_mappings).
//
// Mirrors createQboEstimatePush: same connection lookup, same withFreshToken
// proactive+reactive token refresh, same Sentry span shape. Inlined here
// because workers can't import apps/api code (separate workspace, separate
// runtime) — the upsert SQL below is ported VERBATIM from the inline pull in
// apps/api/src/routes/qbo.ts (POST /api/integrations/qbo/sync live branch), and
// the parse helpers mirror apps/api/src/qbo-parse.ts.
//
// Env knobs:
//   QBO_BASE_URL    sandbox or production base
//                   (default https://sandbox-quickbooks.api.intuit.com)
//
// Idempotency: every write is an on-conflict upsert keyed on
// (company_id, external_id) for customers, (company_id, code) for
// service_items, and (company_id, provider, entity_type, local_ref) for
// integration_mappings — so a full re-pull each run converges (version bumps,
// deleted_at cleared) without creating duplicates. v1 is a single-page full
// re-pull; QBO returns max ~1000 rows/page, so a >1000-row catalog needs
// STARTPOSITION pagination (live-smoke follow-up — the localhost mock can't
// prove real paging).
//
// This fn is allowed to THROW on any failure: processQboPull converts a throw
// into a failed outbox row with a 15-minute backoff. Per-row parse failures
// are tolerated (one malformed item/class is skipped, the rest still land) so
// a single bad row doesn't burn the backoff for the good rows — matching the
// inline /sync path's `parse_failed` tolerance.

class QboPullParseError extends Error {
  readonly raw: unknown
  constructor(message: string, raw: unknown) {
    super(message)
    this.name = 'QboPullParseError'
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

type ParsedItem = { id: string; name: string; unitPrice: number }
type ParsedClass = { id: string; name: string }

// Mirror of apps/api/src/qbo-parse.ts:parseQboItem.
function parseItem(raw: unknown): ParsedItem {
  if (!isObject(raw)) throw new QboPullParseError('QBO Item is not an object', raw)
  const id = pickString(raw, 'Id', 'id')
  if (!id) throw new QboPullParseError('QBO Item missing Id/id', raw)
  const name = pickString(raw, 'Name', 'name') ?? `qbo-${id}`
  const unitPrice = pickNumber(raw, 'UnitPrice', 'unitPrice') ?? 0
  return { id, name, unitPrice }
}

// Mirror of apps/api/src/qbo-parse.ts:parseQboClass.
function parseClass(raw: unknown): ParsedClass {
  if (!isObject(raw)) throw new QboPullParseError('QBO Class is not an object', raw)
  const id = pickString(raw, 'Id', 'id')
  const name = pickString(raw, 'Name', 'name')
  if (!id) throw new QboPullParseError('QBO Class missing Id/id', raw)
  if (!name) throw new QboPullParseError('QBO Class missing Name/name', raw)
  return { id, name }
}

type QboCustomerRaw = { Id?: string; DisplayName?: string; id?: string; displayName?: string }

/**
 * Build the live QBO reference-data pull fn. Returned fn is suitable to pass
 * to processQboPull (it receives the leased `client` and runs all writes on
 * it, so they commit / roll back with the per-row tx).
 */
export function createQboPull(refreshDeps: RefreshDeps = {}): QboPullFn {
  const baseUrl = process.env.QBO_BASE_URL ?? 'https://sandbox-quickbooks.api.intuit.com'
  const fetchImpl = refreshDeps.fetchImpl ?? fetch

  return async ({ client, companyId }) => {
    const conn = await client.query<IntegrationConnectionTokens>(
      `select id, provider_account_id, access_token, refresh_token, status, access_token_expires_at
       from integration_connections
       where company_id = $1 and provider = 'qbo' and deleted_at is null
       limit 1`,
      [companyId],
    )
    const connection = conn.rows[0]
    if (!connection?.provider_account_id) {
      throw new Error('qbo connection missing realm id')
    }
    if (connection.status !== 'connected') {
      throw new Error(`qbo connection status is ${connection.status}, refusing to pull`)
    }
    if (!connection.access_token && !connection.refresh_token) {
      throw new Error('qbo connection has neither access_token nor refresh_token; operator must reconnect')
    }
    const realmId = connection.provider_account_id

    // Run one QBO query through withFreshToken so proactive + reactive (401)
    // token refresh is handled identically to the push path.
    async function qboQuery<T>(query: string, kind: string): Promise<T> {
      const url = `${baseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`
      let attempt = 0
      return withFreshToken<T>(
        connection!,
        client,
        async (token) => {
          const a = attempt++
          return Sentry.startSpan(
            {
              name: 'qbo.request',
              op: 'http.client',
              attributes: {
                'http.url': url,
                'http.method': 'GET',
                'qbo.attempt': a,
                'qbo.kind': kind,
                company_id: companyId,
              },
            },
            async (span) => {
              const response = await fetchImpl(url, {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/json',
                },
              })
              span?.setAttribute('http.status_code', response.status)
              if (!response.ok) span?.setStatus({ code: 2, message: `qbo_${response.status}` })
              if (response.status === 401) {
                await response.text().catch(() => '')
                return { unauthorized: true as const }
              }
              if (!response.ok) {
                const errBody = await response.text()
                throw new Error(`qbo ${kind} query returned ${response.status}: ${errBody.slice(0, 500)}`)
              }
              return { unauthorized: false as const, value: (await response.json()) as T }
            },
          )
        },
        refreshDeps,
      )
    }

    // ---- Customers -------------------------------------------------------
    const customerResponse = await qboQuery<{ QueryResponse?: { Customer?: QboCustomerRaw[] } }>(
      'SELECT * FROM Customer',
      'pull_customers',
    )
    const qboCustomers = customerResponse.QueryResponse?.Customer ?? []
    const customerExternalIds: string[] = []
    const customerNames: string[] = []
    for (const qboCustomer of qboCustomers) {
      const externalId = String(qboCustomer.Id ?? qboCustomer.id ?? '')
      if (!externalId) continue
      const name = qboCustomer.DisplayName ?? qboCustomer.displayName ?? externalId
      customerExternalIds.push(externalId)
      customerNames.push(name)
    }
    let pulledCustomers = 0
    if (customerExternalIds.length > 0) {
      const upserted = await client.query<{ id: string; external_id: string; name: string }>(
        `
insert into customers (company_id, external_id, name, source)
select $1::uuid, t.external_id, t.name, 'qbo'
from unnest($2::text[], $3::text[]) as t(external_id, name)
on conflict (company_id, external_id) do update set name = excluded.name, updated_at = now()
returning id, external_id, name
`,
        [companyId, customerExternalIds, customerNames],
      )
      const localRefs: string[] = []
      const externalIds: string[] = []
      const labels: string[] = []
      for (const row of upserted.rows) {
        localRefs.push(row.id)
        externalIds.push(row.external_id)
        labels.push(row.name)
      }
      await client.query(
        `
insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
select $1::uuid, 'qbo', 'customer', local_ref, external_id, label, 'active', 'synced from qbo customer import'
from unnest($2::text[], $3::text[], $4::text[]) as t(local_ref, external_id, label)
on conflict (company_id, provider, entity_type, local_ref)
do update set
  external_id = excluded.external_id,
  label = excluded.label,
  status = excluded.status,
  notes = excluded.notes,
  version = integration_mappings.version + 1,
  updated_at = now(),
  deleted_at = null
`,
        [companyId, localRefs, externalIds, labels],
      )
      pulledCustomers = upserted.rows.length
    }

    // ---- Items -----------------------------------------------------------
    const itemResponse = await qboQuery<{ QueryResponse?: { Item?: unknown[] } }>(
      "SELECT * FROM Item WHERE Type IN ('Service', 'Inventory')",
      'pull_items',
    )
    const qboItemsRaw = itemResponse.QueryResponse?.Item ?? []
    const itemCodes: string[] = []
    const itemNames: string[] = []
    const itemPrices: string[] = []
    const itemExternalIds: string[] = []
    for (const rawItem of qboItemsRaw) {
      let item: ParsedItem
      try {
        item = parseItem(rawItem)
      } catch (e) {
        // Per-row tolerance: skip a malformed item and record a breadcrumb,
        // but keep pulling the rest (don't burn the 15-min backoff for the
        // good rows). Mirrors the inline /sync path's 'parse_failed' event.
        if (e instanceof QboPullParseError) {
          await client.query(
            `insert into sync_events (company_id, integration_connection_id, direction, entity_type, entity_id, payload, status, error)
             values ($1, $2, 'inbound', 'service_item', 'unknown', $3::jsonb, 'failed', $4)`,
            [
              companyId,
              connection.id,
              JSON.stringify({ action: 'parse_failed', provider: 'qbo', raw: e.raw }),
              e.message.slice(0, 1000),
            ],
          )
          continue
        }
        throw e
      }
      itemCodes.push(`qbo-${item.id}`)
      itemNames.push(item.name)
      itemPrices.push(String(item.unitPrice ?? 0))
      itemExternalIds.push(item.id)
    }
    let pulledItems = 0
    if (itemCodes.length > 0) {
      const upserted = await client.query<{ code: string; name: string }>(
        `
insert into service_items (company_id, code, name, default_rate, category, unit, source)
select $1::uuid, t.code, t.name, t.price::numeric, 'accounting', 'ea', 'qbo'
from unnest($2::text[], $3::text[], $4::text[]) as t(code, name, price)
on conflict (company_id, code) do update set
  name = excluded.name,
  default_rate = excluded.default_rate,
  source = 'qbo',
  updated_at = now()
returning code, name
`,
        [companyId, itemCodes, itemNames, itemPrices],
      )
      await client.query(
        `
insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
select $1::uuid, 'qbo', 'service_item', t.local_ref, t.external_id, t.label, 'active', 'backfilled from qbo service_item import'
from unnest($2::text[], $3::text[], $4::text[]) as t(local_ref, external_id, label)
on conflict (company_id, provider, entity_type, local_ref)
do update set
  external_id = excluded.external_id,
  label = excluded.label,
  status = excluded.status,
  notes = excluded.notes,
  version = integration_mappings.version + 1,
  updated_at = now(),
  deleted_at = null
`,
        [companyId, itemCodes, itemExternalIds, itemNames],
      )
      pulledItems = upserted.rows.length
    }

    // ---- Classes (→ divisions mapping) -----------------------------------
    const classResponse = await qboQuery<{ QueryResponse?: { Class?: unknown[] } }>(
      'SELECT * FROM Class',
      'pull_classes',
    )
    const qboClassesRaw = classResponse.QueryResponse?.Class ?? []
    const divisionsResult = await client.query<{ code: string; name: string }>(
      'select code, name from divisions where company_id = $1 order by sort_order asc',
      [companyId],
    )
    const divisionLocalRefs: string[] = []
    const divisionExternalIds: string[] = []
    const divisionLabels: string[] = []
    for (const rawClass of qboClassesRaw) {
      let qboClass: ParsedClass
      try {
        qboClass = parseClass(rawClass)
      } catch (e) {
        if (e instanceof QboPullParseError) {
          await client.query(
            `insert into sync_events (company_id, integration_connection_id, direction, entity_type, entity_id, payload, status, error)
             values ($1, $2, 'inbound', 'division', 'unknown', $3::jsonb, 'failed', $4)`,
            [
              companyId,
              connection.id,
              JSON.stringify({ action: 'parse_failed', provider: 'qbo', raw: e.raw }),
              e.message.slice(0, 1000),
            ],
          )
          continue
        }
        throw e
      }
      const division = divisionsResult.rows.find(
        (row) =>
          row.name.toLowerCase() === qboClass.name.toLowerCase() ||
          row.code.toLowerCase() === qboClass.name.toLowerCase(),
      )
      if (!division) continue
      divisionLocalRefs.push(division.code)
      divisionExternalIds.push(qboClass.id)
      divisionLabels.push(division.name)
    }
    let pulledClasses = 0
    if (divisionLocalRefs.length > 0) {
      await client.query(
        `
insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
select $1::uuid, 'qbo', 'division', t.local_ref, t.external_id, t.label, 'active', 'backfilled from qbo class sync'
from unnest($2::text[], $3::text[], $4::text[]) as t(local_ref, external_id, label)
on conflict (company_id, provider, entity_type, local_ref)
do update set
  external_id = excluded.external_id,
  label = excluded.label,
  status = excluded.status,
  notes = excluded.notes,
  version = integration_mappings.version + 1,
  updated_at = now(),
  deleted_at = null
`,
        [companyId, divisionLocalRefs, divisionExternalIds, divisionLabels],
      )
      pulledClasses = divisionLocalRefs.length
    }

    return { pulledCustomers, pulledItems, pulledClasses }
  }
}
