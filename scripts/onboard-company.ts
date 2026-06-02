#!/usr/bin/env -S npx tsx
/**
 * Provision a new customer company end-to-end. Replaces the manual
 * sequence of `/api/companies` POST + `/api/companies/:id/memberships`
 * POST + bespoke division/service-item seeding that previously had to
 * be run by hand (or, in the demo case, by the API's first-user
 * auto-onboard fallback).
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/onboard-company.ts \
 *     --slug acme-construction \
 *     --name "ACME Construction Inc" \
 *     --admin-user-id user_2abcXYZ \
 *     [--admin-email taylor@acme.example] \
 *     [--clerk-org-id org_2xyz] \
 *     [--template generic-construction] \
 *     [--skip-seed]
 *
 * Steps:
 *   1. Insert into `companies` (no-op if slug already exists).
 *   2. Insert the admin into `company_memberships` (idempotent).
 *   3. Seed default divisions, service_items, pricing_profiles,
 *      bonus_rules via the same `seedCompanyDefaults` the API uses. The
 *      template defaults to the trade-neutral GENERIC construction set so a
 *      new company is NOT seeded with L&A Operations' stucco/EIFS divisions;
 *      pass `--template la-operations` to clone LA's reference set. Skipped
 *      with --skip-seed for tests.
 *
 * The script intentionally does NOT touch QBO — that's a follow-up
 * once the customer has connected their Intuit account in the SPA.
 * It also doesn't talk to Clerk; the caller already knows the Clerk
 * user id (from the customer's signed-up Clerk org), and the Clerk
 * webhook will mirror memberships on subsequent sign-ins.
 *
 * Exit codes:
 *   0  success (idempotent)
 *   1  bad arguments / DB error
 */

import { Pool } from 'pg'
import { DEFAULT_SEED_TEMPLATE_SLUG, resolveSeedTemplate } from '@sitelayer/domain'
import { COMPANY_SLUG_PATTERN, seedCompanyDefaults } from '../apps/api/src/onboarding.js'

type Args = {
  slug: string
  name: string
  adminUserId: string
  adminEmail: string | null
  clerkOrgId: string | null
  template: string
  skipSeed: boolean
}

function parseArgs(argv: string[]): Args {
  let slug: string | null = null
  let name: string | null = null
  let adminUserId: string | null = null
  let adminEmail: string | null = null
  let clerkOrgId: string | null = null
  let template: string = DEFAULT_SEED_TEMPLATE_SLUG
  let skipSeed = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--slug':
        slug = next ?? null
        i++
        break
      case '--name':
        name = next ?? null
        i++
        break
      case '--admin-user-id':
        adminUserId = next ?? null
        i++
        break
      case '--admin-email':
        adminEmail = next ?? null
        i++
        break
      case '--clerk-org-id':
        clerkOrgId = next ?? null
        i++
        break
      case '--template':
        template = next ?? DEFAULT_SEED_TEMPLATE_SLUG
        i++
        break
      case '--skip-seed':
        skipSeed = true
        break
      case '-h':
      case '--help':
        process.stdout.write(usage())
        process.exit(0)
        break
      default:
        process.stderr.write(`unknown arg: ${arg}\n`)
        process.exit(1)
    }
  }
  if (!slug || !name || !adminUserId) {
    process.stderr.write('missing required args\n\n')
    process.stderr.write(usage())
    process.exit(1)
  }
  if (!COMPANY_SLUG_PATTERN.test(slug)) {
    process.stderr.write(`slug ${slug} does not match ${COMPANY_SLUG_PATTERN}\n`)
    process.exit(1)
  }
  return { slug, name, adminUserId, adminEmail, clerkOrgId, template, skipSeed }
}

function usage(): string {
  return (
    `Usage: onboard-company.ts --slug <slug> --name <name> --admin-user-id <id> ` +
    `[--admin-email <email>] [--clerk-org-id <id>] [--template <slug>] [--skip-seed]\n` +
    `  --template defaults to '${DEFAULT_SEED_TEMPLATE_SLUG}' (trade-neutral); ` +
    `pass 'la-operations' to clone L&A's reference set.\n`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL required\n')
    process.exit(1)
  }
  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const client = await pool.connect()
    try {
      await client.query('begin')

      const existing = await client.query<{ id: string }>(`select id from companies where slug = $1`, [args.slug])
      let companyId: string
      if (existing.rows.length > 0) {
        companyId = existing.rows[0]!.id
        process.stdout.write(`[onboard] company ${args.slug} already exists (${companyId}); upserting membership\n`)
      } else {
        const created = await client.query<{ id: string }>(
          `insert into companies (slug, name) values ($1, $2) returning id`,
          [args.slug, args.name],
        )
        companyId = created.rows[0]!.id
        process.stdout.write(`[onboard] created company ${args.slug} (${companyId})\n`)
      }

      await client.query(
        `insert into company_memberships (company_id, clerk_user_id, role)
         values ($1, $2, 'admin')
         on conflict (company_id, clerk_user_id) do update set role = 'admin'`,
        [companyId, args.adminUserId],
      )
      process.stdout.write(`[onboard] upserted admin membership for user ${args.adminUserId}\n`)

      // Resolve the seed template up front so an unknown slug surfaces as a
      // generic fallback BEFORE we write (resolveSeedTemplate never throws).
      const { template: seedTemplate, matched } = resolveSeedTemplate(args.template)
      if (!args.skipSeed) {
        if (!matched) {
          process.stdout.write(
            `[onboard] template '${args.template}' not recognized — falling back to '${seedTemplate.slug}'\n`,
          )
        }
        await seedCompanyDefaults(client, companyId, {
          includeSampleCustomers: false,
          template: seedTemplate,
        })
        process.stdout.write(
          `[onboard] seeded '${seedTemplate.slug}' defaults: divisions + service_items + pricing_profile + bonus_rule\n`,
        )
      }

      await client.query('commit')

      process.stdout.write(
        JSON.stringify({
          company_id: companyId,
          slug: args.slug,
          admin_user_id: args.adminUserId,
          ...(args.clerkOrgId ? { clerk_org_id: args.clerkOrgId } : {}),
          ...(args.adminEmail ? { admin_email: args.adminEmail } : {}),
          seeded: !args.skipSeed,
          ...(args.skipSeed ? {} : { seed_template: seedTemplate.slug }),
        }) + '\n',
      )
    } catch (err) {
      await client.query('rollback').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  process.stderr.write(`[onboard] failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
