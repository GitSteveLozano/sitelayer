import type { PoolClient } from 'pg'
import { LA_DIVISIONS, LA_SERVICE_ITEMS } from '@sitelayer/domain'

export const COMPANY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/

export type SeedOptions = {
  includeSampleCustomers?: boolean
}

export async function seedCompanyDefaults(
  client: PoolClient,
  companyId: string,
  options: SeedOptions = {},
): Promise<void> {
  for (const division of LA_DIVISIONS) {
    await client.query(
      `insert into divisions (company_id, code, name, sort_order)
       values ($1, $2, $3, $4)
       on conflict (company_id, code) do nothing`,
      [companyId, division.code, division.name, division.sortOrder],
    )
  }

  for (const item of LA_SERVICE_ITEMS) {
    await client.query(
      `insert into service_items (company_id, code, name, category, unit, default_rate)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (company_id, code) do nothing`,
      [companyId, item.code, item.name, item.category, item.unit, item.defaultRate],
    )
  }

  await client.query(
    `insert into pricing_profiles (company_id, name, is_default, config)
     select $1, 'Default', true, jsonb_build_object('template', 'la-operations')
     where not exists (
       select 1 from pricing_profiles
       where company_id = $1 and name = 'Default' and deleted_at is null
     )`,
    [companyId],
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

  if (options.includeSampleCustomers) {
    await client.query(
      `insert into customers (company_id, name, source)
       values ($1, 'Sample Customer', 'seed')
       on conflict do nothing`,
      [companyId],
    )
  }
}
