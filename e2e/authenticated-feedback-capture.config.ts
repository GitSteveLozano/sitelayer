import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Browser smoke for the authenticated in-app feedback recorder against the real
 * Sitelayer API. Unlike portal-feedback-capture.config.ts, this does not mock
 * API routes; it requires a local/dev API and seeded e2e act-as auth.
 *
 *   npm run capture:auth-browser-smoke
 */
const WEB_PORT = Number(process.env.AUTH_CAPTURE_SMOKE_WEB_PORT ?? 5173)
const API_BASE = process.env.E2E_API_BASE_URL ?? process.env.SITELAYER_API_URL ?? 'http://localhost:3001'
type PlaywrightProject = NonNullable<PlaywrightTestConfig['projects']>[number]

const projectPresets: Record<string, PlaywrightProject> = {
  desktop: {
    name: 'desktop-chromium',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1280, height: 900 },
    },
  },
  mobile: {
    name: 'mobile-pixel-7',
    use: devices['Pixel 7'],
  },
  tablet: {
    name: 'tablet-chromium-touch',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 834, height: 1194 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  },
}

const requestedProjectKeys = (
  process.env.AUTH_CAPTURE_SMOKE_PROJECTS ??
  process.env.AUTH_CAPTURE_SMOKE_DEVICE ??
  'desktop'
)
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)
const projects = requestedProjectKeys.map((key) => {
  const project = projectPresets[key]
  if (!project) {
    throw new Error(
      `Unknown AUTH_CAPTURE_SMOKE_PROJECTS entry "${key}". Expected one of: ${Object.keys(projectPresets).join(', ')}`,
    )
  }
  return project
})

const webServer: PlaywrightTestConfig['webServer'] = {
  command: `npm --workspace @sitelayer/web exec vite -- --host 0.0.0.0 --port ${WEB_PORT}`,
  url: `http://localhost:${WEB_PORT}`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  stdout: 'pipe',
  stderr: 'pipe',
  env: {
    VITE_API_URL: API_BASE.replace(/\/+$/, ''),
    VITE_CACHE_DIR: '/tmp/sitelayer-vite-cache-auth-capture-smoke',
    VITE_DEFAULT_COMPANY_SLUG: 'e2e-fixtures',
    VITE_AUTH_CAPTURE_FEEDBACK: '1',
    VITE_AUTH_CAPTURE_REPLAY: '1',
  },
}

export default defineConfig({
  testDir: './tests',
  testMatch: 'authenticated-feedback-capture.live.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  webServer,
  projects,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
