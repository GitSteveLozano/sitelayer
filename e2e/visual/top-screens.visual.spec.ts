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
