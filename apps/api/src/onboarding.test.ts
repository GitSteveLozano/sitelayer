import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import {
  GENERIC_SEED_TEMPLATE,
  LA_SEED_TEMPLATE,
  DEFAULT_SEED_TEMPLATE_SLUG,
  resolveSeedTemplate,
} from '@sitelayer/domain'
import { resolveTemplateOption, seedCompanyDefaults } from './onboarding.js'

/**
 * Onboarding seed-template tests. Two layers:
 *
 *  1. Pure unit coverage of the template resolution (`resolveSeedTemplate`,
 *     `resolveTemplateOption`) — always runs.
 *  2. Real-DB integration coverage (gated on RUN_API_INTEGRATION=1, run by
 *     scripts/verify-local.sh against the throwaway docker-postgres) that
 *     `seedCompanyDefaults` seeds the GENERIC template for a new tenant (NOT
 *     L&A's divisions), still seeds LA when asked, is idempotent, and that two
 *     companies seeded back-to-back are fully tenant-isolated.
 *
 * This is the strict-multi-tenancy proof for company #2..#N onboarding.
 */

// ---- Layer 1: pure unit coverage (no DB) ----------------------------------

describe('seed template resolution', () => {
  it('defaults an omitted/empty/unknown slug to the generic construction template', () => {
    expect(resolveSeedTemplate(undefined).template.slug).toBe('generic-construction')
    expect(resolveSeedTemplate(undefined).matched).toBe(false)
    expect(resolveSeedTemplate('').template.slug).toBe('generic-construction')
    expect(resolveSeedTemplate('   ').template.slug).toBe('generic-construction')
    expect(resolveSeedTemplate('no-such-trade').template.slug).toBe('generic-construction')
    expect(resolveSeedTemplate('no-such-trade').matched).toBe(false)
  })

  it('resolves known slugs (case-insensitive) and reports a match', () => {
    expect(resolveSeedTemplate('la-operations').template.slug).toBe('la-operations')
    expect(resolveSeedTemplate('LA-Operations').template.slug).toBe('la-operations')
    expect(resolveSeedTemplate('la-operations').matched).toBe(true)
    expect(resolveSeedTemplate('generic-construction').template.slug).toBe('generic-construction')
    expect(resolveSeedTemplate('generic-construction').matched).toBe(true)
  })

  it('DEFAULT_SEED_TEMPLATE_SLUG is the generic (trade-neutral) template', () => {
    expect(DEFAULT_SEED_TEMPLATE_SLUG).toBe('generic-construction')
    expect(GENERIC_SEED_TEMPLATE.assemblies).toHaveLength(0)
    // The generic template must not carry any of LA's trade-specific divisions.
    const genericDivisionNames = new Set(GENERIC_SEED_TEMPLATE.divisions.map((d) => d.name))
    expect(genericDivisionNames.has('Stucco')).toBe(false)
    expect(genericDivisionNames.has('EIFS')).toBe(false)
    // LA template keeps its stucco/EIFS divisions + cladding assemblies.
    const laDivisionNames = new Set(LA_SEED_TEMPLATE.divisions.map((d) => d.name))
    expect(laDivisionNames.has('Stucco')).toBe(true)
    expect(laDivisionNames.has('EIFS')).toBe(true)
    expect(LA_SEED_TEMPLATE.assemblies.length).toBeGreaterThan(0)
  })

  it('resolveTemplateOption: object passes through, string resolves, omitted = LA (legacy 2-arg callers)', () => {
    // An omitted template preserves the historical LA seed for the scenario
    // engine / golden replay / admin scenarios that call seedCompanyDefaults
    // with 2 args.
    expect(resolveTemplateOption(undefined).slug).toBe('la-operations')
    expect(resolveTemplateOption('generic-construction').slug).toBe('generic-construction')
    expect(resolveTemplateOption('la-operations').slug).toBe('la-operations')
    expect(resolveTemplateOption('bogus').slug).toBe('generic-construction')
    expect(resolveTemplateOption(GENERIC_SEED_TEMPLATE)).toBe(GENERIC_SEED_TEMPLATE)
  })
})

// ---- Layer 2: real-DB integration -----------------------------------------

const describeIntegration = process.env.RUN_API_INTEGRATION === '1' ? describe : describe.skip
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'

describeIntegration('seedCompanyDefaults (multi-tenant onboarding)', () => {
  let pool: Pool
  const createdCompanyIds: string[] = []

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
  })

  afterAll(async () => {
    if (!pool) return
    const swallow = async (sql: string, params: unknown[] = []) => {
      try {
        await pool.query(sql, params)
      } catch {
        // best-effort teardown
      }
    }
    if (createdCompanyIds.length > 0) {
      // Teardown ordering matters because of the `company_bootstrap_state` bump
      // triggers (migration 014): an AFTER DELETE statement trigger on
      // divisions / service_items / pricing_profiles / bonus_rules re-INSERTs a
      // company_bootstrap_state row for the affected company. If we relied on
      // `DELETE FROM companies` cascading into those tables, that re-insert
      // would reference a company being deleted in the SAME statement and the
      // deferred FK check would abort the whole delete (leaking the company).
      // So: (1) delete the seeded children explicitly WHILE the company still
      // exists (the bump trigger re-inserts harmlessly), then (2) clear
      // company_bootstrap_state, then (3) delete the company — whose cascade now
      // has nothing left in a bump-triggered table to re-fire.
      const ids = createdCompanyIds
      for (const table of [
        'service_item_assembly_components',
        'service_item_assemblies',
        'service_item_divisions',
        'service_items',
        'divisions',
        'pricing_profiles',
        'bonus_rules',
        'inventory_locations',
        'company_memberships',
      ]) {
        await swallow(`delete from ${table} where company_id = any($1::uuid[])`, [ids])
      }
      await swallow('delete from company_bootstrap_state where company_id = any($1::uuid[])', [ids])
      await swallow('delete from companies where id = any($1::uuid[])', [ids])
    }
    await pool.end()
  })

  async function makeCompany(slugPrefix: string): Promise<string> {
    const id = randomUUID()
    await pool.query('insert into companies (id, slug, name) values ($1, $2, $3)', [
      id,
      `${slugPrefix}-${id.slice(0, 8)}`,
      `Onboarding Test ${slugPrefix}`,
    ])
    createdCompanyIds.push(id)
    return id
  }

  async function seedIn(companyId: string, template?: string): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])
      await seedCompanyDefaults(client, companyId, template !== undefined ? { template } : {})
      await client.query('commit')
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async function divisionNames(companyId: string): Promise<string[]> {
    const r = await pool.query<{ name: string }>(
      'select name from divisions where company_id = $1 order by sort_order',
      [companyId],
    )
    return r.rows.map((row) => row.name)
  }

  async function count(table: string, companyId: string): Promise<number> {
    const r = await pool.query<{ n: string }>(`select count(*)::int n from ${table} where company_id = $1`, [companyId])
    return Number(r.rows[0]?.n ?? 0)
  }

  async function defaultTemplateTag(companyId: string): Promise<string | null> {
    const r = await pool.query<{ template: string | null }>(
      `select config->>'template' as template from pricing_profiles
       where company_id = $1 and name = 'Default' and deleted_at is null limit 1`,
      [companyId],
    )
    return r.rows[0]?.template ?? null
  }

  it('GENERIC template seeds trade-neutral divisions, no LA divisions, no assemblies', async () => {
    const companyId = await makeCompany('generic')
    await seedIn(companyId, 'generic-construction')

    const names = await divisionNames(companyId)
    // Generic, trade-neutral divisions present...
    expect(names).toContain('General Requirements')
    expect(names).toContain('Framing')
    // ...and NONE of L&A's trade-specific divisions.
    expect(names).not.toContain('Stucco')
    expect(names).not.toContain('EIFS')
    expect(names).not.toContain('Cultured Stone')

    expect(names).toHaveLength(GENERIC_SEED_TEMPLATE.divisions.length)
    expect(await count('service_items', companyId)).toBe(GENERIC_SEED_TEMPLATE.serviceItems.length)
    // Generic template ships ZERO assemblies — a fresh tenant isn't seeded with
    // LA's stucco/EIFS cladding pack.
    expect(await count('service_item_assemblies', companyId)).toBe(0)
    // Pricing profile is tagged with the template slug for provenance.
    expect(await defaultTemplateTag(companyId)).toBe('generic-construction')
    // Default yard + bonus rule still seeded (template-independent).
    expect(await count('inventory_locations', companyId)).toBe(1)
    expect(await count('bonus_rules', companyId)).toBe(1)
  })

  it('LA template still seeds LA divisions + the exterior-cladding pack', async () => {
    const companyId = await makeCompany('la')
    await seedIn(companyId, 'la-operations')

    const names = await divisionNames(companyId)
    expect(names).toContain('Stucco')
    expect(names).toContain('EIFS')
    expect(names).toHaveLength(LA_SEED_TEMPLATE.divisions.length)
    expect(await count('service_item_assemblies', companyId)).toBe(LA_SEED_TEMPLATE.assemblies.length)
    expect(await defaultTemplateTag(companyId)).toBe('la-operations')
  })

  it('omitted template defaults to LA (backward-compat for legacy 2-arg callers)', async () => {
    const companyId = await makeCompany('legacy')
    await seedIn(companyId) // no template arg → seedCompanyDefaults(client, id, {})

    const names = await divisionNames(companyId)
    expect(names).toContain('Stucco')
    expect(await defaultTemplateTag(companyId)).toBe('la-operations')
  })

  it('two companies seeded back-to-back are fully tenant-isolated', async () => {
    const generic = await makeCompany('iso-generic')
    const la = await makeCompany('iso-la')
    await seedIn(generic, 'generic-construction')
    await seedIn(la, 'la-operations')

    // Each company sees only its own divisions/service items.
    const genericNames = await divisionNames(generic)
    const laNames = await divisionNames(la)
    expect(genericNames).toContain('Framing')
    expect(genericNames).not.toContain('Stucco')
    expect(laNames).toContain('Stucco')
    expect(laNames).not.toContain('Framing')

    // No cross-tenant bleed: counts match each template exactly.
    expect(await count('divisions', generic)).toBe(GENERIC_SEED_TEMPLATE.divisions.length)
    expect(await count('divisions', la)).toBe(LA_SEED_TEMPLATE.divisions.length)
    expect(await count('service_item_assemblies', generic)).toBe(0)
    expect(await count('service_item_assemblies', la)).toBe(LA_SEED_TEMPLATE.assemblies.length)
    expect(await defaultTemplateTag(generic)).toBe('generic-construction')
    expect(await defaultTemplateTag(la)).toBe('la-operations')
  })

  it('re-seeding the same company with the same template is idempotent', async () => {
    const companyId = await makeCompany('idem')
    await seedIn(companyId, 'generic-construction')
    const before = {
      divisions: await count('divisions', companyId),
      serviceItems: await count('service_items', companyId),
      assemblies: await count('service_item_assemblies', companyId),
      pricingProfiles: await count('pricing_profiles', companyId),
      bonusRules: await count('bonus_rules', companyId),
      yards: await count('inventory_locations', companyId),
    }
    await seedIn(companyId, 'generic-construction')
    const after = {
      divisions: await count('divisions', companyId),
      serviceItems: await count('service_items', companyId),
      assemblies: await count('service_item_assemblies', companyId),
      pricingProfiles: await count('pricing_profiles', companyId),
      bonusRules: await count('bonus_rules', companyId),
      yards: await count('inventory_locations', companyId),
    }
    expect(after).toEqual(before)
  })

  it('an unknown template slug falls back to the generic seed (never throws)', async () => {
    const companyId = await makeCompany('unknown')
    await seedIn(companyId, 'roofing-galaxy-brain')
    const names = await divisionNames(companyId)
    expect(names).toContain('General Requirements')
    expect(names).not.toContain('Stucco')
    expect(await defaultTemplateTag(companyId)).toBe('generic-construction')
  })
})
