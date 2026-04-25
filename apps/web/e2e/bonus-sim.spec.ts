import { expect, test } from '@playwright/test'

test('bonus simulator renders, updates on revenue slider, and pivots from a project', async ({ page }) => {
  await page.goto('/bonus-sim')

  // View mounts via nav.
  await expect(page.getByRole('heading', { name: 'Bonus Simulator' })).toBeVisible()
  await expect(page.getByTestId('bonus-sim-chart')).toBeVisible()

  // Capture the initial payout string so we can assert it changes after we drag.
  const payoutLocator = page.getByTestId('bonus-sim-payout')
  const initialPayout = (await payoutLocator.textContent())?.trim() ?? ''

  // Drag the revenue slider to a high value to force tier movement. Playwright's
  // range-input handler treats .fill() as "set this value", which is the exact
  // gesture we want for a what-if simulation.
  await page.getByTestId('bonus-sim-revenue').fill('200000')

  // The payout line is keyed on revenue/cost/pool; nudging revenue up must move
  // the displayed payout (or flip eligibility). Either way, the text changes.
  await expect(payoutLocator).not.toHaveText(initialPayout)

  // Margin should also reflect the new revenue.
  const margin = await page.getByTestId('bonus-sim-margin').textContent()
  expect(margin).toMatch(/%/)

  // Project-pivot mode seeds the sliders from a fixture project.
  await page.getByTestId('bonus-sim-mode-project-pivot').click()
  await page.getByTestId('bonus-sim-project-select').selectOption('project-hillcrest')

  await expect(page.getByTestId('bonus-sim-pivot-delta')).toBeVisible()

  // Dragging cost down from the baseline should surface a non-trivial delta line.
  await page.getByTestId('bonus-sim-cost').fill('50000')
  await expect(page.getByTestId('bonus-sim-pivot-delta')).toContainText('baseline')
})

test('bonus simulator is reachable from the nav', async ({ page }) => {
  await page.goto('/projects')
  await page.getByRole('link', { name: 'Bonus Sim' }).click()
  await expect(page).toHaveURL(/\/bonus-sim$/)
  await expect(page.getByRole('heading', { name: 'Bonus Simulator' })).toBeVisible()
})
