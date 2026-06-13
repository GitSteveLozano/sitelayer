import { expect, test, type Page, type Route } from '@playwright/test'

/**
 * Spec — portal-rentals-reserve (G7 / plan A4).
 *
 * The customer self-serve rental portal — browse → cart → reserve —
 * driven through the browser with NO Clerk, NO seeded DB. Like
 * portal-feedback-capture.smoke.spec.ts we Playwright-route-mock the
 * signed portal API (`${API_ORIGIN}/api/portal/rentals/:token/*`), so the
 * spec verifies the real RentalsPortal / RentalsCart / RentalsConfirm UI
 * + the lifted rentalsPortal machine without any backend.
 *
 * Journey: load the catalog → "Add to cart" → navigate to the cart →
 * fill contact → "Reserve" → POST /reserve → land on the confirm screen
 * ("Reservation submitted") showing the returned reference id.
 */

const SHARE_TOKEN = 'portal-rentals-reserve-token'
const RESERVATION_ID = 'rental-request-portal-reserve'
const BUILD_SHA = 'portal-rentals-reserve-build-sha'

// Match the CI ports (3001 API / 3100 web); honor the same overrides as the
// sibling portal smoke so the local gate can run on alternate ports.
const API_ORIGIN = `http://localhost:${process.env.E2E_API_PORT ?? '3001'}`
const WEB_ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? '3100'}`

type JsonObject = Record<string, unknown>

type PortalRentalsState = {
  reserveBodies: JsonObject[]
}

const catalogFixture = {
  items: [
    {
      id: 'inv-scaff-10',
      code: 'SCAFF-10',
      description: '10 ft scaffold frame',
      category: 'Scaffold',
      unit: 'ea',
      default_rental_rate: '12.00',
      replacement_value: '100.00',
    },
    {
      id: 'inv-plank-8',
      code: 'PLANK-8',
      description: '8 ft aluminum plank',
      category: 'Planks',
      unit: 'ea',
      default_rental_rate: '6.50',
      replacement_value: '40.00',
    },
  ],
} as const

test('client reserves rental equipment from the cart', { tag: '@rental' }, async ({ page }) => {
  const state: PortalRentalsState = { reserveBodies: [] }
  await installPortalRentalsMocks(page, state)

  // The cart persists to localStorage as a resume convenience; clear it so a
  // prior run can't seed lines into this test's cart.
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('sitelayer:portal:rentals:cart')
    } catch {
      // storage blocked — nothing to clear
    }
  })

  await page.goto(`/portal/rentals/${SHARE_TOKEN}`)

  // The browse view renders the catalog header + each item card.
  await expect(page.getByText('Rental catalog')).toBeVisible()
  await expect(page.getByText('SCAFF-10')).toBeVisible()
  await expect(page.getByText('2 items available')).toBeVisible()

  // Add the SCAFF-10 item to the cart. Scope to its catalog card — the inner
  // card div that contains the code text AND its own "Add to cart" button — so
  // we don't grab the sibling item's button or an outer grid wrapper.
  const scaffCard = page
    .locator('div')
    .filter({ hasText: 'SCAFF-10' })
    .filter({ has: page.getByRole('button', { name: 'Add to cart' }) })
    .last()
  await scaffCard.getByRole('button', { name: 'Add to cart' }).click()

  // The header cart link reflects the new line; follow it to the cart screen.
  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible()
  await page.getByRole('link', { name: 'Cart (1)' }).click()
  await expect(page).toHaveURL(new RegExp(`/portal/rentals/${SHARE_TOKEN}/cart$`))
  await expect(page.getByRole('heading', { name: 'Cart' })).toBeVisible()

  // Fill the contact details (the reserve POST carries these through).
  await page.getByPlaceholder('Name').fill('Dana Client')
  await page.getByPlaceholder('Email').fill('dana@example.com')
  await page.getByPlaceholder('Phone').fill('555-0100')

  // Reserve → POST /reserve resolves → machine reaches `reserved` and the cart
  // screen navigates to the confirm deep-link.
  await page.getByRole('button', { name: 'Reserve' }).click()

  await expect(page).toHaveURL(new RegExp(`/portal/rentals/${SHARE_TOKEN}/confirm`))
  await expect(page.getByRole('heading', { name: 'Reservation submitted' })).toBeVisible()
  await expect(page.getByText(RESERVATION_ID)).toBeVisible()

  // The mock captured exactly one reserve POST carrying the contact + the cart
  // line (one scaffold item).
  expect(state.reserveBodies).toHaveLength(1)
  const body = state.reserveBodies[0]!
  expect(body).toMatchObject({
    contact_name: 'Dana Client',
    contact_email: 'dana@example.com',
    contact_phone: '555-0100',
  })
  const items = body.items as Array<{ inventory_item_id: string; qty: number }>
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ inventory_item_id: 'inv-scaff-10', qty: 1 })
})

async function installPortalRentalsMocks(page: Page, state: PortalRentalsState): Promise<void> {
  await page.route(`${API_ORIGIN}/api/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const base = `/api/portal/rentals/${SHARE_TOKEN}`

    if (method === 'OPTIONS') {
      await fulfillCors(route)
      return
    }

    if (method === 'GET' && path === `${base}/catalog`) {
      await fulfillJson(route, catalogFixture)
      return
    }

    if (method === 'POST' && path === `${base}/reserve`) {
      const body = postJson(request.postData())
      state.reserveBodies.push(body)
      await fulfillJson(route, {
        id: RESERVATION_ID,
        status: 'pending',
        created_at: '2026-06-05T12:00:00.000Z',
      })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ error: `unmocked portal rentals API path: ${method} ${path}` }),
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
