import { defineConfig } from '@playwright/test'

/**
 * Visual-baseline capture config for the visregress gate.
 *
 * This config is NOT the e2e gate and NOT the walkthrough recorder — its only
 * job is to drive the top-N high-value screens to a deterministic ready-state
 * and write a full-page PNG into e2e/visual/__baselines__/. Those PNGs are the
 * BASELINES consumed by the shared `visregress` analyzer (see e2e/visregress/).
 *
 * It runs against an already-running app via E2E_BASE_URL (the persistent dev
 * tier by default) with NO webServer block — the runner points Playwright at
 * the target. workers:1 + fullyParallel:false keep the captures serialized and
 * stable so a re-capture is byte-comparable.
 *
 *   # capture/refresh baselines against dev:
 *   npx playwright test -c e2e/visual.config.ts
 *   # against a local stack:
 *   E2E_BASE_URL=http://localhost:3100 npx playwright test -c e2e/visual.config.ts
 */
const baseURL = process.env.E2E_BASE_URL ?? 'https://dev.sitelayer.sandolab.xyz'

export default defineConfig({
  testDir: './visual',
  testMatch: '**/*.visual.spec.ts',
  outputDir: process.env.VISUAL_OUT ?? './visual/.artifacts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
})
