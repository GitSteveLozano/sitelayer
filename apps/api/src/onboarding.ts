import type { PoolClient } from 'pg'
import { LA_SEED_TEMPLATE, resolveSeedTemplate, type AssemblyTemplate, type SeedTemplate } from '@sitelayer/domain'

export const COMPANY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/

export type SeedOptions = {
  includeSampleCustomers?: boolean
  /**
   * Which onboarding seed template stamps this tenant's divisions / service
   * items / pricing profile / assemblies. Accepts a template slug
   * (`'generic-construction'`, `'la-operations'`) or a resolved `SeedTemplate`.
   *
   * DEFAULT — when omitted — is the **LA** template, NOT the generic default,
   * so every legacy 2-arg caller (the scenario engine, golden replay test, and
   * admin scenarios, which all invoke `seedCompanyDefaults(client, companyId)`)
   * keeps seeding L&A Operations' original reference data unchanged. The
   * multi-tenant onboarding paths (`POST /api/companies`,
   * `scripts/provision-company.sh`) pass the GENERIC template explicitly so
   * company #2..#N is NOT mis-seeded with LA's stucco/EIFS divisions. See
   * `DEFAULT_SEED_TEMPLATE_SLUG` in @sitelayer/domain for the generic slug.
   */
  template?: string | SeedTemplate
}

/** Resolve a SeedOptions.template (slug or object) to a concrete SeedTemplate. */
export function resolveTemplateOption(template?: string | SeedTemplate): SeedTemplate {
  if (template && typeof template === 'object') return template
  if (typeof template === 'string') return resolveSeedTemplate(template).template
  // Omitted → backward-compatible LA seed (protects the legacy 2-arg callers).
  return LA_SEED_TEMPLATE
}

export async function seedCompanyDefaults(
  client: PoolClient,
  companyId: string,
  options: SeedOptions = {},
): Promise<void> {
  const template = resolveTemplateOption(options.template)

  for (const division of template.divisions) {
    await client.query(
      `insert into divisions (company_id, code, name, sort_order)
       values ($1, $2, $3, $4)
       on conflict (company_id, code) do nothing`,
      [companyId, division.code, division.name, division.sortOrder],
    )
  }

  for (const item of template.serviceItems) {
    await client.query(
      `insert into service_items (company_id, code, name, category, unit, default_rate)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (company_id, code) do nothing`,
      [companyId, item.code, item.name, item.category, item.unit, item.defaultRate],
    )
    // Seed the curated catalog xref so takeoffs can immediately validate
    // the (service_item, division) pair without an admin manually configuring
    // every item. See `assertDivisionAllowedForServiceItem` in
    // apps/api/src/server.ts and migration 011.
    await client.query(
      `insert into service_item_divisions (company_id, service_item_code, division_code)
       values ($1, $2, $3)
       on conflict (company_id, service_item_code, division_code) do nothing`,
      [companyId, item.code, item.defaultDivisionCode],
    )
  }

  // Stamp the pricing profile's `template` tag with the slug that seeded it so
  // the company's provenance is traceable after the fact (markup.ts reads it).
  await client.query(
    `insert into pricing_profiles (company_id, name, is_default, config)
     select $1, 'Default', true, jsonb_build_object('template', $2::text)
     where not exists (
       select 1 from pricing_profiles
       where company_id = $1 and name = 'Default' and deleted_at is null
     )`,
    [companyId, template.slug],
  )

  await client.query(
    `insert into bonus_rules (company_id, name, config, is_active)
     select $1, 'Default Margin Bonus', '{"basis":"margin","threshold":0.15}'::jsonb, true
     where not exists (
       select 1 from bonus_rules
       where company_id = $1 and name = 'Default Margin Bonus' and deleted_at is null
     )`,
    [companyId],
  )

  // Seed a default yard location so the inventory movement UI has something
  // to deliver from / return to out of the box. The unique partial index
  // inventory_locations_one_default_idx enforces "one default per company"
  // so this is safe to re-run.
  await client.query(
    `insert into inventory_locations (company_id, name, location_type, is_default)
     select $1, 'Yard', 'yard', true
     where not exists (
       select 1 from inventory_locations
       where company_id = $1 and is_default = true and deleted_at is null
     )`,
    [companyId],
  )

  if (options.includeSampleCustomers) {
    await client.query(
      `insert into customers (company_id, name, source)
       values ($1, 'Sample Customer', 'seed')
       on conflict do nothing`,
      [companyId],
    )
  }

  // Seed the template's assembly starter pack last — assemblies reference
  // service_item_codes, so the service_items loop above must run first. The
  // generic template ships ZERO assemblies (its `assemblies` array is empty),
  // so a fresh tenant is not seeded with LA's stucco/EIFS cladding pack.
  await seedAssemblyTemplates(client, companyId, template.assemblies)
}

/**
 * Seed a list of assembly templates for a company: per-unit assemblies, each
 * with flat material/labor/sub components and per-component waste.
 *
 * Idempotent + tenant-scoped: each header is guarded by a `WHERE NOT EXISTS`
 * on (company_id, name) so re-running onboarding never duplicates, and a
 * company that already has a same-named assembly (e.g. hand-edited by the
 * pilot) is left untouched (components are only inserted for headers this call
 * actually creates). The cached header `total_rate` is computed here with the
 * SAME expression recomputeAssemblyTotal uses
 * (sum(quantity_per_unit * (1 + waste_pct/100) * unit_cost)) so no extra
 * recompute pass is needed.
 *
 * The LA seed template threads `EXTERIOR_CLADDING_PACK` (shared with the LA
 * Operations backfill in migration 110); the generic template threads `[]`
 * (no assemblies) so a fresh tenant is not seeded with another trade's pack.
 */
export async function seedAssemblyTemplates(
  client: PoolClient,
  companyId: string,
  assemblies: ReadonlyArray<AssemblyTemplate>,
): Promise<void> {
  for (const assembly of assemblies) {
    const totalRate = assembly.components.reduce(
      (sum, c) => sum + c.quantityPerUnit * (1 + c.wastePct / 100) * c.unitCost,
      0,
    )

    // Insert the header only if this company has no assembly with this name.
    // RETURNING id is empty when the guard short-circuits (already present),
    // so component inserts are skipped for an existing header.
    const headerResult = await client.query<{ id: string }>(
      `insert into service_item_assemblies
         (company_id, service_item_code, name, description, total_rate, unit)
       select $1, $2, $3, $4, $5, $6
       where not exists (
         select 1 from service_item_assemblies
         where company_id = $1 and name = $3 and deleted_at is null
       )
       returning id`,
      [companyId, assembly.serviceItemCode, assembly.name, assembly.description, totalRate, assembly.unit],
    )
    const assemblyId = headerResult.rows[0]?.id
    if (!assemblyId) continue

    let sortOrder = 0
    for (const component of assembly.components) {
      await client.query(
        `insert into service_item_assembly_components
           (company_id, assembly_id, kind, name, quantity_per_unit, unit, unit_cost, waste_pct, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          companyId,
          assemblyId,
          component.kind,
          component.name,
          component.quantityPerUnit,
          component.unit,
          component.unitCost,
          component.wastePct,
          sortOrder,
        ],
      )
      sortOrder += 1
    }
  }
}

/**
 * Backward-compatible alias: seed the LA Operations exterior-cladding pack
 * (`EXTERIOR_CLADDING_PACK`). Retained so callers that imported the original
 * name keep working; new code seeds whatever pack a template threads via
 * `seedAssemblyTemplates`.
 */
export async function seedExteriorCladdingAssemblies(client: PoolClient, companyId: string): Promise<void> {
  await seedAssemblyTemplates(client, companyId, LA_SEED_TEMPLATE.assemblies)
}
