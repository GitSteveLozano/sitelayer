import type http from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'
import { COMPANY_SLUG_PATTERN, seedCompanyDefaults } from '../onboarding.js'
import { recordAudit } from '../audit.js'
import { HttpError, parseJsonBody } from '../http-utils.js'
import { observeAudit } from '../metrics.js'
import { enqueueNotification, recordMutationOutbox } from '../mutation-tx.js'

// JSON-object guard used for the modules / portal_settings PATCH bodies.
// The route writes `modules || $2::jsonb` and `portal_settings || $3::jsonb`,
// so the input must be a plain object (no arrays, no primitives) — pg would
// otherwise blow up downstream with a less-obvious error.
const JsonObjectSchema = z.record(z.string(), z.unknown())

const CompanyModulesPatchSchema = z
  .object({
    modules: JsonObjectSchema.optional(),
    portal_settings: JsonObjectSchema.optional(),
  })
  .refine((v) => v.modules !== undefined || v.portal_settings !== undefined, {
    message: 'modules or portal_settings is required',
  })

// Schema enforces clerk_user_id (or legacy user_id alias) is a string and
// the role is one of the known company-membership roles. Mirrors the
// existing 400s but rejects e.g. `role: 42` upfront.
const CompanyMembershipBodySchema = z
  .object({
    clerk_user_id: z.string().trim().min(1).optional(),
    user_id: z.string().trim().min(1).optional(),
    role: z.enum(['admin', 'member', 'foreman', 'office', 'bookkeeper']).optional(),
  })
  .refine((v) => Boolean(v.clerk_user_id ?? v.user_id), {
    message: 'clerk_user_id is required',
    path: ['clerk_user_id'],
  })

const CompanyCreateBodySchema = z.object({
  slug: z.string().optional(),
  name: z.string().optional(),
  seed_defaults: z.boolean().optional(),
})

// Settings PATCH: ot_service_item_code must explicitly appear in the body
// (a missing key is a different 400 than `null`), and must be a string or
// null when present. The route still does the company-scoped catalog
// lookup downstream.
const CompanySettingsPatchSchema = z
  .object({
    ot_service_item_code: z.union([z.string(), z.null()]),
  })
  .strict()

export type CompanyRouteCtx = {
  pool: Pool
  userId: string
  sendJson: (status: number, body: unknown) => void
  readBody: () => Promise<Record<string, unknown>>
}

export async function getMemberships(pool: Pool, userId: string) {
  const result = await pool.query(
    `
    select cm.id, cm.company_id, cm.clerk_user_id, cm.role, cm.created_at, c.slug, c.name
    from company_memberships cm
    join companies c on c.id = cm.company_id
    where cm.clerk_user_id = $1
    order by c.created_at asc
    `,
    [userId],
  )
  return result.rows
}

export async function handleCompanyRoutes(req: http.IncomingMessage, url: URL, ctx: CompanyRouteCtx): Promise<boolean> {
  const { pool, userId, sendJson, readBody } = ctx

  if (req.method === 'GET' && url.pathname === '/api/companies') {
    const memberships = await getMemberships(pool, userId)
    const companies = memberships.map((m) => ({
      id: m.company_id,
      slug: m.slug,
      name: m.name,
      created_at: m.created_at,
      role: m.role,
    }))
    sendJson(200, { companies })
    return true
  }

  // GET /api/me/memberships — list every (company, role) the current
  // Clerk user is in, so the SPA can render a multi-company switcher.
  // This is the only route that legitimately needs to read across
  // companies (the user is asking "which companies am I in?") — every
  // other surface is single-tenant. The query runs at the pool, not
  // through withCompanyClient, because there's no active company id
  // yet. Migration 066's `app_current_company_id() IS NULL OR ...`
  // policy explicitly permits this read at the pool.
  //
  // Distinct from `GET /api/companies` (above) which returns the same
  // memberships but is shaped for the historical admin / onboarding
  // flow. The /me variant returns a narrower shape and skips the
  // `created_at` cursor; the switcher just needs slug/name/role.
  if (req.method === 'GET' && url.pathname === '/api/me/memberships') {
    const result = await pool.query<{
      company_id: string
      company_slug: string
      company_name: string
      role: string
    }>(
      `
      select c.id as company_id, c.slug as company_slug, c.name as company_name, cm.role
      from company_memberships cm
      join companies c on c.id = cm.company_id
      where cm.clerk_user_id = $1
      order by c.name asc
      `,
      [userId],
    )
    sendJson(200, { memberships: result.rows })
    return true
  }

  const modulesMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/modules$/)
  if (req.method === 'GET' && modulesMatch) {
    const companyId = modulesMatch[1]!
    const member = await pool.query<{ role: string }>(
      'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
      [companyId, userId],
    )
    if (!member.rows[0]) {
      sendJson(403, { error: 'not a member of this company' })
      return true
    }
    const result = await pool.query<{ modules: Record<string, boolean>; portal_settings: Record<string, boolean> }>(
      'select modules, portal_settings from companies where id = $1 limit 1',
      [companyId],
    )
    if (!result.rows[0]) {
      sendJson(404, { error: 'company not found' })
      return true
    }
    sendJson(200, { modules: result.rows[0].modules, portal_settings: result.rows[0].portal_settings })
    return true
  }
  if (req.method === 'PATCH' && modulesMatch) {
    const companyId = modulesMatch[1]!
    const adminCheck = await pool.query<{ role: string }>(
      'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
      [companyId, userId],
    )
    if (!adminCheck.rows[0] || adminCheck.rows[0].role !== 'admin') {
      sendJson(403, { error: 'admin role required' })
      return true
    }
    const parsed = parseJsonBody(CompanyModulesPatchSchema, await readBody())
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }
    const modulesPatch = parsed.value.modules ?? null
    const portalPatch = parsed.value.portal_settings ?? null
    const updated = await pool.query<{ modules: Record<string, boolean>; portal_settings: Record<string, boolean> }>(
      `
      update companies
      set
        modules = case when $2::jsonb is null then modules else modules || $2::jsonb end,
        portal_settings = case when $3::jsonb is null then portal_settings else portal_settings || $3::jsonb end
      where id = $1
      returning modules, portal_settings
      `,
      [companyId, modulesPatch ? JSON.stringify(modulesPatch) : null, portalPatch ? JSON.stringify(portalPatch) : null],
    )
    if (!updated.rows[0]) {
      sendJson(404, { error: 'company not found' })
      return true
    }
    await recordAudit(pool, {
      companyId,
      actorUserId: userId,
      entityType: 'company_modules',
      entityId: companyId,
      action: 'update',
      after: updated.rows[0],
    })
    observeAudit('company_modules', 'update')
    sendJson(200, { modules: updated.rows[0].modules, portal_settings: updated.rows[0].portal_settings })
    return true
  }

  // PATCH /api/companies/:id/settings — admin-only company-level
  // settings (currently: ot_service_item_code for the QBO labor-payroll
  // OT split). Kept separate from /modules so the body shape stays a
  // narrow whitelist; new settings land here rather than expanding the
  // modules JSONB.
  const settingsMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/settings$/)
  if (req.method === 'GET' && settingsMatch) {
    const companyId = settingsMatch[1]!
    const member = await pool.query<{ role: string }>(
      'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
      [companyId, userId],
    )
    if (!member.rows[0]) {
      sendJson(403, { error: 'not a member of this company' })
      return true
    }
    const result = await pool.query<{ ot_service_item_code: string | null }>(
      'select ot_service_item_code from companies where id = $1 limit 1',
      [companyId],
    )
    if (!result.rows[0]) {
      sendJson(404, { error: 'company not found' })
      return true
    }
    sendJson(200, { ot_service_item_code: result.rows[0].ot_service_item_code })
    return true
  }
  if (req.method === 'PATCH' && settingsMatch) {
    const companyId = settingsMatch[1]!
    const adminCheck = await pool.query<{ role: string }>(
      'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
      [companyId, userId],
    )
    if (!adminCheck.rows[0] || adminCheck.rows[0].role !== 'admin') {
      sendJson(403, { error: 'admin role required' })
      return true
    }
    const rawBody = await readBody()
    if (!Object.prototype.hasOwnProperty.call(rawBody, 'ot_service_item_code')) {
      // Preserve the legacy "required" message — distinct from the
      // type-mismatch error the schema raises for a wrong-typed value.
      sendJson(400, { error: 'ot_service_item_code is required (string or null)' })
      return true
    }
    const parsed = parseJsonBody(CompanySettingsPatchSchema, rawBody)
    if (!parsed.ok) {
      sendJson(400, { error: 'ot_service_item_code must be string or null' })
      return true
    }
    const raw = parsed.value.ot_service_item_code
    let nextCode: string | null
    if (raw === null) {
      nextCode = null
    } else {
      const trimmed = raw.trim()
      nextCode = trimmed === '' ? null : trimmed
    }
    // Validate the code exists in service_items for the company so a
    // typo can't silently disable OT push downstream. NULL writes
    // (the "no OT split" opt-out) skip the lookup.
    if (nextCode !== null) {
      const existsResult = await pool.query<{ code: string }>(
        `select code from service_items
         where company_id = $1 and code = $2 and deleted_at is null
         limit 1`,
        [companyId, nextCode],
      )
      if (!existsResult.rows[0]) {
        sendJson(400, {
          error: `service_items.code "${nextCode}" not found for company; create it via /api/service-items first`,
        })
        return true
      }
    }
    const before = await pool.query<{ ot_service_item_code: string | null }>(
      'select ot_service_item_code from companies where id = $1 limit 1',
      [companyId],
    )
    if (!before.rows[0]) {
      sendJson(404, { error: 'company not found' })
      return true
    }
    const updated = await pool.query<{ ot_service_item_code: string | null }>(
      `update companies set ot_service_item_code = $2 where id = $1
       returning ot_service_item_code`,
      [companyId, nextCode],
    )
    const updatedRow = updated.rows[0]
    if (!updatedRow) throw new HttpError(500, 'company update returned no row')
    await recordAudit(pool, {
      companyId,
      actorUserId: userId,
      entityType: 'company',
      entityId: companyId,
      action: 'update_settings',
      before: before.rows[0],
      after: updatedRow,
    })
    observeAudit('company', 'update_settings')
    sendJson(200, { ot_service_item_code: updatedRow.ot_service_item_code })
    return true
  }

  // GET /api/companies/:id/usage — month-to-date cost rollup from
  // company_usage_log (migration 086). The substrate for future quotas;
  // no enforcement here, just read access. Any member of the company can
  // read; the data is non-sensitive aggregate spend. The query carries
  // its own company_id filter, mirroring what RLS would enforce via
  // app_current_company_id() — so a misrouted call cannot see another
  // tenant's spend even if RLS is in shadow mode.
  const usageMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/usage$/)
  if (req.method === 'GET' && usageMatch) {
    const companyId = usageMatch[1]!
    const member = await pool.query<{ role: string }>(
      'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
      [companyId, userId],
    )
    if (!member.rows[0]) {
      sendJson(403, { error: 'not a member of this company' })
      return true
    }
    const rollup = await pool.query<{ operation: string; count: string | number; total_usd: string | number }>(
      `select operation,
              count(*) as count,
              coalesce(sum(cost_usd), 0) as total_usd
         from company_usage_log
        where company_id = $1
          and created_at >= date_trunc('month', now())
        group by operation
        order by operation asc`,
      [companyId],
    )
    const byOperation = rollup.rows.map((row) => ({
      operation: row.operation,
      count: Number(row.count),
      total_usd: Number(row.total_usd),
    }))
    const totalUsd = byOperation.reduce((acc, row) => acc + row.total_usd, 0)
    sendJson(200, {
      month_to_date: {
        total_usd: totalUsd,
        by_operation: byOperation,
      },
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/companies') {
    const parsed = parseJsonBody(CompanyCreateBodySchema, await readBody())
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }
    const slug = (parsed.value.slug ?? '').trim().toLowerCase()
    const name = (parsed.value.name ?? '').trim()
    if (!slug || !COMPANY_SLUG_PATTERN.test(slug)) {
      sendJson(400, { error: 'slug must be 2-64 chars, lowercase letters/digits/dashes' })
      return true
    }
    if (!name) {
      sendJson(400, { error: 'name is required' })
      return true
    }
    const seedDefaults = parsed.value.seed_defaults !== false
    const client = await pool.connect()
    try {
      await client.query('begin')
      const existing = await client.query('select id from companies where slug = $1 limit 1', [slug])
      if (existing.rows[0]) {
        await client.query('rollback')
        // Best-effort suggestion: probe `<slug>-2` … `<slug>-10` for an
        // unused variant so the wizard can auto-populate the field
        // instead of bouncing the user back with a raw 409. If none of
        // the 9 candidates are free (extreme collision), fall back to
        // the legacy `{ error }` shape so the UI path stays the same.
        // The suggestion respects COMPANY_SLUG_PATTERN; since we only
        // append `-N` to a slug we already validated, the resulting
        // candidate is guaranteed in-pattern up to N=10.
        let suggestedSlug: string | null = null
        for (let i = 2; i <= 10; i += 1) {
          const candidate = `${slug}-${i}`
          if (!COMPANY_SLUG_PATTERN.test(candidate)) continue
          const probe = await pool.query('select id from companies where slug = $1 limit 1', [candidate])
          if (!probe.rows[0]) {
            suggestedSlug = candidate
            break
          }
        }
        if (suggestedSlug) {
          sendJson(409, { error: 'slug already taken', suggested_slug: suggestedSlug })
        } else {
          sendJson(409, { error: 'slug already in use' })
        }
        return true
      }
      const created = await client.query<{ id: string; slug: string; name: string; created_at: string }>(
        `insert into companies (slug, name) values ($1, $2)
         returning id, slug, name, created_at`,
        [slug, name],
      )
      const newCompany = created.rows[0]
      if (!newCompany) throw new HttpError(500, 'company insert returned no row')
      await client.query(
        `insert into company_memberships (company_id, clerk_user_id, role)
         values ($1, $2, 'admin')`,
        [newCompany.id, userId],
      )
      if (seedDefaults) {
        await seedCompanyDefaults(client, newCompany.id)
      }
      // Enqueue the welcome email for the new owner. We scope the row to the
      // freshly-created company so RLS keeps it tenant-clean, and use a
      // stable idempotency key `welcome_email:<user>:<company>` so:
      //   1. A double-tap on POST /api/companies (e.g. retry after a flaky
      //      network) coalesces onto the same outbox row.
      //   2. A Clerk `user.created` replay would slot under a different
      //      shape (the webhook handler is still a no-op; see ADR 0003 +
      //      public.ts) and not conflict with this row.
      // PII hygiene: we deliberately do NOT carry the user's email in the
      // payload — the worker hydrates it from Clerk at send time via the
      // existing ClerkResolver path, and `redactEmail` is used at every
      // log site that touches an address.
      await recordMutationOutbox(
        newCompany.id,
        'company',
        newCompany.id,
        'welcome_email',
        {
          user_id: userId,
          company_id: newCompany.id,
          company_name: newCompany.name,
        },
        `welcome_email:${userId}:${newCompany.id}`,
        'server',
        userId,
        client,
      )
      await client.query('commit')
      await recordAudit(pool, {
        companyId: newCompany.id,
        actorUserId: userId,
        entityType: 'company',
        entityId: newCompany.id,
        action: 'create',
        after: newCompany,
      })
      observeAudit('company', 'create')
      sendJson(201, { company: newCompany, role: 'admin' })
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
    return true
  }

  const companyMembershipMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/memberships$/)
  if (req.method === 'POST' && companyMembershipMatch) {
    const targetCompanyId = companyMembershipMatch[1]!
    const adminCheck = await pool.query<{ role: string }>(
      'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
      [targetCompanyId, userId],
    )
    if (!adminCheck.rows[0] || adminCheck.rows[0].role !== 'admin') {
      sendJson(403, { error: 'admin role required' })
      return true
    }
    const parsed = parseJsonBody(CompanyMembershipBodySchema, await readBody())
    if (!parsed.ok) {
      // Preserve the legacy specific error messages: "clerk_user_id is
      // required" if neither id was supplied, otherwise the role enum
      // message verbatim. Tests rely on this exact wording.
      const issue = parsed.error
      if (issue.includes('clerk_user_id')) {
        sendJson(400, { error: 'clerk_user_id is required' })
      } else if (issue.includes('role')) {
        sendJson(400, { error: 'role must be admin, member, foreman, office, or bookkeeper' })
      } else {
        sendJson(400, { error: parsed.error })
      }
      return true
    }
    const inviteUserId = (parsed.value.clerk_user_id ?? parsed.value.user_id ?? '').trim()
    const role = parsed.value.role ?? 'member'
    if (!inviteUserId) {
      sendJson(400, { error: 'clerk_user_id is required' })
      return true
    }
    const inserted = await pool.query<{
      id: string
      company_id: string
      clerk_user_id: string
      role: string
      created_at: string
    }>(
      `insert into company_memberships (company_id, clerk_user_id, role)
       values ($1, $2, $3)
       on conflict (company_id, clerk_user_id) do update set role = excluded.role
       returning id, company_id, clerk_user_id, role, created_at`,
      [targetCompanyId, inviteUserId, role],
    )
    const membership = inserted.rows[0]
    if (!membership) throw new HttpError(500, 'company membership upsert returned no row')
    await recordAudit(pool, {
      companyId: targetCompanyId,
      actorUserId: userId,
      entityType: 'company_membership',
      entityId: membership.id,
      action: 'upsert',
      after: membership,
    })
    observeAudit('company_membership', 'upsert')
    await enqueueNotification({
      companyId: targetCompanyId,
      recipientUserId: membership.clerk_user_id,
      kind: 'membership_welcome',
      subject: `You've been added to Sitelayer as ${membership.role}`,
      text: [
        `You've been added to a Sitelayer company as ${membership.role}.`,
        `Sign in to get started: https://sitelayer.sandolab.xyz/sign-in`,
      ].join('\n\n'),
      html: [
        `<p>You've been added to a Sitelayer company as <strong>${membership.role}</strong>.</p>`,
        `<p><a href="https://sitelayer.sandolab.xyz/sign-in">Sign in</a> to get started.</p>`,
      ].join('\n'),
      payload: {
        membership_id: membership.id,
        role: membership.role,
        invited_by: userId,
      },
    })
    sendJson(201, { membership })
    return true
  }

  return false
}
