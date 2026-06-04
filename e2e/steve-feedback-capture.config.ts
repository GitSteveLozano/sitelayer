import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Browser smoke for Steve's no-plugin review link.
 *
 * Starts only the Vite web server and mocks the capture API. This verifies the
 * public `/collab/steve` entry, same-tab redirect, prewarmed text issue capture
 * session, submit-time upsert, and finalization receipt without a database.
 *
 *   npm run capture:steve-smoke
 */
const WEB_PORT = Number(process.env.STEVE_CAPTURE_SMOKE_WEB_PORT ?? 5175)
const API_PORT = Number(process.env.STEVE_CAPTURE_SMOKE_API_PORT ?? process.env.E2E_API_PORT ?? 3001)

const webServer: PlaywrightTestConfig['webServer'] = {
  command: `npm --workspace @sitelayer/web exec vite -- --host 0.0.0.0 --port ${WEB_PORT}`,
  url: `http://localhost:${WEB_PORT}`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  stdout: 'pipe',
  stderr: 'pipe',
  env: {
    VITE_API_URL: `http://localhost:${API_PORT}`,
    VITE_CACHE_DIR: '/tmp/sitelayer-vite-cache-steve-capture-smoke',
    VITE_DEFAULT_COMPANY_SLUG: 'e2e-fixtures',
  },
}

export default defineConfig({
  testDir: './tests',
  testMatch: 'steve-feedback-capture.smoke.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  webServer,
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
