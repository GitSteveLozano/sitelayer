import { describe, expect, it } from 'vitest'
import {
  APP_ISSUE_CAPABILITIES,
  defaultCompanyCapabilities,
  mergeCompanyCapabilities,
  resolvePlatformCapabilities,
  type Capability,
} from '@sitelayer/domain'
import type { CompanyRole } from './auth-types.js'
import type { Identity } from './auth.js'
import { companyCapabilityGranted, requireCapability, resolveCapability, type CapabilityContext } from './capability.js'
import { type AdminQueryExecutor } from './admin-auth.js'

const clerk = (userId: string): Identity => ({ userId, source: 'clerk' })
const headerIdentity = (userId: string): Identity => ({ userId, source: 'header' })
const defaultIdentity = (userId: string): Identity => ({ userId, source: 'default' })

/**
 * Fake `pg` client for the platform-grant path: `superadmins` answers the
 * `from platform_admins` lookup; `grants` answers the `from platform_admin_grants`
 * lookup (per Clerk subject).
 */
class FakePlatformClient implements AdminQueryExecutor {
  queries: string[] = []
  constructor(
    private readonly superadmins: Set<string> = new Set(),
    private readonly grants: Map<string, string[]> = new Map(),
  ) {}
  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push(text)
    const sub = String(values?.[0] ?? '')
    if (text.includes('from platform_admins')) {
      return { rows: this.superadmins.has(sub) ? [{ ok: 1 }] : [] }
    }
    if (text.includes('from platform_admin_grants')) {
      return { rows: (this.grants.get(sub) ?? []).map((capability) => ({ capability })) }
    }
    throw new Error(`unexpected query: ${text}`)
  }
}

const ctx = (over: Partial<CapabilityContext> = {}): CapabilityContext => ({
  role: 'member',
  grantActions: [],
  identity: clerk('clerk-user'),
  client: new FakePlatformClient(),
  superadminEnvIds: new Set<string>(),
  ...over,
})

const ALL_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'member', 'bookkeeper']

describe('defaultCompanyCapabilities — the field_request.* defaults per role', () => {
  it('grants field_request.create + view to ALL 5 roles (current behaviour floor)', () => {
    for (const role of ALL_ROLES) {
      const caps = defaultCompanyCapabilities(role)
      expect(caps.has('field_request.create')).toBe(true)
      expect(caps.has('field_request.view')).toBe(true)
    }
  })

  it('grants triage + resolve to admin/foreman/office/bookkeeper but NOT member', () => {
    for (const role of ['admin', 'foreman', 'office', 'bookkeeper'] as const) {
      const caps = defaultCompanyCapabilities(role)
      expect(caps.has('field_request.triage')).toBe(true)
      expect(caps.has('field_request.resolve')).toBe(true)
    }
    const member = defaultCompanyCapabilities('member')
    expect(member.has('field_request.triage')).toBe(false)
    expect(member.has('field_request.resolve')).toBe(false)
  })

  it('NEVER emits an app_issue.* capability from the company defaults', () => {
    for (const role of ALL_ROLES) {
      const caps = defaultCompanyCapabilities(role) as Set<string>
      for (const appIssue of APP_ISSUE_CAPABILITIES) {
        expect(caps.has(appIssue)).toBe(false)
      }
    }
  })
})

describe('mergeCompanyCapabilities — additive custom_role_grants', () => {
  it('widens a member with a field_request.triage grant', () => {
    const caps = mergeCompanyCapabilities('member', ['field_request.triage'])
    expect(caps.has('field_request.triage')).toBe(true)
  })

  it('ignores the 9 PERMISSION_ACTIONS (those flow through requirePermission)', () => {
    const caps = mergeCompanyCapabilities('member', ['auth_materials', 'stop_work'])
    expect(caps.has('field_request.triage')).toBe(false)
    expect(caps.has('field_request.resolve')).toBe(false)
  })

  it('can NEVER mint an app_issue.* capability via a company grant', () => {
    const caps = mergeCompanyCapabilities('admin', [
      'app_issue.capture',
      'app_issue.view',
      'app_issue.triage',
    ]) as Set<string>
    for (const appIssue of APP_ISSUE_CAPABILITIES) {
      expect(caps.has(appIssue)).toBe(false)
    }
  })
})

describe('resolvePlatformCapabilities — the platform (app_issue.*) boundary', () => {
  it('superadmin => ALL app_issue.* caps', () => {
    const caps = resolvePlatformCapabilities(true, []) as Set<string>
    for (const appIssue of APP_ISSUE_CAPABILITIES) {
      expect(caps.has(appIssue)).toBe(true)
    }
    expect(caps.size).toBe(APP_ISSUE_CAPABILITIES.length)
  })

  it('opt-in platform_admin_grants grants EXACTLY its capability', () => {
    const caps = resolvePlatformCapabilities(false, ['app_issue.view']) as Set<string>
    expect(caps.has('app_issue.view')).toBe(true)
    expect(caps.has('app_issue.capture')).toBe(false)
    expect(caps.has('app_issue.triage')).toBe(false)
    expect(caps.size).toBe(1)
  })

  it('NEVER emits a field_request.* cap and drops stray/typo grant rows', () => {
    const caps = resolvePlatformCapabilities(false, [
      'field_request.triage',
      'app_issue.not_a_real_cap',
      'app_issue.capture',
    ]) as Set<string>
    expect(caps.has('app_issue.capture')).toBe(true)
    expect(caps.has('field_request.triage')).toBe(false)
    expect(caps.has('app_issue.not_a_real_cap')).toBe(false)
    expect(caps.size).toBe(1)
  })
})

describe('companyCapabilityGranted (pure, no I/O)', () => {
  it('member holds create+view, lacks triage/resolve', () => {
    expect(companyCapabilityGranted('member', [], 'field_request.create')).toBe(true)
    expect(companyCapabilityGranted('member', [], 'field_request.view')).toBe(true)
    expect(companyCapabilityGranted('member', [], 'field_request.triage')).toBe(false)
  })
})

describe('resolveCapability — domain dispatch', () => {
  it('allows a field_request.* cap on the company boundary without a DB hit', async () => {
    const client = new FakePlatformClient()
    const verdict = await resolveCapability(ctx({ role: 'admin', client }), 'field_request.triage')
    expect(verdict.outcome).toBe('allowed')
    expect(client.queries).toHaveLength(0)
  })

  it('denies a member a field_request.triage cap', async () => {
    const verdict = await resolveCapability(ctx({ role: 'member' }), 'field_request.triage')
    expect(verdict).toEqual({ outcome: 'denied', domain: 'field_request', reason: 'company role lacks capability' })
  })

  it('superadmin (env allowlist) holds every app_issue.* cap', async () => {
    const client = new FakePlatformClient(new Set(['boss']))
    for (const cap of APP_ISSUE_CAPABILITIES) {
      const verdict = await resolveCapability(
        ctx({ identity: clerk('boss'), client, superadminEnvIds: new Set(['boss']) }),
        cap,
      )
      expect(verdict.outcome).toBe('allowed')
    }
  })

  it('platform_admin_grants opt-in grants exactly its capability', async () => {
    const client = new FakePlatformClient(new Set(), new Map([['ops-person', ['app_issue.view']]]))
    const c = ctx({ identity: clerk('ops-person'), client })
    expect((await resolveCapability(c, 'app_issue.view')).outcome).toBe('allowed')
    const denied = await resolveCapability(c, 'app_issue.triage')
    expect(denied.outcome).toBe('denied')
    if (denied.outcome === 'denied') expect(denied.domain).toBe('app_issue')
  })

  it('a Clerk company-admin with NO platform grant can NEVER reach app_issue.*', async () => {
    // Superadmin set empty, no grant rows — a real company admin identity.
    const client = new FakePlatformClient(new Set(), new Map())
    for (const cap of APP_ISSUE_CAPABILITIES) {
      const verdict = await resolveCapability(ctx({ role: 'admin', identity: clerk('co-admin'), client }), cap)
      expect(verdict.outcome).toBe('denied')
      if (verdict.outcome === 'denied') expect(verdict.domain).toBe('app_issue')
    }
  })

  it('a NON-Clerk identity (header/default — dev act-as / fallback) can NEVER reach app_issue.* and never hits the DB', async () => {
    for (const identity of [headerIdentity('dev'), defaultIdentity('demo-user')]) {
      const client = new FakePlatformClient(new Set(['dev']), new Map([['dev', ['app_issue.view']]]))
      const verdict = await resolveCapability(ctx({ role: 'admin', identity, client }), 'app_issue.view')
      expect(verdict.outcome).toBe('denied')
      if (verdict.outcome === 'denied') expect(verdict.domain).toBe('app_issue')
      expect(client.queries).toHaveLength(0)
    }
  })
})

describe('requireCapability — route helper (403 on denial)', () => {
  it('returns true and sends nothing when allowed', async () => {
    let sent: { status: number; body: unknown } | null = null
    const ok = await requireCapability(ctx({ role: 'admin' }), 'field_request.triage', (status, body) => {
      sent = { status, body }
    })
    expect(ok).toBe(true)
    expect(sent).toBeNull()
  })

  it('returns false and sends a 403 with the capability + domain when denied', async () => {
    let sent: { status: number; body: unknown } | null = null
    const ok = await requireCapability(ctx({ role: 'member' }), 'field_request.triage', (status, body) => {
      sent = { status, body }
    })
    expect(ok).toBe(false)
    expect(sent).not.toBeNull()
    expect(sent!.status).toBe(403)
    expect(sent!.body).toMatchObject({
      capability: 'field_request.triage' satisfies Capability,
      domain: 'field_request',
    })
  })
})
