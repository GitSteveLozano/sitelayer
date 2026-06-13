import { test, expect } from '../fixtures/auth'
import type { Page, Route } from '@playwright/test'

/**
 * A3 (owner standup) — owner-onboarding journey.
 *
 * The owner-onboarding screen (`apps/web/src/screens/mobile/owner-onboarding.tsx`)
 * is the LIVE mobile first-run path: `AppShell`'s no-company redirect lands a
 * brand-new owner here. This spec drives the screen end-to-end and proves the
 * two writes the journey hangs on:
 *
 *   1. Company step → `POST /api/companies` with `seed_defaults: true` — i.e.
 *      the standup actually runs `seedCompanyDefaults` (the LA/GENERIC template
 *      that gives the new shop its divisions + service items).
 *   2. Ready step → "Create first project" → the screen now persists onboarding
 *      completion by latching `first_run_completed_at` on the owner's OWN
 *      membership via the existing `POST /api/memberships/:id/first-run-complete`
 *      primitive (resolved from `/api/session`), THEN routes to `/projects/new`.
 *      Before this wiring (G4 TODO) finish() threw the completion away, so a
 *      drop-off after step 1 looked "done" forever.
 *
 * IDENTITY rail: rides the act-as `adminPage` fixture (built by
 * `buildRolePage` in `fixtures/auth.ts`) so the screen renders under a real
 * owner identity. The handful of endpoints the screen calls are
 * Playwright-route-mocked so the journey is deterministic without a seeded
 * company-create gate or a live QBO round-trip — the same hybrid the
 * `probe-estimate-push-capture` smoke uses. `/owner/onboarding` is itself a
 * pre-workspace full-screen takeover, so it mounts without the workspace
 * bootstrap chain.
 *
 * Gated on `E2E_RUN=1` like the other live-stack specs so it only runs once the
 * web/api dev servers are up.
 */

const API_ORIGIN = `http://localhost:${process.env.E2E_API_PORT ?? '3001'}`
const WEB_ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? '3100'}`

const NEW_COMPANY = {
  id: 'company-owner-onboarding-spec',
  slug: 'davis-stucco',
  name: 'Davis Stucco LLC',
} as const

const OWNER_MEMBERSHIP_ID = 'membership-owner-onboarding-spec'

type CreateCompanyBody = { slug?: string; name?: string; seed_defaults?: boolean }

type OnboardingMockState = {
  createBodies: CreateCompanyBody[]
  firstRunCompletedMembershipIds: string[]
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec(
  'owner stands up a company → seeds defaults → finish persists first-run-complete',
  { tag: '@project' },
  async ({ adminPage }) => {
    const state: OnboardingMockState = { createBodies: [], firstRunCompletedMembershipIds: [] }
    await installOnboardingMocks(adminPage, state)

    await adminPage.goto('/owner/onboarding')

    // Step 1 · Company — name drives the slug silently; create runs the real
    // POST /api/companies contract (seed_defaults: true).
    await adminPage.getByLabel('Company name').fill(NEW_COMPANY.name)
    await adminPage.getByRole('button', { name: /Next · Crew size/i }).click()

    await expect.poll(() => state.createBodies.length, { timeout: 10_000 }).toBe(1)
    // seedCompanyDefaults runs iff seed_defaults !== false; the screen sends true.
    expect(state.createBodies[0]).toMatchObject({
      slug: NEW_COMPANY.slug,
      name: NEW_COMPANY.name,
      seed_defaults: true,
    })

    // Step 2 · Crew — presentational; advance.
    await expect(adminPage.getByRole('heading', { name: /Just you, or a crew\?/i })).toBeVisible()
    await adminPage.getByRole('button', { name: /Next · Integrations/i }).click()

    // Step 3 · Integrations — skippable; take the skip path (no live QBO).
    await expect(adminPage.getByRole('heading', { name: /Hook up your books\./i })).toBeVisible()
    await adminPage.getByRole('button', { name: /^Skip$/ }).click()

    // Step 4 · Ready — finish latches first-run-complete then routes to the
    // first-project screen.
    await expect(adminPage.getByRole('heading', { name: /You're set up\./i })).toBeVisible()
    await adminPage.getByRole('button', { name: /Create first project/i }).click()

    // The owner's own membership is marked first-run-complete via the EXISTING
    // primitive — proof the journey is now persisted, not thrown away.
    await expect.poll(() => state.firstRunCompletedMembershipIds, { timeout: 10_000 }).toContain(OWNER_MEMBERSHIP_ID)

    // …and the owner lands on /projects/new (the create-first-project handoff).
    await expect.poll(() => new URL(adminPage.url()).pathname, { timeout: 10_000 }).toBe('/projects/new')
  },
)

async function installOnboardingMocks(page: Page, state: OnboardingMockState): Promise<void> {
  await page.route(`${API_ORIGIN}/api/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    if (method === 'POST' && path === '/api/companies') {
      state.createBodies.push(JSON.parse(request.postData() ?? '{}') as CreateCompanyBody)
      await fulfillJson(
        route,
        {
          company: { ...NEW_COMPANY, created_at: '2026-06-13T00:00:00.000Z' },
          role: 'admin',
          seed_template: 'generic',
        },
        201,
      )
      return
    }

    // finish() resolves the owner's membership id from /api/session scoped to
    // the freshly-created slug, then marks it first-run-complete.
    if (method === 'GET' && path === '/api/session') {
      await fulfillJson(route, {
        user: { id: 'e2e-admin', role: 'admin' },
        activeCompany: { id: NEW_COMPANY.id, slug: NEW_COMPANY.slug, name: NEW_COMPANY.name },
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            company_id: NEW_COMPANY.id,
            clerk_user_id: 'e2e-admin',
            role: 'admin',
            created_at: '2026-06-13T00:00:00.000Z',
            slug: NEW_COMPANY.slug,
            name: NEW_COMPANY.name,
            first_run_completed_at: null,
          },
        ],
        app_issue_capabilities: [],
      })
      return
    }

    const firstRunMatch = path.match(/^\/api\/memberships\/([^/]+)\/first-run-complete$/)
    if (method === 'POST' && firstRunMatch) {
      const membershipId = decodeURIComponent(firstRunMatch[1]!)
      state.firstRunCompletedMembershipIds.push(membershipId)
      await fulfillJson(route, {
        membership: {
          id: membershipId,
          company_id: NEW_COMPANY.id,
          clerk_user_id: 'e2e-admin',
          role: 'admin',
          created_at: '2026-06-13T00:00:00.000Z',
          first_run_completed_at: '2026-06-13T00:05:00.000Z',
        },
      })
      return
    }

    // Anything else the onboarding takeover happens to touch (features ribbon
    // etc.) gets a benign empty body rather than a hard 404 that would surface
    // as an error banner mid-flow.
    await fulfillJson(route, {})
  })
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
