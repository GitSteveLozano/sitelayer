import { expect, test } from '@playwright/test'

const routes = [
  '/confirm',
  '/schedule',
  '/projects',
  '/takeoffs/project-hillcrest',
  '/estimates',
  '/integrations',
]

for (const route of routes) {
  test(`renders ${route} with fixture data`, async ({ page }) => {
    await page.goto(route)

    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible()
    await expect(page.locator('main')).not.toBeEmpty()
  })
}

test('confirm day nav link surfaces the confirm view', async ({ page }) => {
  await page.goto('/projects')
  await page.getByTestId('nav-confirm').click()
  await expect(page).toHaveURL(/\/confirm$/)
  // Empty fixture state today OR populated view — either is acceptable;
  // the important bit is that the panel mounts with the Confirm Day heading.
  await expect(page.getByRole('heading', { name: /Confirm Day/i })).toBeVisible()
})

test('renders the non-production dev surface', async ({ page }) => {
  await page.goto('/dev/scratch')

  await page.getByRole('button', { name: 'Primitive Check' }).click()
  await expect(page.getByRole('dialog', { name: 'Dev Surface' })).toBeVisible()
  await expect(page.getByLabel('Current app tier')).toHaveValue('local')
})

test('schedule nav link opens the weekly grid with workers and projects', async ({ page }) => {
  await page.goto('/projects')
  await page.getByTestId('nav-schedule').click()
  await expect(page).toHaveURL(/\/schedule$/)
  await expect(page.getByRole('heading', { name: /Weekly Schedule/i })).toBeVisible()
  // Worker rail is present with fixture workers available to drag.
  await expect(page.getByTestId('schedule-worker-rail')).toBeVisible()
  await expect(page.getByTestId('worker-chip-worker-ana')).toBeVisible()
  // The grid renders with at least the Hillcrest project row label.
  await expect(page.getByTestId('schedule-grid')).toBeVisible()
  await expect(page.getByText('Hillcrest Homes - Phase 4')).toBeVisible()
  // Week navigation buttons render and are operable (no network mutation).
  await page.getByTestId('schedule-next-week').click()
  await page.getByTestId('schedule-prev-week').click()
  await page.getByTestId('schedule-this-week').click()
  // Copy last week is clickable (fixture mutation is a no-op, so it resolves).
  await page.getByTestId('schedule-copy-last-week').click()
})
