import { test, expect } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 6 — admin-closeout-rollup.
 *
 * The seed creates a project with enough completed labor entries,
 * posted rental invoices, and material bills that the closeout summary
 * has real bid / total_actual / margin numbers (otherwise the empty
 * state renders instead — see project-detail.tsx ~line 644).
 *
 * Steps:
 *   1. Admin navigates to /projects/:id (Budget tab is one of the
 *      tabs in the mobile project detail shell).
 *   2. Switches to the Budget tab.
 *   3. Asserts the "Closeout summary" card is rendered with the three
 *      KPI cells (Bid / Total actual / Margin), each containing a
 *      formatted dollar amount.
 *   4. Asserts the "Labor variance" card is rendered alongside it.
 *
 * Both card headers come from project-detail.tsx — the visible text in
 * the DOM is the literal capitalisation ("Closeout summary",
 * "Labor variance"); the `textTransform: uppercase` is CSS-only.
 */

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec(
  'admin sees closeout-summary and labor-variance cards on Budget tab',
  { tag: '@payroll' },
  async ({ adminPage }) => {
    const projectId = FIXTURE_IDS.closeoutProjectId

    await adminPage.goto(`/projects/${projectId}`)

    // Switch to the Budget tab. The TabBar in project-detail.tsx uses
    // plain buttons; the label text is "Budget".
    await adminPage.getByRole('button', { name: 'Budget', exact: true }).click()

    // Closeout summary card. The header label is rendered as plain
    // "Closeout summary" text (CSS uppercases visually). The KPI row
    // exposes three labels: Bid / Total actual / Margin.
    await expect(adminPage.getByText('Closeout summary', { exact: true }).first()).toBeVisible()
    await expect(adminPage.getByText('Bid', { exact: true }).first()).toBeVisible()
    await expect(adminPage.getByText('Total actual', { exact: true })).toBeVisible()
    await expect(adminPage.getByText('Margin', { exact: true }).first()).toBeVisible()

    // The seed populates non-zero bid / actuals so the KPI values render
    // as formatted dollar amounts. Match a generic currency pattern
    // ($X,XXX or $X) inside the closeout summary card.
    const closeoutCard = adminPage
      .locator('div')
      .filter({ has: adminPage.getByText('Closeout summary', { exact: true }) })
      .first()
    await expect(closeoutCard.getByText(/\$[\d,]+(?:\.\d{2})?/).first()).toBeVisible()

    // Labor variance card — either the "worst offenders" populated form
    // (header is "Labor variance · worst offenders") or the empty-state
    // header (just "Labor variance"). Both branches start with the
    // canonical "Labor variance" label, so anchor on that prefix instead
    // of requiring an exact match.
    await expect(adminPage.getByText(/^Labor variance/).first()).toBeVisible()
  },
)
