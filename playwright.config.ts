import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Playwright config for sitelayer role-based workflow E2E tests.
 *
 * Specs assume:
 *   1. Migration `072_e2e_test_fixtures.sql` has been applied (parallel PR) —
 *      it creates the `e2e-fixtures` company plus the five role users:
 *      `e2e-admin`, `e2e-foreman`, `e2e-office`, `e2e-member`, `e2e-bookkeeper`.
 *   2. `apps/api/scripts/seed-e2e-fixtures.ts` has populated one ready-state
 *      row per workflow under that company.
 *   3. The API accepts the dev `x-sitelayer-act-as: <user_id>` header
 *      (also a parallel PR) — when set, the API resolves identity to that
 *      user without requiring a Clerk token. The web SPA reads
 *      `localStorage['sitelayer.act-as']` and forwards the header.
 *
 * Until the parallel PRs land the specs are written but expected to be
 * `test.skip`ed via E2E_SKIP=1 in CI. Once they merge, drop the skip env.
 *
 * Ports: API on 3001 (apps/api/src/server.ts), web dev server on 3100
 * (apps/web/vite.config.ts). The user-supplied spec mentioned 3000 for
 * the web port — overridden here to match the canonical Vite port so the
 * webserver block actually finds the running process.
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100)
const API_PORT = Number(process.env.E2E_API_PORT ?? 3001)

const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`

const webServer: PlaywrightTestConfig['webServer'] = [
  {
    command: 'npm --workspace @sitelayer/api run dev',
    url: `http://localhost:${API_PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(API_PORT),
      APP_TIER: process.env.APP_TIER ?? 'local',
      AUTH_ALLOW_HEADER_FALLBACK: '1',
      ACTIVE_COMPANY_SLUG: 'e2e-fixtures',
      ACTIVE_USER_ID: 'e2e-admin',
    },
  },
  {
    command: 'npm --workspace @sitelayer/web run dev',
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      VITE_API_URL: `http://localhost:${API_PORT}`,
      VITE_DEFAULT_COMPANY_SLUG: 'e2e-fixtures',
    },
  },
]

// `exactOptionalPropertyTypes: true` disallows passing an explicit
// `undefined` to optional config fields. When the caller flips
// `E2E_SKIP_WEBSERVER=1` (CI starts the servers itself), omit the
// `webServer` key from the object entirely.
const baseConfig: PlaywrightTestConfig = {
  testDir: './e2e',
  // Sequential mode — the seed pre-creates one row per workflow under the
  // shared `e2e-fixtures` company. Running tests in parallel would race
  // for the same workflow snapshot rows (`state_version` conflicts).
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // These specs mutate deterministic workflow rows seeded once per run.
  // A failed attempt leaves the row advanced and poisons its own retry, so
  // retries add noise instead of signal.
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
}

export default defineConfig(process.env.E2E_SKIP_WEBSERVER ? baseConfig : { ...baseConfig, webServer })
