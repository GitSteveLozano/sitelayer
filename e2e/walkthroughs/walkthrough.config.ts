import { defineConfig } from '@playwright/test'

/**
 * Deterministic walkthrough harness config.
 *
 * Unlike the e2e gate (video: 'retain-on-failure'), a walkthrough ALWAYS
 * records video — the recording IS the artifact. It runs against an
 * already-running app via E2E_BASE_URL (dev by default) with NO webServer
 * block; the runner points Playwright at the target.
 *
 * The recorded video + the spec's exported step narrative
 * (walkthrough-steps.json, written next to the video) are the "walkthrough with
 * a video attached" that scripts/walkthrough/run-walkthrough.mjs then hands to
 * gemini-video to verify the walkthrough behaved as expected.
 *
 *   node scripts/walkthrough/run-walkthrough.mjs
 *   E2E_BASE_URL=http://localhost:3100 node scripts/walkthrough/run-walkthrough.mjs
 */
const baseURL = process.env.E2E_BASE_URL ?? 'https://dev.sitelayer.sandolab.xyz'

export default defineConfig({
  testDir: '.',
  outputDir: process.env.WALKTHROUGH_OUT ?? './.artifacts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Always retain a consistently-sized clip — the deterministic walkthrough's
    // whole point is a stable, gemini-verifiable recording.
    video: { mode: 'on', size: { width: 1280, height: 800 } },
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
})
