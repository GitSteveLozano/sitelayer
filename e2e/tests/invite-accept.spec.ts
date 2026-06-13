import { test, expect } from '../fixtures/auth'
import type { Page, Route } from '@playwright/test'

/**
 * A3 (invite acceptance) — invite → AcceptInvite → role first-run → persona
 * shell.
 *
 * Closes the "invited teammate" journey, which had zero e2e coverage. Each
 * persona walks the real, role-agnostic accept screen
 * (`apps/web/src/screens/invite/AcceptInvite.tsx`, public route
 * `/invite/accept/:token`) and lands on the RIGHT role first-run takeover:
 *
 *   foreman  → /foreman/first-run
 *   crew     → /worker/first-run     (company role `member`)
 *   estimator→ /estimator/first-run  (company role `office`)
 *
 * The landing is driven by the first-run gate added to
 * `screens/app-shell.tsx` `CompanyShell` (G3): a brand-new membership whose
 * `first_run_completed_at` is still null is routed to its role's first-run
 * priming. So this spec proves BOTH the accept binding AND the G3 read-side
 * gate — a fresh member is no longer dropped straight into the workspace with
 * the priming silently skipped.
 *
 * IDENTITY rail: each persona rides its matching act-as fixture page (built by
 * `buildRolePage` in `fixtures/auth.ts`). The invite-view, accept, and the
 * post-accept workspace bootstrap chain are Playwright-route-mocked so the
 * journey is deterministic without seeded invite tokens (the API never returns
 * the token to clients) — the same hybrid the capture smokes use.
 *
 * Gated on `E2E_RUN=1` like the other live-stack specs.
 */

const API_ORIGIN = `http://localhost:${process.env.E2E_API_PORT ?? '3001'}`
const WEB_ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? '3100'}`

const INVITE_COMPANY = {
  id: 'company-invite-accept-spec',
  slug: 'invite-accept-spec-co',
  name: 'Northwind Scaffolding',
} as const

type RoleFixture = 'foremanPage' | 'memberPage' | 'officePage'

type PersonaCase = {
  label: string
  /** The `<role>Page` fixture key. */
  fixture: RoleFixture
  /** The act-as user id the fixture carries (becomes the membership owner). */
  actAsUserId: string
  /** The company role the invite binds (and the membership reports). */
  companyRole: 'foreman' | 'member' | 'office'
  /** The invite role label rendered on the accept summary. */
  inviteRoleLabel: string
  /** The first-run route the G3 gate must redirect a fresh member to. */
  firstRunPath: string
  token: string
}

const CASES: PersonaCase[] = [
  {
    label: 'foreman',
    fixture: 'foremanPage',
    actAsUserId: 'e2e-foreman',
    companyRole: 'foreman',
    inviteRoleLabel: 'foreman',
    firstRunPath: '/foreman/first-run',
    token: 'invite-token-foreman',
  },
  {
    label: 'crew (member)',
    fixture: 'memberPage',
    actAsUserId: 'e2e-member',
    companyRole: 'member',
    inviteRoleLabel: 'member',
    firstRunPath: '/worker/first-run',
    token: 'invite-token-member',
  },
  {
    label: 'estimator (office)',
    fixture: 'officePage',
    actAsUserId: 'e2e-office',
    companyRole: 'office',
    inviteRoleLabel: 'office',
    firstRunPath: '/estimator/first-run',
    token: 'invite-token-office',
  },
]

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

for (const persona of CASES) {
  runSpec(
    `${persona.label}: accept invite → ${persona.firstRunPath} first-run`,
    { tag: '@foreman' },
    async (fixtures) => {
      const page = fixtures[persona.fixture] as Page
      const state = { accepted: 0 }
      await installInviteMocks(page, persona, state)

      // 1. Public invite summary renders company + role. The role is rendered
      //    in a <strong> inside the "invited to join as <role>" line.
      await page.goto(`/invite/accept/${persona.token}`)
      await expect(page.getByText(INVITE_COMPANY.name)).toBeVisible({ timeout: 10_000 })
      await expect(page.getByText('invited to join as')).toBeVisible()
      await expect(page.locator('strong', { hasText: persona.inviteRoleLabel })).toBeVisible()

      // 2. Accept binds the membership (act-as identity carries the accept).
      await page.getByRole('button', { name: /Accept invitation/i }).click()
      await expect.poll(() => state.accepted, { timeout: 10_000 }).toBe(1)

      // 3. AcceptInvite routes to `/`; the G3 first-run gate in CompanyShell
      //    redirects this fresh member (first_run_completed_at: null) to their
      //    role's first-run takeover — the correct persona handoff.
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(persona.firstRunPath)
    },
  )
}

async function installInviteMocks(page: Page, persona: PersonaCase, state: { accepted: number }): Promise<void> {
  await page.route(`${API_ORIGIN}/api/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    // Public invite view — company + role + pending status.
    if (method === 'GET' && path === `/api/invites/${persona.token}`) {
      await fulfillJson(route, {
        invite: {
          company_name: INVITE_COMPANY.name,
          email: `${persona.actAsUserId}@example.com`,
          role: persona.inviteRoleLabel,
          status: 'pending',
          expires_at: '2026-12-31T00:00:00.000Z',
        },
      })
      return
    }

    // Accept — bind membership under the invite's company + role.
    if (method === 'POST' && path === `/api/invites/${persona.token}/accept`) {
      state.accepted += 1
      await fulfillJson(
        route,
        {
          membership: {
            id: `membership-${persona.actAsUserId}`,
            company_id: INVITE_COMPANY.id,
            clerk_user_id: persona.actAsUserId,
            role: persona.companyRole,
            created_at: '2026-06-13T00:00:00.000Z',
          },
          company: { id: INVITE_COMPANY.id, slug: INVITE_COMPANY.slug, name: INVITE_COMPANY.name },
        },
        201,
      )
      return
    }

    // Post-accept workspace bootstrap chain — the membership is brand-new, so
    // its `first_run_completed_at` is null. That's exactly what the G3 gate
    // reads to route to the role's first-run.
    if (method === 'GET' && path === '/api/me/memberships') {
      await fulfillJson(route, {
        memberships: [
          {
            company_id: INVITE_COMPANY.id,
            company_slug: INVITE_COMPANY.slug,
            company_name: INVITE_COMPANY.name,
            role: persona.companyRole,
          },
        ],
      })
      return
    }

    if (method === 'GET' && path === '/api/session') {
      await fulfillJson(route, {
        user: { id: persona.actAsUserId, role: persona.companyRole },
        activeCompany: { id: INVITE_COMPANY.id, slug: INVITE_COMPANY.slug, name: INVITE_COMPANY.name },
        memberships: [
          {
            id: `membership-${persona.actAsUserId}`,
            company_id: INVITE_COMPANY.id,
            clerk_user_id: persona.actAsUserId,
            role: persona.companyRole,
            created_at: '2026-06-13T00:00:00.000Z',
            slug: INVITE_COMPANY.slug,
            name: INVITE_COMPANY.name,
            // The load-bearing field for G3: a fresh member has not yet been
            // primed, so this is null → route to role first-run.
            first_run_completed_at: null,
          },
        ],
        app_issue_capabilities: [],
      })
      return
    }

    if (method === 'GET' && path === '/api/bootstrap') {
      await fulfillJson(route, bootstrapFixture())
      return
    }

    if (method === 'GET' && path === '/api/features') {
      await fulfillJson(route, { tier: 'local', flags: [], ribbon: null, ai_chat_enabled: false })
      return
    }

    // Anything else the shell happens to touch on the way to the redirect gets
    // a benign empty body rather than a hard 404.
    await fulfillJson(route, {})
  })
}

/** Minimal but shape-complete BootstrapResponse so CompanyShell resolves. */
function bootstrapFixture(): Record<string, unknown> {
  return {
    company: { id: INVITE_COMPANY.id, name: INVITE_COMPANY.name, slug: INVITE_COMPANY.slug },
    template: { slug: 'generic', name: 'Generic', description: '' },
    workflowStages: [],
    divisions: [],
    serviceItems: [],
    customers: [],
    projects: [],
    workers: [],
    pricingProfiles: [],
    bonusRules: [],
    integrations: [],
    integrationMappings: [],
    laborEntries: [],
    materialBills: [],
    schedules: [],
    projectAssignments: [],
  }
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(),
    body: JSON.stringify(body),
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': WEB_ORIGIN,
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,x-request-id,sentry-trace,baggage,x-sitelayer-act-as,x-sitelayer-company-slug,x-sitelayer-user-id',
  }
}
