import { test as base, type Page, type BrowserContext } from '@playwright/test'

/**
 * Role-based Playwright fixtures for sitelayer.
 *
 * Each `<role>Page` fixture returns a {@link Page} that is already
 * authenticated as the matching `e2e-<role>` user under the
 * `e2e-fixtures` company. Two channels carry the act-as identity:
 *
 *   1. `localStorage['sitelayer.act-as'] = 'e2e-<role>'` — the web
 *      bootstrap reads this and tags the in-flight API client so every
 *      subsequent fetch includes `x-sitelayer-act-as`. (Parallel PR.)
 *   2. `context.setExtraHTTPHeaders({...})` — direct `page.request.*`
 *      calls in specs (e.g. POSTing workflow events) carry the header
 *      themselves, bypassing the SPA entirely.
 *
 * `x-sitelayer-company-slug=e2e-fixtures` is set the same way on both
 * channels so the API resolves the row under the right tenant. We also
 * seed `sitelayer.active-company-slug` in localStorage so the SPA
 * picks the e2e company before the bootstrap call goes out.
 *
 * The five roles align 1:1 with seed users created in migration
 * `072_e2e_test_fixtures.sql`:
 *   - e2e-admin        company-role: admin
 *   - e2e-foreman      company-role: foreman, with a foreman project assignment
 *   - e2e-office       company-role: office
 *   - e2e-member       company-role: member (worker)
 *   - e2e-bookkeeper   company-role: admin (bookkeeper persona for QBO push)
 */

export const E2E_COMPANY_SLUG = 'e2e-fixtures'

export type RoleId = 'e2e-admin' | 'e2e-foreman' | 'e2e-office' | 'e2e-member' | 'e2e-bookkeeper'

type Fixtures = {
  adminPage: Page
  foremanPage: Page
  officePage: Page
  memberPage: Page
  bookkeeperPage: Page
}

async function buildRolePage(context: BrowserContext, role: RoleId): Promise<Page> {
  // 1. Default outbound headers — every fetch made via `page.request` or
  //    the page itself rides with these on. The web SPA also sends an
  //    `x-sitelayer-act-as` header sourced from localStorage; setting it
  //    here on the context too keeps things consistent for the API
  //    fallback path that bypasses the SPA cache.
  await context.setExtraHTTPHeaders({
    'x-sitelayer-act-as': role,
    'x-sitelayer-company-slug': E2E_COMPANY_SLUG,
    'x-sitelayer-user-id': role,
  })

  // 2. localStorage seeding — set BEFORE any SPA bootstrap fetch so the
  //    very first call out of `<App>` already carries the act-as id.
  //    Playwright runs init scripts on every navigation in the context,
  //    so this survives in-test page reloads too.
  await context.addInitScript(
    ([roleId, slug]) => {
      try {
        window.localStorage.setItem('sitelayer.act-as', roleId)
        window.localStorage.setItem('sitelayer.active-company-slug', slug)
      } catch {
        // Private-mode / storage-disabled browsers: tests skip rather
        // than blow up because there's nothing we can recover without
        // localStorage. The fixture catches this in the spec itself.
      }
    },
    [role, E2E_COMPANY_SLUG] as const,
  )

  const page = await context.newPage()
  return page
}

export const test = base.extend<Fixtures>({
  adminPage: async ({ context }, use) => {
    const page = await buildRolePage(context, 'e2e-admin')
    await use(page)
    await page.close()
  },
  foremanPage: async ({ context }, use) => {
    const page = await buildRolePage(context, 'e2e-foreman')
    await use(page)
    await page.close()
  },
  officePage: async ({ context }, use) => {
    const page = await buildRolePage(context, 'e2e-office')
    await use(page)
    await page.close()
  },
  memberPage: async ({ context }, use) => {
    const page = await buildRolePage(context, 'e2e-member')
    await use(page)
    await page.close()
  },
  bookkeeperPage: async ({ context }, use) => {
    const page = await buildRolePage(context, 'e2e-bookkeeper')
    await use(page)
    await page.close()
  },
})

export const expect = test.expect

/**
 * Convenience: pull a workflow snapshot via the page's request context.
 * Header fixtures (act-as + company slug) are already attached, so the
 * caller just supplies the resource path.
 */
export async function fetchWorkflowSnapshot<T = unknown>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path)
  if (!response.ok()) {
    throw new Error(`GET ${path} → ${response.status()}: ${await response.text()}`)
  }
  return (await response.json()) as T
}

/**
 * Convenience: POST a workflow event with the snapshot's current
 * `state_version`. Returns the parsed JSON response (the new snapshot).
 */
export async function dispatchWorkflowEvent<T = unknown>(
  page: Page,
  path: string,
  body: { event: string; state_version: number; [k: string]: unknown },
): Promise<T> {
  const response = await page.request.post(path, {
    data: body,
    headers: { 'content-type': 'application/json' },
  })
  if (!response.ok()) {
    throw new Error(`POST ${path} (${body.event}) → ${response.status()}: ${await response.text()}`)
  }
  return (await response.json()) as T
}
