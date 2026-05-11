import { describe, expect, it, vi } from 'vitest'
import { PricingError, resolvePrice, resolvePrices, type PricingQueryRunner } from './pricing.js'

/**
 * In-memory fake of the pricing CTE query. The resolver issues exactly one
 * SQL round-trip that UNION ALLs every layer and orders by priority. We
 * model that here by computing the same "first matching layer" reduction
 * over the seeded layer rows so tests stay independent of the SQL text.
 */
type ChainSeedRow = {
  service_item_code: string
  rate: number | null
  unit: string
  source_id: string
}

interface ChainSeed {
  project?: Record<string, ChainSeedRow>
  customer?: Record<string, ChainSeedRow>
  company?: Record<string, ChainSeedRow>
  qbo?: Record<string, ChainSeedRow>
  fallback?: Record<string, ChainSeedRow>
}

const LAYER_PRIORITY: Record<string, number> = {
  project: 1,
  customer: 2,
  company: 3,
  qbo: 4,
  fallback: 5,
}

function buildPool(seed: ChainSeed): PricingQueryRunner {
  return {
    // The fake matches the resolver's parameters: $1=company, $2=project,
    // $3=customer (may be null), $4=service_item_code or text[].
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      const customerId = params?.[2] ?? null
      const codeParam = params?.[3]
      const codes = Array.isArray(codeParam) ? (codeParam as string[]) : [String(codeParam)]
      const isBatch = Array.isArray(codeParam) || sql.includes('row_number()')

      const layers: Array<keyof ChainSeed> = ['project', 'customer', 'company', 'qbo', 'fallback']
      const rows: Array<{
        service_item_code: string
        source: string
        source_id: string
        rate: number | null
        unit: string
        priority: number
      }> = []

      for (const code of codes) {
        let best: (typeof rows)[number] | null = null
        for (const layer of layers) {
          // The 'customer' layer only fires when customer_id is provided. Mirrors
          // the `$3::uuid is not null` guard in the SQL CTE.
          if (layer === 'customer' && !customerId) continue
          const seeded = seed[layer]?.[code]
          if (!seeded) continue
          const candidate = {
            service_item_code: code,
            source: layer,
            source_id: seeded.source_id,
            rate: seeded.rate,
            unit: seeded.unit,
            priority: LAYER_PRIORITY[layer]!,
          }
          if (!best || candidate.priority < best.priority) best = candidate
        }
        if (best) rows.push(best)
      }

      return { rows: isBatch ? rows : rows.slice(0, 1) }
    }) as unknown as PricingQueryRunner['query'],
  }
}

const companyId = 'c0000000-0000-0000-0000-000000000001'
const projectId = 'p0000000-0000-0000-0000-000000000001'
const customerId = 'cu000000-0000-0000-0000-000000000001'

describe('resolvePrice', () => {
  it('project override beats customer, company, qbo, and fallback', async () => {
    const pool = buildPool({
      project: { EPS: { service_item_code: 'EPS', rate: 9.99, unit: 'sqft', source_id: 'proj-1' } },
      customer: { EPS: { service_item_code: 'EPS', rate: 5, unit: 'sqft', source_id: 'cust-1' } },
      company: { EPS: { service_item_code: 'EPS', rate: 4, unit: 'sqft', source_id: 'co-1' } },
      qbo: { EPS: { service_item_code: 'EPS', rate: 3, unit: 'sqft', source_id: 'qbo-1' } },
      fallback: { EPS: { service_item_code: 'EPS', rate: 2, unit: 'sqft', source_id: 'svc-1' } },
    })
    const result = await resolvePrice({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: customerId,
      service_item_code: 'EPS',
    })
    expect(result).toEqual({ price: 9.99, unit: 'sqft', source: 'project', source_id: 'proj-1' })
  })

  it('customer override beats company, qbo, and fallback', async () => {
    const pool = buildPool({
      customer: { EPS: { service_item_code: 'EPS', rate: 5, unit: 'sqft', source_id: 'cust-1' } },
      company: { EPS: { service_item_code: 'EPS', rate: 4, unit: 'sqft', source_id: 'co-1' } },
      qbo: { EPS: { service_item_code: 'EPS', rate: 3, unit: 'sqft', source_id: 'qbo-1' } },
      fallback: { EPS: { service_item_code: 'EPS', rate: 2, unit: 'sqft', source_id: 'svc-1' } },
    })
    const result = await resolvePrice({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: customerId,
      service_item_code: 'EPS',
    })
    expect(result).toEqual({ price: 5, unit: 'sqft', source: 'customer', source_id: 'cust-1' })
  })

  it('skips the customer layer when no customer_id is supplied', async () => {
    // A project with `customer_id = null` (lead, pre-customer prospect)
    // must not fall through into the customer layer even if a row exists
    // for some other customer. The SQL CTE guards on `$3::uuid is not null`.
    const pool = buildPool({
      customer: { EPS: { service_item_code: 'EPS', rate: 5, unit: 'sqft', source_id: 'cust-1' } },
      company: { EPS: { service_item_code: 'EPS', rate: 4, unit: 'sqft', source_id: 'co-1' } },
    })
    const result = await resolvePrice({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: null,
      service_item_code: 'EPS',
    })
    expect(result.source).toBe('company')
    expect(result.price).toBe(4)
  })

  it('company override beats qbo and fallback', async () => {
    const pool = buildPool({
      company: { EPS: { service_item_code: 'EPS', rate: 4, unit: 'sqft', source_id: 'co-1' } },
      qbo: { EPS: { service_item_code: 'EPS', rate: 3, unit: 'sqft', source_id: 'qbo-1' } },
      fallback: { EPS: { service_item_code: 'EPS', rate: 2, unit: 'sqft', source_id: 'svc-1' } },
    })
    const result = await resolvePrice({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: customerId,
      service_item_code: 'EPS',
    })
    expect(result).toEqual({ price: 4, unit: 'sqft', source: 'company', source_id: 'co-1' })
  })

  it('qbo rate beats fallback', async () => {
    const pool = buildPool({
      qbo: { EPS: { service_item_code: 'EPS', rate: 3, unit: 'sqft', source_id: 'qbo-1' } },
      fallback: { EPS: { service_item_code: 'EPS', rate: 2, unit: 'sqft', source_id: 'svc-1' } },
    })
    const result = await resolvePrice({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: customerId,
      service_item_code: 'EPS',
    })
    expect(result).toEqual({ price: 3, unit: 'sqft', source: 'qbo', source_id: 'qbo-1' })
  })

  it('falls back to service_items.default_rate when no higher layer matches', async () => {
    const pool = buildPool({
      fallback: { EPS: { service_item_code: 'EPS', rate: 2.5, unit: 'sqft', source_id: 'svc-1' } },
    })
    const result = await resolvePrice({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: customerId,
      service_item_code: 'EPS',
    })
    expect(result).toEqual({ price: 2.5, unit: 'sqft', source: 'fallback', source_id: 'svc-1' })
  })

  it('returns price=0 when fallback row has a null default_rate', async () => {
    // accounting-category service items (Change Order, Deposit, ...) seed
    // with default_rate=null. We do not want the resolver to throw — the
    // line should price at zero and the operator overrides it.
    const pool = buildPool({
      fallback: { CO: { service_item_code: 'CO', rate: null, unit: 'job', source_id: 'svc-co' } },
    })
    const result = await resolvePrice({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: null,
      service_item_code: 'CO',
    })
    expect(result).toEqual({ price: 0, unit: 'job', source: 'fallback', source_id: 'svc-co' })
  })

  it('throws PricingError when no layer matches', async () => {
    const pool = buildPool({})
    await expect(
      resolvePrice({
        pool,
        company_id: companyId,
        project_id: projectId,
        customer_id: customerId,
        service_item_code: 'UNKNOWN',
      }),
    ).rejects.toBeInstanceOf(PricingError)
  })

  it('rejects empty service_item_code without hitting the database', async () => {
    const pool = buildPool({})
    await expect(
      resolvePrice({
        pool,
        company_id: companyId,
        project_id: projectId,
        customer_id: customerId,
        service_item_code: '   ',
      }),
    ).rejects.toThrow(PricingError)
    expect(pool.query).not.toHaveBeenCalled()
  })
})

describe('resolvePrices (batched)', () => {
  it('returns the highest-priority layer per code in one round-trip', async () => {
    const pool = buildPool({
      project: { EPS: { service_item_code: 'EPS', rate: 10, unit: 'sqft', source_id: 'proj-1' } },
      customer: { Basecoat: { service_item_code: 'Basecoat', rate: 6, unit: 'sqft', source_id: 'cust-1' } },
      fallback: {
        EPS: { service_item_code: 'EPS', rate: 2, unit: 'sqft', source_id: 'svc-eps' },
        Basecoat: { service_item_code: 'Basecoat', rate: 2.5, unit: 'sqft', source_id: 'svc-bc' },
        Flashing: { service_item_code: 'Flashing', rate: 8, unit: 'lf', source_id: 'svc-fl' },
      },
    })

    const map = await resolvePrices({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: customerId,
      service_item_codes: ['EPS', 'Basecoat', 'Flashing'],
    })

    expect(map.get('EPS')?.source).toBe('project')
    expect(map.get('EPS')?.price).toBe(10)
    expect(map.get('Basecoat')?.source).toBe('customer')
    expect(map.get('Basecoat')?.price).toBe(6)
    expect(map.get('Flashing')?.source).toBe('fallback')
    expect(map.get('Flashing')?.price).toBe(8)
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('skips the round-trip and returns an empty map when given no codes', async () => {
    const pool = buildPool({})
    const map = await resolvePrices({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: customerId,
      service_item_codes: [],
    })
    expect(map.size).toBe(0)
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('omits codes that resolve to nothing', async () => {
    // The batched form does not throw on unmatched codes — the caller is
    // expected to handle the "missing entry" case (e.g. estimate.ts treats
    // it as rate=0). Verifies the resolver doesn't synthesise a row for
    // missing codes.
    const pool = buildPool({
      fallback: { EPS: { service_item_code: 'EPS', rate: 2, unit: 'sqft', source_id: 'svc-eps' } },
    })
    const map = await resolvePrices({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: customerId,
      service_item_codes: ['EPS', 'GHOST'],
    })
    expect(map.has('EPS')).toBe(true)
    expect(map.has('GHOST')).toBe(false)
  })

  it('deduplicates codes before issuing the query', async () => {
    const pool = buildPool({
      fallback: { EPS: { service_item_code: 'EPS', rate: 2, unit: 'sqft', source_id: 'svc-eps' } },
    })
    await resolvePrices({
      pool,
      company_id: companyId,
      project_id: projectId,
      customer_id: customerId,
      service_item_codes: ['EPS', 'EPS', 'EPS'],
    })
    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, unknown[]]
    expect(call?.[1]?.[3]).toEqual(['EPS'])
  })
})
