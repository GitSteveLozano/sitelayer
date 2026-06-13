import { test, expect, dispatchWorkflowEvent, fetchWorkflowSnapshot } from '../fixtures/auth'

/**
 * Spec — member-field-journey (WF-4 / plan A1).
 *
 * The CREW / worker (e2e-member) daily field loop, driven through the
 * REAL dark worker shell via button clicks — the journey nobody else
 * covered (the `memberPage` fixture existed but no spec used it). The
 * ordered legs mirror the worker README flow:
 *
 *   1. CLOCK IN — from `/today` the off-clock card routes to the
 *      `/clockin/manual` pre-punch form (site picker + reason). Tapping
 *      "Clock in · <site>" POSTs `/api/clock/in` and lands on the
 *      `/clockin` auto-confirm surface ("Clocked in.").
 *   2. SCOPE — `/scope` (wk-scope) shows today's scope brief.
 *   3. HOURS — `/hours` (wk-hours, "My week") is the self-service hours
 *      check.
 *   4. DAILY-LOG SUBMIT — `/log` (wk-log "NEW PHOTO") captures a photo and
 *      SAVEs it to today's daily log (real photo upload + lazy daily-log
 *      create), then we drive the daily_log workflow's SUBMIT transition
 *      (`draft → submitted`) through the canonical `/snapshot` + `/events`
 *      contract and cross-check server truth — the same UI-clicks +
 *      server-truth shape as foreman-field-event.spec.ts.
 *
 * Each leg is a REAL interaction (button click / file input / event POST)
 * with an assertion, so a worker-shell route or wiring that regresses
 * fails here instead of passing silently.
 */

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

type DailyLogListRow = {
  id: string
  project_id: string
  occurred_on: string
  status: 'draft' | 'submitted'
}

type DailyLogList = { dailyLogs: DailyLogListRow[] }

type DailyLogSnapshot = {
  state: 'draft' | 'submitted'
  state_version: number
  context: { submitted_at?: string | null }
}

// Local-date ISO (matches the worker screens — `occurred_on` is keyed off
// the calendar day, and Date.toISOString() is UTC which rolls "today"
// forward in negative-offset timezones).
function localTodayIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// A minimal but valid 1x1 PNG — the daily-log photo endpoint validates an
// image part, so an empty buffer would be rejected. This is the smallest
// real PNG (transparent pixel).
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

runSpec(
  'crew member runs the field loop: clock-in → scope → hours → daily log submit',
  {
    tag: '@member',
  },
  async ({ memberPage }) => {
    // -- 1. CLOCK IN -----------------------------------------------------------
    // Start on the worker home. The off-clock card's primary button routes to
    // the manual pre-punch form (the auto-geofence path needs a live GPS fix we
    // can't grant in CI, so we always take the manual leg).
    await memberPage.goto('/today')
    await memberPage.getByRole('button', { name: /Clock in manually/i }).click()

    // The manual form defaults the site selection to the nearest/first project,
    // so the primary button reads "Clock in · <site>" with no extra tap. Click
    // it — this POSTs /api/clock/in and, on success, navigates to /clockin.
    await expect(memberPage.getByRole('button', { name: /^Clock in ·/ })).toBeVisible({ timeout: 10_000 })
    await memberPage.getByRole('button', { name: /^Clock in ·/ }).click()

    // The auto-confirm surface renders the big "Clocked in." headline.
    await expect(memberPage.getByText(/Clocked\s*in\./)).toBeVisible({ timeout: 10_000 })

    // -- 2. SCOPE --------------------------------------------------------------
    // From the confirm surface the worker taps "See today's scope"; we also
    // assert the scope screen's own top bar so the leg proves the route paints.
    await memberPage.getByRole('button', { name: /See today's scope/i }).click()
    await expect(memberPage).toHaveURL(/\/scope$/)
    await expect(memberPage.getByText('Scope', { exact: true })).toBeVisible()

    // -- 3. HOURS --------------------------------------------------------------
    // The self-service hours check (wk-hours). Navigate directly (it's a bottom
    // tab in the live shell) and assert its "My week" headline.
    await memberPage.goto('/hours')
    await expect(memberPage.getByText('My week', { exact: true })).toBeVisible()

    // -- 4. DAILY LOG: capture a photo, SAVE, then SUBMIT the workflow ---------
    await memberPage.goto('/log')
    await expect(memberPage.getByText('NEW PHOTO')).toBeVisible()

    // The capture area opens the native camera via a hidden <input type=file>.
    // Drive it directly with a real (tiny) PNG so the SAVE path has a photo.
    await memberPage.locator('input[type="file"]').setInputFiles({
      name: 'site-photo.png',
      mimeType: 'image/png',
      buffer: ONE_BY_ONE_PNG,
    })

    // Optional note — exercises the PATCH-notes branch of the save handler.
    await memberPage.getByPlaceholder(/Add a note/i).fill('Footings poured · NW corner')

    // SAVE TO LOG uploads the photo (lazily creating today's daily log) and, on
    // success, navigates back to /today. The button label flips while busy.
    await memberPage.getByRole('button', { name: 'SAVE TO LOG' }).click()
    await expect(memberPage).toHaveURL(/\/today$/, { timeout: 15_000 })

    // Server-truth: a `draft` daily log now exists for today. Drive its
    // canonical SUBMIT transition through the workflow /events contract and
    // assert `draft → submitted` with a bumped version + populated timestamp —
    // mirroring foreman-field-event's reducer cross-check.
    const today = localTodayIso()
    const list = await fetchWorkflowSnapshot<DailyLogList>(memberPage, `/api/daily-logs?from=${today}&to=${today}`)
    const draft = list.dailyLogs.find((log) => log.occurred_on === today && log.status === 'draft')
    expect(draft, 'SAVE TO LOG should have created a draft daily log for today').toBeTruthy()

    const before = await fetchWorkflowSnapshot<DailyLogSnapshot>(memberPage, `/api/daily-logs/${draft!.id}/snapshot`)
    expect(before.state).toBe('draft')

    const after = await dispatchWorkflowEvent<DailyLogSnapshot>(memberPage, `/api/daily-logs/${draft!.id}/events`, {
      event: 'SUBMIT',
      state_version: before.state_version,
    })
    expect(after.state).toBe('submitted')
    expect(after.state_version).toBe(before.state_version + 1)
    expect(after.context.submitted_at).toBeTruthy()
  },
)
