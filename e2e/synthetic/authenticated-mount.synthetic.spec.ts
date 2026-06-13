import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

/**
 * Post-deploy authenticated-MOUNT synthetic (gap #8).
 *
 * The deploy smoke (scripts/smoke-tier.sh) only probes JSON endpoints
 * (/health, /api/version, /api/session, /api/bootstrap, /api/demo) — so a
 * screen that was ported but lost its render wiring still ships at HTTP 200
 * and the smoke stays green. This synthetic closes that blind spot: it drives
 * a HEADLESS browser to actually MOUNT a handful of authenticated React
 * screens against a live tier and asserts each one RENDERS (no root error
 * boundary, not a blank page), catching a blind port that the JSON smoke
 * cannot see.
 *
 * It is deliberately THIN + FAST: a few routes, a short ready-wait per route,
 * one shared authenticated context. It runs AFTER the smoke in
 * scripts/fleet-auto-deploy.sh (via scripts/render-synthetic.sh).
 *
 * AUTH CHANNEL. We reuse the same dev act-as identity the e2e fixtures and the
 * visual baselines use: an `x-sitelayer-act-as` header + matching localStorage,
 * scoped to the `e2e-fixtures` (override: SYNTHETIC_COMPANY_SLUG) company. This
 * is the identity that travels on the DEV tier (header fallback ON). On the
 * DEMO tier the API runs Clerk-ON and ignores the act-as header, so the authed
 * routes redirect to the sign-in shell; that is NOT a render failure, so the
 * synthetic treats a Clerk-gated redirect as a graceful SKIP for that route
 * rather than a crash (the JSON smoke already proves the demo tier is alive +
 * correctly auth-gated). The whole synthetic is therefore most meaningful on
 * the dev tier, which is exactly where the blind ports land first.
 *
 * NEVER touches app source. Lives entirely under e2e/.
 */

const COMPANY_SLUG = process.env.SYNTHETIC_COMPANY_SLUG ?? 'e2e-fixtures'
const ROLE = process.env.SYNTHETIC_ACT_AS ?? 'e2e-admin'

// A seeded work-item id is not guaranteed for the owner-denied loop, so we use
// a stable fixture-style id and assert the screen MOUNTS (it renders a
// skeleton / not-found shell for a missing item — that is a render, not a
// crash). Override with E2E_FIELD_REQUEST_ID if a seed provides a real one.
const DENIED_ID = process.env.E2E_FIELD_REQUEST_ID ?? '00000000-0000-4000-8000-000000000209'

/**
 * The routes to mount. One per ported cluster + the owner-denied screen that
 * was one of tonight's new ports (the task names /foreman/denied/:id):
 *   - /projects              PROJECTS cluster (R2)
 *   - /settings              SETTINGS cluster (R1)
 *   - /financial/billing-runs   FINANCIAL cluster (R3)
 *   - /rentals/utilization   INVENTORY/rentals cluster (R4)
 *   - /foreman/denied/:id    tonight's owner-denied → foreman loop screen
 *
 * Plus the onboarding + role first-run takeovers (A7). These are pre-workspace
 * full-screen mounts in App.tsx (owner onboarding + the three teammate
 * first-run primers) — the literal first screen every new pilot user sees, and
 * previously the one cluster with zero render-crash coverage. They render
 * without a seeded workspace, so the MOUNT guard is the cheapest catch for a
 * blind port that lost its render wiring on the first-run path.
 */
const ROUTES: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'projects-list', path: '/projects' },
  { name: 'settings-home', path: '/settings' },
  { name: 'billing-runs', path: '/financial/billing-runs' },
  { name: 'rentals-utilization', path: '/rentals/utilization' },
  { name: 'foreman-denied', path: `/foreman/denied/${DENIED_ID}` },
  { name: 'owner-onboarding', path: '/owner/onboarding' },
  { name: 'foreman-first-run', path: '/foreman/first-run' },
  { name: 'worker-first-run', path: '/worker/first-run' },
  { name: 'estimator-first-run', path: '/estimator/first-run' },
]

async function buildAuthedPage(context: BrowserContext): Promise<Page> {
  await context.setExtraHTTPHeaders({
    'x-sitelayer-act-as': ROLE,
    'x-sitelayer-company-slug': COMPANY_SLUG,
    'x-sitelayer-user-id': ROLE,
  })
  await context.addInitScript(
    ([roleId, slug]) => {
      try {
        window.localStorage.setItem('sitelayer.act-as', roleId)
        window.localStorage.setItem('sitelayer.active-company-slug', slug)
      } catch {
        /* private-mode storage disabled — the route still mounts the shell */
      }
    },
    [ROLE, COMPANY_SLUG] as const,
  )
  return context.newPage()
}

/** True when the page is sitting on the Clerk sign-in shell (demo tier). */
async function isClerkGated(page: Page): Promise<boolean> {
  // The SPA renders Clerk's <SignIn /> when configured + unauthenticated; the
  // act-as header is ignored on the prod/demo tier. A visible sign-in form (or
  // a redirect to /sign-in) means "auth-gated", not "crashed".
  if (/\/sign-in|\/sign-up/.test(new URL(page.url()).pathname)) return true
  const signInVisible = await page
    .getByText(/sign in|continue with/i)
    .first()
    .isVisible()
    .catch(() => false)
  return signInVisible
}

const test = base

for (const route of ROUTES) {
  test(`mounts ${route.name} (${route.path}) without an error boundary`, async ({ context }) => {
    const page = await buildAuthedPage(context)
    await page.goto(route.path, { waitUntil: 'domcontentloaded' })
    // Let the SPA bootstrap + the screen's first data fetch settle.
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(800)

    // 1. The root error boundary (apps/web/src/main.tsx RootError) renders this
    //    exact heading when a screen throws during render. Its presence is a
    //    hard FAIL — that is precisely the blind-port crash this synthetic
    //    exists to catch.
    await expect(
      page.getByRole('heading', { name: /Sitelayer hit an error\./i }),
      `${route.path} mounted into the ROOT ERROR BOUNDARY (a render crash)`,
    ).toHaveCount(0)

    // 2. Clerk-gated (demo tier): not a crash — skip the not-blank assertion.
    if (await isClerkGated(page)) {
      test.info().annotations.push({
        type: 'skip-reason',
        description: `${route.path}: Clerk-gated (auth shell) — render not asserted`,
      })
      return
    }

    // 3. Not blank: the mounted screen must have rendered SOME visible text.
    //    A blank body (lost render) is the other failure mode the JSON smoke
    //    can't see. We assert the document body carries non-trivial text.
    const bodyText =
      (await page
        .locator('body')
        .innerText()
        .catch(() => '')) ?? ''
    expect(
      bodyText.trim().length,
      `${route.path} rendered a BLANK page (no visible text) — lost render?`,
    ).toBeGreaterThan(2)

    await page.close()
  })
}
