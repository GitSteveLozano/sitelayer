import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Browser smoke for the invited public-portal feedback recorder.
 *
 * Starts only the Vite web server. The spec mocks signed portal API routes so
 * it can verify browser permissions, MediaRecorder flow, rrweb opt-in upload,
 * request headers, artifact upload, finalization, and discard surface without a
 * seeded database, Clerk, or worker.
 *
 *   npm run capture:portal-smoke
 */
const WEB_PORT = Number(process.env.PORTAL_CAPTURE_SMOKE_WEB_PORT ?? 3100)
const API_PORT = Number(process.env.PORTAL_CAPTURE_SMOKE_API_PORT ?? 3001)

const webServer: PlaywrightTestConfig['webServer'] = {
  command: 'npm --workspace @sitelayer/web run dev',
  url: `http://localhost:${WEB_PORT}`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  stdout: 'pipe',
  stderr: 'pipe',
  env: {
    VITE_API_URL: `http://localhost:${API_PORT}`,
    VITE_CACHE_DIR: '/tmp/sitelayer-vite-cache-portal-smoke',
    VITE_DEFAULT_COMPANY_SLUG: 'e2e-fixtures',
  },
}

export default defineConfig({
  testDir: './tests',
  testMatch: 'portal-feedback-capture.smoke.spec.ts',
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
