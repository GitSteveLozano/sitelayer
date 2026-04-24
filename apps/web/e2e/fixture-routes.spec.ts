import { expect, test } from '@playwright/test'

const routes = ['/projects', '/takeoffs/project-hillcrest', '/estimates', '/integrations']

for (const route of routes) {
  test(`renders ${route} with fixture data`, async ({ page }) => {
    await page.goto(route)

    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible()
    await expect(page.locator('main')).not.toBeEmpty()
  })
}

test('renders the non-production dev surface', async ({ page }) => {
  await page.goto('/dev/scratch')

  await page.getByRole('button', { name: 'Primitive Check' }).click()
  await expect(page.getByRole('dialog', { name: 'Dev Surface' })).toBeVisible()
  await expect(page.getByLabel('Current app tier')).toHaveValue('local')
})
