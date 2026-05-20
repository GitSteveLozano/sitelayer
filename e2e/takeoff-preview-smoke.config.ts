import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Local smoke for the 3D takeoff preview.
 *
 * Starts only the Vite web server. The spec mocks the project/takeoff API
 * calls so it can verify WebGL rendering without a seeded DB, Clerk, object
 * storage, or a live blueprint upload.
 *
 *   npm run takeoff-preview:smoke
 */
const WEB_PORT = Number(process.env.TAKEOFF_PREVIEW_SMOKE_WEB_PORT ?? 3100)
const API_PORT = Number(process.env.TAKEOFF_PREVIEW_SMOKE_API_PORT ?? 3001)

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
  testMatch: 'takeoff-preview.smoke.spec.ts',
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
