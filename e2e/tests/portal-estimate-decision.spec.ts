import { expect, test, type Page, type Route } from '@playwright/test'

/**
 * Spec — portal-estimate-decision (G7 / plan A4).
 *
 * The customer-facing estimate portal — the ONE journey a paying client
 * actually touches — driven through the browser with NO Clerk, NO seeded
 * DB. Like portal-feedback-capture.smoke.spec.ts we Playwright-route-mock
 * the signed portal API (`${API_ORIGIN}/api/portal/estimates/:token/*`),
 * so the spec verifies the real EstimateView UI + SignatureCapture +
 * navigation without any backend.
 *
 * Two journeys (one test each, isolated tokens so the per-test mock state
 * never bleeds):
 *   - ACCEPT: view → "Accept estimate" → type name + sign the canvas →
 *     "Submit acceptance" → POST /accept → redirect to `/accepted`, which
 *     renders the "You accepted this estimate." confirmation.
 *   - DECLINE: view → "Decline" → reason → "Submit decline" → POST
 *     /decline → the screen re-renders with the "You declined this
 *     estimate." banner.
 */

const ACCEPT_TOKEN = 'portal-estimate-accept-token'
const DECLINE_TOKEN = 'portal-estimate-decline-token'
const BUILD_SHA = 'portal-estimate-decision-build-sha'

// Match the CI ports (3001 API / 3100 web); honor the same overrides as the
// sibling portal smoke so the local gate can run on alternate ports.
const API_ORIGIN = `http://localhost:${process.env.E2E_API_PORT ?? '3001'}`
const WEB_ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? '3100'}`

type JsonObject = Record<string, unknown>

type PortalEstimateState = {
  status: 'pending' | 'accepted' | 'declined'
  acceptBodies: JsonObject[]
  declineBodies: JsonObject[]
  signerName: string | null
  declineReason: string | null
}

function estimateFixture(token: string, state: PortalEstimateState) {
  return {
    id: `estimate-share-${token}`,
    project_name: 'Maple Ave Scaffold',
    company_name: 'Sitelayer Demo',
    recipient_email: 'client@example.com',
    recipient_name: 'Dana Client',
    sent_at: '2026-06-04T18:00:00.000Z',
    expires_at: '2026-06-18T18:00:00.000Z',
    status: state.status,
    accepted_at: state.status === 'accepted' ? '2026-06-05T12:00:00.000Z' : null,
    declined_at: state.status === 'declined' ? '2026-06-05T12:00:00.000Z' : null,
    decline_reason: state.declineReason,
    signer_name: state.signerName,
    estimate: {
      bid_total: 2480,
      scope_total: 2480,
      captured_at: '2026-06-04T17:58:00.000Z',
      lines: [
        {
          service_item_code: 'SCAF-FRAME',
          quantity: 4,
          unit: 'ea',
          rate: 620,
          amount: 2480,
          division_code: 'D4',
        },
      ],
    },
  }
}

test('client accepts an estimate by signing', { tag: '@capture' }, async ({ page }) => {
  const state: PortalEstimateState = {
    status: 'pending',
    acceptBodies: [],
    declineBodies: [],
    signerName: null,
    declineReason: null,
  }
  await installPortalEstimateMocks(page, ACCEPT_TOKEN, state)

  await page.goto(`/portal/estimates/${ACCEPT_TOKEN}`)
  // The read-only snapshot renders the project + a line item.
  await expect(page.getByText('Maple Ave Scaffold')).toBeVisible()
  await expect(page.getByText('SCAF-FRAME')).toBeVisible()

  // Open the accept (signature) flow.
  await page.getByRole('button', { name: 'Accept estimate' }).click()
  await expect(page.getByRole('heading', { name: 'Sign to accept' })).toBeVisible()

  // Type the signer name, then draw on the signature canvas so the machine
  // sees a non-empty signature (SignatureCapture fires onChange on pointer-up
  // only when there's ink).
  await page.getByPlaceholder('Jane Doe').fill('Dana Client')
  await drawSignature(page)
  await expect(page.getByText('Signature captured.')).toBeVisible()

  await page.getByRole('button', { name: 'Submit acceptance' }).click()

  // POST /accept resolves → machine redirects to the accepted view.
  await expect(page).toHaveURL(new RegExp(`/portal/estimates/${ACCEPT_TOKEN}/accepted$`))
  await expect(page.getByText('You accepted this estimate.')).toBeVisible()
  await expect(page.getByText('Signed by Dana Client')).toBeVisible()

  // The mock captured exactly one accept POST carrying the typed name + a
  // PNG data-url signature.
  expect(state.acceptBodies).toHaveLength(1)
  expect(state.acceptBodies[0]).toMatchObject({ signer_name: 'Dana Client' })
  expect(String(state.acceptBodies[0]?.signature_data_url ?? '')).toContain('data:image/png')
})

test('client declines an estimate with a reason', { tag: '@capture' }, async ({ page }) => {
  const state: PortalEstimateState = {
    status: 'pending',
    acceptBodies: [],
    declineBodies: [],
    signerName: null,
    declineReason: null,
  }
  await installPortalEstimateMocks(page, DECLINE_TOKEN, state)

  await page.goto(`/portal/estimates/${DECLINE_TOKEN}`)
  await expect(page.getByText('Maple Ave Scaffold')).toBeVisible()

  // Open the decline flow, give a reason, submit.
  await page.getByRole('button', { name: 'Decline' }).click()
  await expect(page.getByRole('heading', { name: 'Decline this estimate' })).toBeVisible()
  await page.getByPlaceholder('Reason').fill('Going with another bid for now.')
  await page.getByRole('button', { name: 'Submit decline' }).click()

  // POST /decline flips the mock's status to `declined`; the machine
  // re-fetches and the view renders the declined banner + reason.
  await expect(page.getByText('You declined this estimate.')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Reason: Going with another bid for now.')).toBeVisible()

  expect(state.declineBodies).toHaveLength(1)
  expect(state.declineBodies[0]).toMatchObject({ decline_reason: 'Going with another bid for now.' })
})

/**
 * Drag the pointer across the signature <canvas> so SignatureCapture
 * records ink and emits a non-null data-url on pointer-up. Pointer events
 * (not click) are what the pad listens for.
 */
async function drawSignature(page: Page): Promise<void> {
  const canvas = page.getByLabel('Signature pad — sign with your finger or mouse')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('signature canvas not visible')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * 0.2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.4, y - 12, { steps: 4 })
  await page.mouse.move(box.x + box.width * 0.6, y + 12, { steps: 4 })
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 4 })
  await page.mouse.up()
}

async function installPortalEstimateMocks(page: Page, token: string, state: PortalEstimateState): Promise<void> {
  await page.route(`${API_ORIGIN}/api/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const base = `/api/portal/estimates/${token}`

    if (method === 'OPTIONS') {
      await fulfillCors(route)
      return
    }

    if (method === 'GET' && path === base) {
      await fulfillJson(route, estimateFixture(token, state))
      return
    }

    if (method === 'POST' && path === `${base}/accept`) {
      const body = postJson(request.postData())
      state.acceptBodies.push(body)
      state.signerName = body.signer_name ? String(body.signer_name) : null
      state.status = 'accepted'
      await fulfillJson(route, {
        ok: true,
        accepted_at: '2026-06-05T12:00:00.000Z',
        signer_name: state.signerName,
        idempotent: false,
      })
      return
    }

    if (method === 'POST' && path === `${base}/decline`) {
      const body = postJson(request.postData())
      state.declineBodies.push(body)
      state.declineReason = body.decline_reason ? String(body.decline_reason) : null
      state.status = 'declined'
      await fulfillJson(route, {
        ok: true,
        declined_at: '2026-06-05T12:00:00.000Z',
        decline_reason: state.declineReason,
        idempotent: false,
      })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ error: `unmocked portal estimate API path: ${method} ${path}` }),
    })
  })
}

function postJson(raw: string | null): JsonObject {
  expect(raw).toBeTruthy()
  return JSON.parse(raw ?? '{}') as JsonObject
}

async function fulfillCors(route: Route): Promise<void> {
  await route.fulfill({ status: 204, headers: corsHeaders() })
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      ...corsHeaders(),
      'access-control-expose-headers': 'x-sitelayer-build-sha',
      'x-sitelayer-build-sha': BUILD_SHA,
    },
    body: JSON.stringify(body),
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': WEB_ORIGIN,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-request-id,sentry-trace,baggage,x-sitelayer-capture-session-id',
  }
}
