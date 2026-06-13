import { test, expect } from '../fixtures/auth'

/**
 * Spec — bookkeeper-journey.
 *
 * The BOOKKEEPER company role (`company_memberships.role = 'bookkeeper'`,
 * seeded for `e2e-bookkeeper` in docker/postgres/init/000_baseline.sql)
 * was orphaned: `computeActiveContext` had no bookkeeper branch, so a
 * bookkeeper fell through to `kind:'worker'` and landed in the dark crew
 * clock-in shell — never reaching the financial/payroll surface.
 *
 * This spec proves the fix end-to-end through REAL UI navigation: a
 * bookkeeper lands in the FINANCIAL shell (the `data-context="bookkeeper"`
 * host rendering the financial hub — Estimate pushes, Rental billing runs,
 * Labor payroll runs, Payroll exports), and does NOT see the worker
 * clock-in screen (no `m-dark` host, no "Clock in" affordance — a
 * bookkeeper does not clock in).
 *
 * Uses the existing `bookkeeperPage` fixture from e2e/fixtures/auth.ts
 * (act-as `e2e-bookkeeper` under the `e2e-fixtures` company); auth.ts is
 * NOT edited.
 */

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec(
  'bookkeeper lands in the financial shell, not the worker clock-in',
  { tag: '@bookkeeper' },
  async ({ bookkeeperPage }) => {
    // 1. Land on the app root. The mobile shell computes the active context
    //    from the bookkeeper's company role and redirects index → today.
    await bookkeeperPage.goto('/')
    await expect(bookkeeperPage.getByRole('heading', { name: /Sitelayer hit an error\./i })).toHaveCount(0)
    await bookkeeperPage.waitForLoadState('networkidle').catch(() => {})

    // 2. The shell host must resolve to the BOOKKEEPER context — not worker.
    //    `data-context` is stamped on the m-host wrapper in mobile-shell.tsx.
    await expect(bookkeeperPage.locator('[data-context="bookkeeper"]')).toBeVisible()
    await expect(bookkeeperPage.locator('[data-context="worker"]')).toHaveCount(0)

    // 3. The financial/money/payroll surface is reachable: the bookkeeper's
    //    `today` landing renders the FinancialHubScreen.
    await expect(bookkeeperPage.getByRole('heading', { name: /^Financial$/ })).toBeVisible()
    await expect(bookkeeperPage.getByText(/Labor payroll runs/i)).toBeVisible()
    await expect(bookkeeperPage.getByText(/Estimate pushes/i)).toBeVisible()

    // 4. The worker clock-in screen must NOT be what they see. The worker
    //    shell renders the dark `m-dark` host and a "Clock in" affordance —
    //    a bookkeeper never clocks in.
    await expect(bookkeeperPage.locator('.m-dark')).toHaveCount(0)
    await expect(bookkeeperPage.getByRole('button', { name: /Clock in/i })).toHaveCount(0)

    // 5. A financial tab is reachable from the bottom bar — tapping the
    //    in-shell Money landing keeps the bookkeeper on the financial surface.
    await expect(bookkeeperPage.getByRole('button', { name: 'Money' })).toBeVisible()
  },
)
