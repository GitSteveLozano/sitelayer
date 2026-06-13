import { defineConfig } from '@playwright/test'

/**
 * Post-deploy authenticated-mount synthetic config (gap #8).
 *
 * Runs against an ALREADY-RUNNING, just-deployed tier via E2E_BASE_URL (no
 * webServer block — the deploy already stood the app up). It mounts a handful
 * of authenticated React screens in a headless browser and asserts each one
 * renders without crashing into the root error boundary — the render check the
 * JSON-only deploy smoke (scripts/smoke-tier.sh) is blind to.
 *
 * Invoked by scripts/render-synthetic.sh, which is wired into the tail of
 * scripts/fleet-auto-deploy.sh right after the smoke step.
 *
 *   # against the dev tier:
 *   E2E_BASE_URL=https://dev.sitelayer.sandolab.xyz npx playwright test -c e2e/synthetic.config.ts
 *   # against a local stack:
 *   E2E_BASE_URL=http://localhost:3500 npx playwright test -c e2e/synthetic.config.ts
 */
const baseURL = process.env.E2E_BASE_URL ?? 'https://dev.sitelayer.sandolab.xyz'

export default defineConfig({
  testDir: './synthetic',
  testMatch: '**/*.synthetic.spec.ts',
  outputDir: process.env.SYNTHETIC_OUT ?? './synthetic/.artifacts',
  workers: 1,
  fullyParallel: false,
  retries: Number(process.env.SYNTHETIC_RETRIES ?? 1),
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
})
