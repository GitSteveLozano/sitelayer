import { expect, test } from '@playwright/test'

const routes = ['/confirm', '/projects', '/takeoffs/project-hillcrest', '/estimates', '/integrations']

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
