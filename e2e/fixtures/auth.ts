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

// API runs on a separate port from the web dev server (Vite). The web
// client (apps/web/src/lib/api/client.ts) hard-codes the cross-origin
// jump via `VITE_API_URL ?? 'http://localhost:3001'`. Playwright's
// `page.request.get(path)` resolves against the page baseURL (web port)
// — so an unqualified `/api/foo` would 404 onto the SPA shell. Build
// an absolute URL against the API host instead.
const E2E_API_PORT = process.env.E2E_API_PORT ?? '3001'
const E2E_API_BASE_URL = process.env.E2E_API_BASE_URL ?? `http://localhost:${E2E_API_PORT}`

function apiUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return `${E2E_API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Convenience: pull a workflow snapshot via the page's request context.
 * Header fixtures (act-as + company slug) are already attached, so the
 * caller just supplies the resource path.
 */
export async function fetchWorkflowSnapshot<T = unknown>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(apiUrl(path))
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
  const response = await page.request.post(apiUrl(path), {
    data: body,
    headers: { 'content-type': 'application/json' },
  })
  if (!response.ok()) {
    throw new Error(`POST ${path} (${body.event}) → ${response.status()}: ${await response.text()}`)
  }
  return (await response.json()) as T
}

/** The minimal snapshot contract every deterministic workflow GET/POST
 * returns: a literal `state` string and a monotonically-incrementing
 * `state_version` (the same shape `applyEventLog` asserts on, one tier
 * down at the reducer). Extra fields ride along untouched. */
export interface JourneySnapshot {
  state: string
  state_version: number
  [k: string]: unknown
}

/** One leg of a journey: dispatch `event` (with any extra payload merged
 * into the POST body) and assert the snapshot lands in `expectedState`. */
export interface JourneyStep {
  event: string
  /** Extra event-body fields merged alongside `{ event, state_version }`. */
  payload?: Record<string, unknown>
  expectedState: string
}

/** The two REST paths for one workflow entity (see
 * docs/DETERMINISTIC_WORKFLOWS.md): a snapshot GET and an events POST. */
export interface JourneyEntity {
  /** GET → `{ state, state_version, ... }` (the workflow snapshot). */
  snapshotPath: string
  /** POST `{ event, state_version }` → the next snapshot. */
  eventsPath: string
}

/** What `runJourney` returns: the initial + terminal snapshots and the
 * full per-step trail (each entry is the snapshot AFTER that step), so a
 * caller can make extra assertions on intermediate states. */
export interface JourneyResult<T extends JourneySnapshot = JourneySnapshot> {
  initial: T
  terminal: T
  /** Snapshot after each step, in order (`trail.length === steps.length`). */
  trail: T[]
}

/**
 * HTTP-tier journey replay — the e2e twin of
 * `packages/workflows/src/replay.ts:applyEventLog`.
 *
 * Where `applyEventLog` walks a persisted `workflow_event_log` through the
 * registered reducer and asserts "each transition lands the expected
 * snapshot" (schema match + `state_version` increments by exactly 1 + no
 * gaps + reducer output == persisted `snapshot_after`), `runJourney` does
 * the same proof one tier UP — against the LIVE API, over real HTTP. It
 * fetches the baseline snapshot, then for each step POSTs the event with
 * the current `state_version` (so a stale version 409s, exactly like the
 * optimistic-concurrency guard the reducer relies on) and asserts:
 *
 *   - the snapshot after the step is in `expectedState`, AND
 *   - `state_version` bumped by exactly 1 (the no-gap invariant),
 *
 * after every step AND that the terminal snapshot is the last step's
 * `expectedState`. The Playwright assertions ARE the contract: a divergent
 * server state (a transition that didn't land, an unexpected version jump)
 * fails the journey at the first divergence, the same place `applyEventLog`
 * records its first `issue`.
 *
 * Additive: takes the role `Page` (header fixtures already attached) and
 * drives `dispatchWorkflowEvent` / `fetchWorkflowSnapshot` — no new
 * transport. Returns the initial + terminal snapshots and the per-step
 * trail for any further assertions the caller wants to layer on.
 */
export async function runJourney<T extends JourneySnapshot = JourneySnapshot>(
  page: Page,
  entity: JourneyEntity,
  steps: readonly JourneyStep[],
): Promise<JourneyResult<T>> {
  const initial = await fetchWorkflowSnapshot<T>(page, entity.snapshotPath)
  let snap = initial
  const trail: T[] = []

  for (const step of steps) {
    const expectedVersion = snap.state_version + 1
    const next = await dispatchWorkflowEvent<T>(page, entity.eventsPath, {
      event: step.event,
      state_version: snap.state_version,
      ...(step.payload ?? {}),
    })
    // Per-step proof — mirrors applyEventLog's "snapshot_after matches" +
    // "state_version increments by exactly 1, no gaps" assertions.
    expect(next.state, `after ${step.event}`).toBe(step.expectedState)
    expect(next.state_version, `state_version after ${step.event}`).toBe(expectedVersion)
    trail.push(next)
    snap = next
  }

  // Terminal proof — the journey ended exactly where the last step said.
  // (No-op when steps is empty; the terminal is then the baseline.)
  const terminalExpected = steps.length > 0 ? steps[steps.length - 1]!.expectedState : initial.state
  expect(snap.state, 'terminal state').toBe(terminalExpected)

  return { initial, terminal: snap, trail }
}
