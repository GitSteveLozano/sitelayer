import { expect, test } from '@playwright/test'

// iPhone 12 viewport — representative mobile size used by the field crews.
// We deliberately keep this as raw width/height rather than devices['iPhone 12']
// so we don't depend on Playwright's mobile emulation (touch, UA) for the
// layout gates here. Layout is what we're asserting; touch behaviour is
// covered by the existing pan-overlay wiring.
test.use({ viewport: { width: 390, height: 844 } })

test('primary nav stays visible on iPhone viewport', async ({ page }) => {
  await page.goto('/confirm')

  const nav = page.getByRole('navigation', { name: 'Primary' })
  await expect(nav).toBeVisible()

  // Confirm Day is the high-frequency mobile target — it must render.
  await expect(page.getByTestId('nav-confirm')).toBeVisible()

  // Either the full link strip shows, or the hamburger toggle is offered.
  // Both are acceptable mobile shapes per the spec.
  const hamburger = page.getByTestId('mobile-nav-toggle')
  const projectsLink = page.getByRole('link', { name: 'Projects' })

  const hamburgerVisible = await hamburger.isVisible().catch(() => false)
  if (hamburgerVisible) {
    // Toggle must be functional: expanding reveals the secondary links.
    await hamburger.click()
    await expect(projectsLink).toBeVisible()
  } else {
    await expect(projectsLink).toBeVisible()
  }
})

test('/confirm renders with stack layout on phones', async ({ page }) => {
  await page.goto('/confirm')

  // Either the empty-state panel or the populated view renders. Both should
  // mount the Confirm Day heading without overflow.
  await expect(page.getByRole('heading', { name: /Confirm Day/i })).toBeVisible()

  const panel = page.locator('[data-testid="confirm-view"], [data-testid="confirm-empty"]').first()
  await expect(panel).toBeVisible()

  const box = await panel.boundingBox()
  expect(box).not.toBeNull()
  if (box) {
    // On a 390px viewport the panel should fit within the visible width.
    expect(box.width).toBeLessThanOrEqual(390)
  }

  // If the populated view renders, every crew row must be the phone card stack
  // (flex-column via mobile.css), not the desktop 6-column grid. We assert
  // width-vs-height ratio: stacked cards are taller than wide per entry.
  const confirmRows = page.locator('.confirmRow')
  const rowCount = await confirmRows.count()
  if (rowCount > 0) {
    const firstRow = confirmRows.first()
    const rowBox = await firstRow.boundingBox()
    expect(rowBox).not.toBeNull()
    if (rowBox) {
      // Stacked layout: row height should meaningfully exceed a single-line
      // desktop row (~36px). Anything >72px implies the controls wrapped.
      expect(rowBox.height).toBeGreaterThan(72)
    }
  }
})

test('primary buttons render at ≥44px tap height', async ({ page }) => {
  await page.goto('/projects')

  // The "Load company" button is always present in the Company Switcher panel.
  const loadButton = page.getByRole('button', { name: /Load company/i })
  await expect(loadButton).toBeVisible()

  const box = await loadButton.boundingBox()
  expect(box).not.toBeNull()
  if (box) {
    expect(box.height).toBeGreaterThanOrEqual(44)
  }

  // Spot-check several more buttons across the view to catch regressions
  // on the default/outline/secondary variants.
  const allButtons = page.locator('button:visible')
  const total = Math.min(await allButtons.count(), 6)
  for (let i = 0; i < total; i += 1) {
    const b = allButtons.nth(i)
    const bb = await b.boundingBox()
    if (bb && bb.height > 0) {
      expect(bb.height, `button ${i} should be ≥44px tall`).toBeGreaterThanOrEqual(44)
    }
  }
})

test('form inputs meet 44px touch target on /projects', async ({ page }) => {
  await page.goto('/projects')

  const nameInput = page.locator('input[name="name"]').first()
  await expect(nameInput).toBeVisible()

  const box = await nameInput.boundingBox()
  expect(box).not.toBeNull()
  if (box) {
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
})
