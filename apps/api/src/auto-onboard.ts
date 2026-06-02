import type { Pool, PoolClient } from 'pg'

/**
 * First-user self-onboard (multi-tenant safe).
 *
 * The Clerk webhook that mirrors org membership into `company_memberships`
 * isn't wired in every install (CLERK_WEBHOOK_SECRET may be unset) and ADR 0003
 * marks a fresh install as zero-customer. So the FIRST authenticated user that
 * hits a company slug with *no memberships at all* auto-claims `admin`. After
 * that the upsert no-ops — additional users must be invited via
 * `POST /api/companies/:id/memberships`, keeping the role gate honest.
 *
 * MULTI-TENANCY INVARIANT: the membership is always inserted for the slug the
 * REQUEST resolved to (`x-sitelayer-company-slug`, with the dev default as the
 * single-tenant fallback) — NEVER a process-wide default-company constant.
 * Before the worker/product went multi-company, server.ts inserted into the
 * global `ACTIVE_COMPANY_SLUG` default, so a request for company B would
 * (a) grant admin on the WRONG tenant (la-operations) and (b) still 404 on
 * company B. This helper takes the resolved slug explicitly so that class of
 * cross-tenant onboard is structurally impossible.
 *
 * The INSERT is scoped to the named slug and guarded by a `not exists` on any
 * membership for that company, so it is idempotent and can only ever claim a
 * company that currently has zero members. It does NOT set `app.company_id`
 * because the SELECT/INSERT is already constrained to the single resolved
 * company row by slug; there is no cross-company read or write surface here.
 */
export async function autoOnboardFirstAdmin(
  executor: Pick<Pool | PoolClient, 'query'>,
  args: { resolvedCompanySlug: string; userId: string },
): Promise<{ attempted: boolean }> {
  const slug = args.resolvedCompanySlug?.trim()
  const userId = args.userId?.trim()
  if (!slug || !userId) return { attempted: false }
  await executor.query(
    `insert into company_memberships (company_id, clerk_user_id, role)
       select c.id, $1, 'admin'
       from companies c
       where c.slug = $2
         and not exists (
           select 1 from company_memberships m where m.company_id = c.id
         )
       on conflict (company_id, clerk_user_id) do nothing`,
    [userId, slug],
  )
  return { attempted: true }
}
