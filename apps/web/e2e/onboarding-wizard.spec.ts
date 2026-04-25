import { expect, test } from '@playwright/test'

// The wizard resumes from localStorage so each test needs a clean slate.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem('sitelayer.onboardingWizard.v1')
  })
})

test('onboarding wizard renders at /onboarding with progress at 1/4', async ({ page }) => {
  await page.goto('/onboarding')

  await expect(page.getByTestId('onboarding-wizard')).toBeVisible()
  await expect(page.getByTestId('onboarding-progress')).toContainText('Step 1 / 4')
  await expect(page.getByTestId('step-basics')).toBeVisible()
  await expect(page.getByTestId('onboarding-slug')).toBeVisible()
  await expect(page.getByTestId('onboarding-name')).toBeVisible()
})

test('basics step requires slug + name before advancing', async ({ page }) => {
  await page.goto('/onboarding')

  // Click Next with empty fields — should not advance.
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-error')).toBeVisible()
  await expect(page.getByTestId('onboarding-progress')).toContainText('Step 1 / 4')
})

test('wizard advances through all four steps in fixtures mode', async ({ page }) => {
  await page.goto('/onboarding')

  // Step 1 — basics.
  await page.getByTestId('onboarding-slug').fill('acme-construction')
  await page.getByTestId('onboarding-name').fill('Acme Construction')
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-progress')).toContainText('Step 2 / 4')
  await expect(page.getByTestId('step-project')).toBeVisible()

  // Step 2 — project.
  await page.getByTestId('onboarding-project-name').fill('Pilot Project')
  await page.getByTestId('onboarding-customer').fill('Pilot Customer')
  await page.getByTestId('onboarding-bid-total').fill('125000')
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByTestId('onboarding-progress')).toContainText('Step 3 / 4')
  await expect(page.getByTestId('step-invite')).toBeVisible()

  // Step 3 — invites (skip).
  await page.getByTestId('onboarding-skip').click()
  await expect(page.getByTestId('onboarding-progress')).toContainText('Step 4 / 4')
  await expect(page.getByTestId('step-qbo')).toBeVisible()

  // Step 4 — finish.
  await page.getByTestId('onboarding-finish').click()
  await expect(page).toHaveURL(/\/projects$/)
})

test('projects view surfaces Create company big-button that routes to wizard', async ({ page }) => {
  await page.goto('/projects')
  await expect(page.getByTestId('create-company-big-button')).toBeVisible()
  await page.getByTestId('create-company-big-button').click()
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByTestId('onboarding-wizard')).toBeVisible()
})

test('quick-create toggle reveals the inline slug+name form', async ({ page }) => {
  await page.goto('/projects')
  await expect(page.getByTestId('quick-create-toggle')).toBeVisible()
  await page.getByTestId('quick-create-toggle').click()
  await expect(page.getByPlaceholder('acme-construction')).toBeVisible()
  await expect(page.getByPlaceholder('Acme Construction')).toBeVisible()
})
