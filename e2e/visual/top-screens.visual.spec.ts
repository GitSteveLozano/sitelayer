import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test as base, type BrowserContext, type Page } from '@playwright/test'

/**
 * Baseline-capture spec for the visregress visual-regression gate.
 *
 * Each test drives ONE high-value screen to a deterministic ready-state and
 * writes a full-page PNG into e2e/visual/__baselines__/<id>.png. Those PNGs are
 * the baselines the shared `visregress` analyzer pairs against a fresh candidate
 * (see e2e/visregress/run.mjs). Re-running this spec REFRESHES the baselines —
 * run it only when the current UI is the known-good reference.
 *
 * Three screens (the top-value surfaces named in the gate task):
 *   1. takeoff-3d-demo   — public /demo/takeoff-preview-3d (no auth, fully
 *      client-side fixtures → byte-stable; the reliable bootstrap baseline).
 *   2. rental-billing-review — the rental-billing run review surface.
 *   3. estimate-push-review  — the estimate-push run review surface.
 *
 * (2) and (3) authenticate with the same act-as channel the e2e fixtures use
 * (e2e/fixtures/auth.ts buildRolePage); against a tier with no seeded runs they
 * still render a stable list/empty-state, which is a valid baseline. They are
 * captured best-effort so the gate is meaningful even when only the public demo
 * is reachable.
 */

// Playwright runs from the repo root; the visual config's testDir is e2e/visual.
// Resolve the snapshot dir from cwd so the path matches run.mjs's BASELINES.
//
// This SAME spec produces both the committed BASELINES and the fresh CANDIDATES:
//   - default (no env)             -> e2e/visual/__baselines__  (refresh the reference)
//   - VISUAL_SNAP_DIR=<absdir/rel> -> that dir                  (run.mjs renders candidates)
// run.mjs sets VISUAL_SNAP_DIR=e2e/visual/__candidates__ so the gate compares a FRESH
// capture of the live UI against the committed baselines — never baseline-vs-baseline.
const SNAP_DIR = process.env.VISUAL_SNAP_DIR
  ? path.resolve(process.cwd(), process.env.VISUAL_SNAP_DIR)
  : path.join(process.cwd(), 'e2e/visual/__baselines__')

const E2E_COMPANY_SLUG = 'e2e-fixtures'

async function buildRolePage(context: BrowserContext, role: string): Promise<Page> {
  // Mirror e2e/fixtures/auth.ts: act-as header on the context + localStorage so
  // the very first SPA bootstrap fetch already carries the identity.
  await context.setExtraHTTPHeaders({
    'x-sitelayer-act-as': role,
    'x-sitelayer-company-slug': E2E_COMPANY_SLUG,
    'x-sitelayer-user-id': role,
  })
  await context.addInitScript(
    ([roleId, slug]) => {
      try {
        window.localStorage.setItem('sitelayer.act-as', roleId)
        window.localStorage.setItem('sitelayer.active-company-slug', slug)
      } catch {
        /* private-mode storage disabled — spec falls through to whatever renders */
      }
    },
    [role, E2E_COMPANY_SLUG] as const,
  )
  return context.newPage()
}

async function snap(page: Page, id: string): Promise<void> {
  mkdirSync(SNAP_DIR, { recursive: true })
  // Let async data / canvas settle so the capture is deterministic.
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(SNAP_DIR, `${id}.png`), fullPage: true })
}

/**
 * Resolve the id of a seeded project the act-as identity can see, for the
 * heavy-flow capture screens that live behind a `:projectId` param route
 * (takeoff canvas, blueprint viewer, scope-vs-bid). `page.request` already
 * carries the act-as + company-slug headers from buildRolePage, so the same
 * /api/bootstrap the SPA calls returns the role's project list.
 *
 * NEVER throws — a missing project / unreachable API yields null, and the
 * caller falls back to a deterministic placeholder id so the capture still
 * renders the screen's stable empty/error shell (a valid first-run candidate;
 * the real baseline is committed later in the canonical seeded env).
 */
async function firstProjectId(page: Page): Promise<string | null> {
  try {
    const res = await page.request.get('/api/bootstrap')
    if (!res.ok()) return null
    const body = (await res.json()) as { projects?: Array<{ id?: string }> }
    const id = body?.projects?.find((p) => typeof p?.id === 'string' && p.id)?.id
    return id ?? null
  } catch {
    return null
  }
}

/**
 * Resolve a portal estimate share token (the customer portal is auth-free but
 * keyed by an opaque share token). Tries the seeded admin's estimate-shares
 * list; falls back to null so the caller can capture the portal's "invalid /
 * not-found token" shell — itself a stable, deterministic candidate.
 *
 * NEVER throws.
 */
async function firstShareToken(context: BrowserContext): Promise<string | null> {
  try {
    const probe = await context.request.get('/api/estimate-shares', {
      headers: {
        'x-sitelayer-act-as': 'e2e-admin',
        'x-sitelayer-company-slug': E2E_COMPANY_SLUG,
        'x-sitelayer-user-id': 'e2e-admin',
      },
    })
    if (!probe.ok()) return null
    const body = (await probe.json()) as {
      shares?: Array<{ share_token?: string; token?: string }>
    }
    const row = body?.shares?.find((s) => s?.share_token || s?.token)
    return row?.share_token ?? row?.token ?? null
  } catch {
    return null
  }
}

const test = base

test('baseline: takeoff-3d-demo', { tag: '@visual' }, async ({ page }) => {
  // Public, client-side fixtures → no auth, deterministic.
  await page.goto('/demo/takeoff-preview-3d', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '3D takeoff demo' }).waitFor({ state: 'visible' })
  await page.getByText('Simple house plan', { exact: true }).first().waitFor({ state: 'visible' })
  // Wait for the WebGL canvas to actually render pixels before we snap.
  const canvas = page.getByTestId('takeoff-preview-canvas')
  await canvas.waitFor({ state: 'visible' }).catch(() => {})
  await snap(page, 'takeoff-3d-demo')
})

test('baseline: rental-billing-review', { tag: '@visual' }, async ({ context }) => {
  const page = await buildRolePage(context, 'e2e-admin')
  await page.goto('/financial/billing-runs', { waitUntil: 'domcontentloaded' })
  // Ready-wait: the financial shell renders a heading even with no seeded runs.
  await page
    .getByRole('heading')
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'rental-billing-review')
  await page.close()
})

test('baseline: estimate-push-review', { tag: '@visual' }, async ({ context }) => {
  const page = await buildRolePage(context, 'e2e-admin')
  await page.goto('/financial/estimate-pushes', { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('heading')
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'estimate-push-review')
  await page.close()
})

/*
 * Cluster-coverage baselines (gap #6). One representative route per ported
 * cluster so the visual gate is no longer blind to ~60 mechanical ports. Each
 * is captured best-effort against the seeded e2e stack; the ready-wait keys off
 * a stable MTopBar title (the visual top bar these screens all render) rather
 * than a brittle data-dependent element, so the baseline is the screen's stable
 * shell + list/empty-state.
 */

test('baseline: settings-home', { tag: '@visual' }, async ({ context }) => {
  // SETTINGS cluster (R1). `/settings` renders the designed settings hub with a
  // "Settings" top bar (apps/web/src/screens/settings/settings-home.tsx).
  const page = await buildRolePage(context, 'e2e-admin')
  await page.goto('/settings', { waitUntil: 'domcontentloaded' })
  await page
    .getByText('Settings', { exact: true })
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'settings-home')
  await page.close()
})

test('baseline: projects-list', { tag: '@visual' }, async ({ context }) => {
  // PROJECTS cluster (R2). `/projects` renders MobileProjectsList with a
  // "Projects" top bar (apps/web/src/screens/mobile/projects-list.tsx).
  const page = await buildRolePage(context, 'e2e-admin')
  await page.goto('/projects', { waitUntil: 'domcontentloaded' })
  await page
    .getByText('Projects', { exact: true })
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'projects-list')
  await page.close()
})

test('baseline: rentals-utilization', { tag: '@visual' }, async ({ context }) => {
  // INVENTORY/rentals cluster (R4). `/rentals/utilization` renders
  // MobileRentalsUtilization with a "Rentals" top bar
  // (apps/web/src/screens/mobile/rentals-utilization.tsx).
  const page = await buildRolePage(context, 'e2e-admin')
  await page.goto('/rentals/utilization', { waitUntil: 'domcontentloaded' })
  await page
    .getByText('Rentals', { exact: true })
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'rentals-utilization')
  await page.close()
})

/*
 * Additional per-cluster coverage (gaps #6/#7). One representative route each
 * for clusters the gate was previously blind to. Captured best-effort on the
 * seeded stack; ready-waits never throw, so snap() always runs the settled
 * capture. These have no committed baseline yet — run.mjs reports them as
 * "no baseline / first-run" until a canonical baseline is captured here.
 */

test('baseline: foreman-field', { tag: '@visual' }, async ({ context }) => {
  // FIELD cluster. `/field` renders the foreman field inbox with a "Field" top
  // bar (apps/web/src/screens/mobile/foreman-field.tsx).
  const page = await buildRolePage(context, 'e2e-foreman')
  await page.goto('/field', { waitUntil: 'domcontentloaded' })
  await page
    .getByText('Field', { exact: true })
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'foreman-field')
  await page.close()
})

test('baseline: owner-money', { tag: '@visual' }, async ({ context }) => {
  // FINANCIAL/owner cluster. `/money` renders the owner money screen with a
  // "Money" top bar (apps/web/src/screens/mobile/owner-money.tsx).
  const page = await buildRolePage(context, 'e2e-admin')
  await page.goto('/money', { waitUntil: 'domcontentloaded' })
  await page
    .getByText('Money', { exact: true })
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'owner-money')
  await page.close()
})

test('baseline: foreman-crew', { tag: '@visual' }, async ({ context }) => {
  // CREW cluster. `/crew` renders the foreman crew screen.
  const page = await buildRolePage(context, 'e2e-foreman')
  await page.goto('/crew', { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('heading')
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'foreman-crew')
  await page.close()
})

test('baseline: worker-hours', { tag: '@visual' }, async ({ context }) => {
  // WORKER/crew cluster. `/hours` renders the worker hours screen.
  const page = await buildRolePage(context, 'e2e-member')
  await page.goto('/hours', { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('heading')
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'worker-hours')
  await page.close()
})

/*
 * Heavy-flow + missing-role-surface captures (VIS-2). These exercise the
 * surfaces the gate was structurally blind to — the live takeoff CANVAS, the
 * blueprint PDF viewer, the estimate scope-vs-bid screen, the customer PORTAL
 * estimate view, and an office/bookkeeper financial surface. Each resolves a
 * real seeded id where the route is param-keyed (via firstProjectId /
 * firstShareToken, which never throw) and falls back to a deterministic
 * placeholder so the screen's stable shell still renders. They produce
 * CANDIDATES today; baselines are captured later in the canonical seeded env
 * (top-value postures from scenarios/takeoff-canvas-states.yaml). All
 * ready-waits are `.catch(() => {})` so snap() always runs the settled
 * capture — a screen that only reaches its empty/error shell is still a valid
 * first-run candidate.
 */

test('baseline: takeoff-canvas', { tag: '@visual' }, async ({ context }) => {
  // Live takeoff CANVAS (the consolidated est-canvas editor). Mobile canonical
  // route is `/projects/:id/takeoff-mobile` (canvas-route.ts); desktop mounts
  // the SAME component at `/desktop/canvas/:id`. Seed via
  // scenarios/takeoff-canvas-states.yaml for the manual/uncal/ai/empty postures.
  const page = await buildRolePage(context, 'e2e-admin')
  const id = (await firstProjectId(page)) ?? 'seed-takeoff-project'
  await page.goto(`/projects/${id}/takeoff-mobile`, { waitUntil: 'domcontentloaded' })
  // Canvas mounts a lazy chunk + (when calibrated) a drawing surface; key off
  // the page settling rather than a brittle canvas element so an empty/cold
  // posture still captures.
  await page
    .getByRole('heading')
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'takeoff-canvas')
  await page.close()
})

test('baseline: blueprint-viewer', { tag: '@visual' }, async ({ context }) => {
  // Blueprint PDF viewer — `/projects/:id/takeoff-preview` renders the uploaded
  // blueprint page(s) + the 3D takeoff overlay (takeoff-preview.tsx). Seeded
  // scenarios store real PDF bytes (writeBlueprintSourceFiles), so against the
  // canonical stack this captures the actual sheet.
  const page = await buildRolePage(context, 'e2e-admin')
  const id = (await firstProjectId(page)) ?? 'seed-takeoff-project'
  await page.goto(`/projects/${id}/takeoff-preview`, { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('heading')
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'blueprint-viewer')
  await page.close()
})

test('baseline: estimate-scope-vs-bid', { tag: '@visual' }, async ({ context }) => {
  // Estimate scope-vs-bid screen — `/projects/:id/quantities` renders the
  // MobileEstQuantitiesSummary (the GET /estimate/scope-vs-bid surface) under a
  // stable "Quantities" top bar (est-quantities-summary.tsx).
  const page = await buildRolePage(context, 'e2e-admin')
  const id = (await firstProjectId(page)) ?? 'seed-takeoff-project'
  await page.goto(`/projects/${id}/quantities`, { waitUntil: 'domcontentloaded' })
  await page
    .getByText('Quantities', { exact: true })
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'estimate-scope-vs-bid')
  await page.close()
})

test('baseline: portal-estimate', { tag: '@visual' }, async ({ context }) => {
  // Customer PORTAL estimate view — `/portal/estimates/:shareToken` is auth-free
  // (no Clerk, no act-as) and renders the view + Accept/Decline CTAs
  // (portal/EstimateView.tsx). A missing/invalid token renders the portal's
  // stable error shell, which is itself a deterministic candidate.
  const token = (await firstShareToken(context)) ?? 'seed-share-token'
  const page = await context.newPage()
  await page.goto(`/portal/estimates/${token}`, { waitUntil: 'domcontentloaded' })
  // Either the loaded estimate (Accept estimate) or the error/loading shell;
  // wait for the page body to settle without asserting a specific state.
  await page
    .getByText(/Accept estimate|Loading|Estimate/i)
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'portal-estimate')
  await page.close()
})

test('baseline: office-financial', { tag: '@visual' }, async ({ context }) => {
  // OFFICE / bookkeeper surface — the office persona lands the admin/financial
  // shell at runtime; capture the financial billing-runs hub (the QBO-push
  // surface a bookkeeper/office persona works) under its stable shell heading.
  const page = await buildRolePage(context, 'e2e-office')
  await page.goto('/financial/billing-runs', { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('heading')
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {})
  await snap(page, 'office-financial')
  await page.close()
})
