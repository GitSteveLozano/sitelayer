import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A DETERMINISTIC walkthrough of the public 3D takeoff demo.
 *
 * The /demo/takeoff-preview-3d route is client-side fixtures — no auth, no
 * backend — so the same run produces the same states (and thus the same video)
 * every time. That stability is exactly what lets a gemini-video pass verify
 * the recording against WALKTHROUGH_STEPS deterministically.
 *
 * To add a new walkthrough: drop another *.walkthrough.spec.ts here that drives
 * a deterministic flow (a public demo, or a seeded `?seed=<name>` XState posture
 * with API mocks à la takeoff-preview.smoke.spec.ts), pause ~2.5s per step so
 * the video shows it, and write a walkthrough-steps.json narrative.
 */

export const WALKTHROUGH_STEPS = [
  {
    n: 1,
    action: 'Open the 3D takeoff demo',
    expect: 'a "3D takeoff demo" heading and a "Simple house plan" fixture option',
  },
  {
    n: 2,
    action: 'Switch to the floor-plan fixture',
    expect: 'the page shows "Blueprint-style floor plan" and "drawable measurements", and a 3D canvas renders',
  },
  {
    n: 3,
    action: 'Open the Scene JSON panel',
    expect: 'a JSON debug panel containing a service_item_code value',
  },
] as const

test('takeoff 3D demo — deterministic walkthrough', { tag: '@walkthrough' }, async ({ page }, testInfo) => {
  // Step 1 — open the demo.
  await page.goto('/demo/takeoff-preview-3d', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: '3D takeoff demo' })).toBeVisible()
  await expect(page.getByText('Simple house plan', { exact: true }).first()).toBeVisible()
  await page.waitForTimeout(2500)

  // Step 2 — switch fixture; confirm the new fixture + a live canvas.
  await page.getByTestId('takeoff-demo-fixture-floor-plan').click()
  await expect(page).toHaveURL(/fixture=floor-plan/)
  await expect(page.getByText('Blueprint-style floor plan', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('drawable measurements')).toBeVisible()
  const canvas = page.getByTestId('takeoff-preview-canvas')
  await expect(canvas).toBeVisible()
  await expect
    .poll(() => canvas.evaluate((n) => (n as HTMLCanvasElement).width * (n as HTMLCanvasElement).height))
    .toBeGreaterThan(0)
  await page.waitForTimeout(2500)

  // Step 3 — open the scene JSON and make it visibly the active panel so the
  // recording (and thus gemini-video) actually sees the switch, not just the DOM.
  await page.getByText('Scene JSON').click()
  const debugJson = page.getByTestId('takeoff-demo-debug-json')
  await debugJson.scrollIntoViewIfNeeded()
  await expect(debugJson).toBeVisible()
  await expect(debugJson).toContainText('service_item_code')
  await page.waitForTimeout(3000)

  // Emit the expected-step narrative next to the recorded video so the
  // gemini-video verifier knows what the walkthrough should show. Ensure the
  // per-test output dir exists — the video isn't flushed until teardown, so the
  // dir may not exist yet during the test body.
  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(
    path.join(testInfo.outputDir, 'walkthrough-steps.json'),
    JSON.stringify({ title: 'takeoff 3D demo walkthrough', steps: WALKTHROUGH_STEPS }, null, 2),
  )
})
