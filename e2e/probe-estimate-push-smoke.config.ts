import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Local acceptance smoke for the ADR-0019 estimate-push Probe.
 *
 * This deliberately starts only the Vite web server. The spec mocks the
 * existing API calls made by `/financial/estimate-pushes/:id`, which keeps the
 * smoke runnable without a seeded database, Clerk, QBO, worker, or production
 * deploy:
 *
 *   npm run probe:estimate-push:smoke
 */
const WEB_PORT = Number(process.env.PROBE_SMOKE_WEB_PORT ?? 3100)
const API_PORT = Number(process.env.PROBE_SMOKE_API_PORT ?? 3001)

const webServer: PlaywrightTestConfig['webServer'] = {
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
}

export default defineConfig({
  testDir: './tests',
  testMatch: 'probe-estimate-push-capture.smoke.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  webServer,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
