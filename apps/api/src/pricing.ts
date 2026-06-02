import type { Pool, PoolClient } from 'pg'

/**
 * Pricing chain resolver.
 *
 * For a (company, project, customer?, service_item_code) tuple, walk the
 * override chain in priority order and return the first match:
 *
 *   1. project_pricing_overrides    — per-project rate cards (highest)
 *   2. customer_pricing_overrides   — per-customer rate cards
 *   3. company_pricing_overrides    — company-wide override
 *   4. qbo item rate                — `service_items` row mapped to a QBO
 *                                     `Item` via integration_mappings; the
 *                                     QBO sync writes `UnitPrice` into
 *                                     `service_items.default_rate` so we
 *                                     read that value here.
 *   5. fallback                     — `service_items.default_rate` for the
 *                                     non-qbo case (manual / template
 *                                     seeded rows). If even that is null,
 *                                     `price` is 0 and `source` stays
 *                                     `fallback` so callers see a clean
 *                                     "no rate configured" without
 *                                     crashing.
 *   6. cost_library (NEW, lowest)   — the shared trade cost library
 *                                     (`cost_library_items`, migration 140,
 *                                     Deep Dive M5). Matched on `code`,
 *                                     preferring the company's own imported
 *                                     rows over shared (NULL-company) catalog
 *                                     rows; the rate is the sum of
 *                                     material_rate + labor_rate. This sits
 *                                     strictly BELOW the existing chain so it
 *                                     only supplies a price for a code with no
 *                                     override and no `service_items` row at
 *                                     all — when the library is empty (and on
 *                                     every existing company) nothing changes.
 *
 * The chain is computed in a single SQL round-trip with a CTE per layer
 * so a batch of N measurements pays N×1 query cost, not N×5.
 *
 * Money convention: rates are stored as Postgres `numeric(12,2)` and
 * returned as JS numbers (dollars). Matches the rest of the codebase
 * (`estimate_lines.rate`, `service_items.default_rate`, etc.).
 */

export type PriceSource = 'project' | 'customer' | 'company' | 'qbo' | 'fallback' | 'cost_library'

export interface PriceResolution {
  price: number
  unit: string
  source: PriceSource
  /** id of the row that matched the chain (override row id, service_items.id, etc.). */
  source_id?: string
}

export type PricingQueryRunner = Pick<Pool | PoolClient, 'query'>

export class PricingError extends Error {
  constructor(
    message: string,
    public code: 'service_item_not_found',
  ) {
    super(message)
    this.name = 'PricingError'
  }
}

interface ResolveArgs {
  pool: PricingQueryRunner
  company_id: string
  project_id: string
  customer_id?: string | null
  service_item_code: string
}

type ChainRow = {
  source: PriceSource
  source_id: string
  rate: string | number | null
  unit: string | null
}

/**
 * Resolve the price for a single (project, customer?, service_item_code).
 *
 * Throws `PricingError('service_item_not_found')` when the service_item_code
 * does not exist for the company AND no override at any layer matches.
 * That distinction matters: if a project override is configured for a
 * code that was later removed from `service_items`, the override still
 * wins — the resolver is faithfully reflecting what the operator
 * configured. Only when nothing in any layer matches do we surface an
 * error so the caller can decide whether to fall back to zero or reject
 * the estimate.
 */
export async function resolvePrice(args: ResolveArgs): Promise<PriceResolution> {
  const { pool, company_id, project_id, customer_id, service_item_code } = args
  const code = service_item_code.trim()
  if (!code) {
    throw new PricingError('service_item_code is required', 'service_item_not_found')
  }

  // One round-trip: UNION ALL across the five layers, ordered by priority,
  // first row wins. Each layer projects a `priority` constant so we can
  // `ORDER BY priority` deterministically even if multiple match.
  const result = await pool.query<ChainRow & { priority: number }>(
    `
    with project_layer as (
      select 1 as priority, 'project'::text as source, id::text as source_id, rate, unit
      from project_pricing_overrides
      where company_id = $1
        and project_id = $2
        and service_item_code = $4
        and deleted_at is null
      limit 1
    ),
    customer_layer as (
      select 2 as priority, 'customer'::text as source, id::text as source_id, rate, unit
      from customer_pricing_overrides
      where company_id = $1
        and customer_id = $3::uuid
        and service_item_code = $4
        and deleted_at is null
        and $3::uuid is not null
      limit 1
    ),
    company_layer as (
      select 3 as priority, 'company'::text as source, id::text as source_id, rate, unit
      from company_pricing_overrides
      where company_id = $1
        and service_item_code = $4
        and deleted_at is null
      limit 1
    ),
    qbo_layer as (
      select 4 as priority, 'qbo'::text as source, si.id::text as source_id,
             si.default_rate as rate, si.unit
      from service_items si
      join integration_mappings im
        on im.company_id = si.company_id
       and im.provider = 'qbo'
       and im.entity_type = 'service_item'
       and im.local_ref = si.code
       and im.status = 'active'
       and im.deleted_at is null
      where si.company_id = $1
        and si.code = $4
        and si.deleted_at is null
        and si.default_rate is not null
      limit 1
    ),
    fallback_layer as (
      select 5 as priority, 'fallback'::text as source, id::text as source_id,
             default_rate as rate, unit
      from service_items
      where company_id = $1
        and code = $4
        and deleted_at is null
      limit 1
    ),
    -- Layer 6 (lowest): shared trade cost library. Matched on code,
    -- preferring the company's own imported rows over shared (NULL-company)
    -- catalog rows. The rate is material_rate + labor_rate (either may be
    -- null → coalesced to 0). Only reached when no service_item / override
    -- exists for the code, so it never changes an existing resolution.
    cost_library_layer as (
      select 6 as priority, 'cost_library'::text as source, id::text as source_id,
             (coalesce(material_rate, 0) + coalesce(labor_rate, 0)) as rate, unit
      from cost_library_items
      where (company_id = $1 or company_id is null)
        and code = $4
        and deleted_at is null
      order by (company_id is null) asc, updated_at desc
      limit 1
    )
    select priority, source, source_id, rate, unit from project_layer
    union all
    select priority, source, source_id, rate, unit from customer_layer
    union all
    select priority, source, source_id, rate, unit from company_layer
    union all
    select priority, source, source_id, rate, unit from qbo_layer
    union all
    select priority, source, source_id, rate, unit from fallback_layer
    union all
    select priority, source, source_id, rate, unit from cost_library_layer
    order by priority asc
    limit 1
    `,
    [company_id, project_id, customer_id ?? null, code],
  )

  const row = result.rows[0]
  if (!row) {
    throw new PricingError(`service item not found: ${code}`, 'service_item_not_found')
  }

  const rate = row.rate == null ? 0 : Number(row.rate)
  return {
    price: Number.isFinite(rate) ? rate : 0,
    unit: row.unit ?? '',
    source: row.source as PriceSource,
    source_id: row.source_id,
  }
}

/**
 * Batched version of `resolvePrice` for callers that need to price a
 * list of measurements at once (e.g. recompute). Issues a single query
 * with `service_item_code = ANY($4)` instead of N round-trips.
 *
 * Returns a Map keyed by service_item_code. Codes that have no
 * resolution are absent from the map — the caller decides whether
 * that's an error.
 */
export async function resolvePrices(args: {
  pool: PricingQueryRunner
  company_id: string
  project_id: string
  customer_id?: string | null
  service_item_codes: readonly string[]
}): Promise<Map<string, PriceResolution>> {
  const { pool, company_id, project_id, customer_id, service_item_codes } = args
  const codes = Array.from(new Set(service_item_codes.map((c) => c.trim()).filter(Boolean)))
  const result = new Map<string, PriceResolution>()
  if (codes.length === 0) return result

  const rows = await pool.query<ChainRow & { priority: number; service_item_code: string }>(
    `
    with codes as (
      select unnest($4::text[]) as service_item_code
    ),
    project_layer as (
      select 1 as priority, 'project'::text as source, id::text as source_id,
             rate, unit, service_item_code
      from project_pricing_overrides
      where company_id = $1
        and project_id = $2
        and service_item_code = any($4::text[])
        and deleted_at is null
    ),
    customer_layer as (
      select 2 as priority, 'customer'::text as source, id::text as source_id,
             rate, unit, service_item_code
      from customer_pricing_overrides
      where company_id = $1
        and customer_id = $3::uuid
        and service_item_code = any($4::text[])
        and deleted_at is null
        and $3::uuid is not null
    ),
    company_layer as (
      select 3 as priority, 'company'::text as source, id::text as source_id,
             rate, unit, service_item_code
      from company_pricing_overrides
      where company_id = $1
        and service_item_code = any($4::text[])
        and deleted_at is null
    ),
    qbo_layer as (
      select 4 as priority, 'qbo'::text as source, si.id::text as source_id,
             si.default_rate as rate, si.unit, si.code as service_item_code
      from service_items si
      join integration_mappings im
        on im.company_id = si.company_id
       and im.provider = 'qbo'
       and im.entity_type = 'service_item'
       and im.local_ref = si.code
       and im.status = 'active'
       and im.deleted_at is null
      where si.company_id = $1
        and si.code = any($4::text[])
        and si.deleted_at is null
        and si.default_rate is not null
    ),
    fallback_layer as (
      select 5 as priority, 'fallback'::text as source, id::text as source_id,
             default_rate as rate, unit, code as service_item_code
      from service_items
      where company_id = $1
        and code = any($4::text[])
        and deleted_at is null
    ),
    -- Layer 6 (lowest): shared trade cost library. distinct on (lower(code))
    -- with the company-first ordering collapses any (company row, shared row)
    -- pair for the same code down to the company's own row before it competes
    -- with the higher layers. material_rate + labor_rate is the unit rate.
    cost_library_layer as (
      select distinct on (lower(code))
             6 as priority, 'cost_library'::text as source, id::text as source_id,
             (coalesce(material_rate, 0) + coalesce(labor_rate, 0)) as rate, unit, code as service_item_code
      from cost_library_items
      where (company_id = $1 or company_id is null)
        and code = any($4::text[])
        and deleted_at is null
      order by lower(code), (company_id is null) asc, updated_at desc
    ),
    all_layers as (
      select * from project_layer
      union all select * from customer_layer
      union all select * from company_layer
      union all select * from qbo_layer
      union all select * from fallback_layer
      union all select * from cost_library_layer
    ),
    ranked as (
      select service_item_code, source, source_id, rate, unit, priority,
             row_number() over (partition by service_item_code order by priority asc) as rn
      from all_layers
    )
    select service_item_code, source, source_id, rate, unit
    from ranked
    where rn = 1
    `,
    [company_id, project_id, customer_id ?? null, codes],
  )

  for (const row of rows.rows) {
    const rate = row.rate == null ? 0 : Number(row.rate)
    result.set(row.service_item_code, {
      price: Number.isFinite(rate) ? rate : 0,
      unit: row.unit ?? '',
      source: row.source,
      source_id: row.source_id,
    })
  }
  return result
}
