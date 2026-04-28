import type http from 'node:http'
import type { Pool } from 'pg'
import { COMPANY_SLUG_PATTERN, seedCompanyDefaults } from '../onboarding.js'
import { recordAudit } from '../audit.js'
import { observeAudit } from '../metrics.js'
import { enqueueNotification } from '../mutation-tx.js'

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

  if (req.method === 'POST' && url.pathname === '/api/companies') {
    const body = await readBody()
    const slug = String(body.slug ?? '')
      .trim()
      .toLowerCase()
    const name = String(body.name ?? '').trim()
    if (!slug || !COMPANY_SLUG_PATTERN.test(slug)) {
      sendJson(400, { error: 'slug must be 2-64 chars, lowercase letters/digits/dashes' })
      return true
    }
    if (!name) {
      sendJson(400, { error: 'name is required' })
      return true
    }
    const seedDefaults = body.seed_defaults !== false
    const client = await pool.connect()
    try {
      await client.query('begin')
      const existing = await client.query('select id from companies where slug = $1 limit 1', [slug])
      if (existing.rows[0]) {
        await client.query('rollback')
        sendJson(409, { error: 'slug already in use' })
        return true
      }
      const created = await client.query<{ id: string; slug: string; name: string; created_at: string }>(
        `insert into companies (slug, name) values ($1, $2)
         returning id, slug, name, created_at`,
        [slug, name],
      )
      const newCompany = created.rows[0]!
      await client.query(
        `insert into company_memberships (company_id, clerk_user_id, role)
         values ($1, $2, 'admin')`,
        [newCompany.id, userId],
      )
      if (seedDefaults) {
        await seedCompanyDefaults(client, newCompany.id)
      }
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
    const body = await readBody()
    const inviteUserId = String(body.clerk_user_id ?? body.user_id ?? '').trim()
    const role = String(body.role ?? 'member').trim() || 'member'
    if (!inviteUserId) {
      sendJson(400, { error: 'clerk_user_id is required' })
      return true
    }
    if (!['admin', 'member', 'foreman', 'office'].includes(role)) {
      sendJson(400, { error: 'role must be admin, member, foreman, or office' })
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
    const membership = inserted.rows[0]!
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
