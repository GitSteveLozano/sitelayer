import { expect, test, type Page, type Route } from '@playwright/test'

const PUSH_ID = '00000000-0000-4000-8000-000000000208'
const BUILD_SHA = 'probe-smoke-build-sha'

const snapshot = {
  state: 'approved',
  state_version: 3,
  next_events: [{ type: 'POST_REQUESTED', label: 'Post to QBO' }],
  context: {
    id: PUSH_ID,
    project_id: '00000000-0000-4000-8000-000000000201',
    customer_id: 'qbo-customer-1',
    subtotal: '1280.00',
    qbo_estimate_id: null,
    reviewed_at: '2026-05-19T14:00:00.000Z',
    reviewed_by: 'e2e-admin',
    approved_at: '2026-05-19T14:05:00.000Z',
    approved_by: 'e2e-admin',
    posted_at: null,
    failed_at: null,
    error: null,
    workflow_engine: 'deterministic-v1',
    workflow_run_id: 'workflow-run-probe-smoke',
    lines: [
      {
        id: 'line-1',
        estimate_push_id: PUSH_ID,
        description: 'Frame scaffold bay',
        quantity: '2.00',
        unit_price: '640.00',
        amount: '1280.00',
        service_item_code: 'SCAF-FRAME',
        sort_order: 1,
      },
    ],
  },
} as const

const workflowEventTail = [
  {
    id: 'wel-probe-smoke-1',
    workflow_name: 'estimate_push',
    entity_id: PUSH_ID,
    event_type: 'APPROVE',
    from_state: 'reviewed',
    to_state: 'approved',
    from_state_version: 2,
    to_state_version: 3,
    actor_user_id: 'e2e-admin',
    created_at: '2026-05-19T14:05:00.000Z',
    event_payload: { type: 'APPROVE' },
  },
] as const

type CaptureSmoke = {
  capture_version?: unknown
  probe_id?: unknown
  path?: Record<string, unknown>
  page_state?: Record<string, unknown>
  principal?: Record<string, unknown>
  acting_as?: Record<string, unknown>
  deploy?: unknown
}

test(
  'captures estimate-push Probe payload from the real financial route',
  { tag: ['@estimate', '@capture'] },
  async ({ page }) => {
    await installApiMocks(page)

    await page.addInitScript(() => {
      window.localStorage.setItem('sitelayer.act-as', 'e2e-admin')
      window.localStorage.setItem('sitelayer.active-company-slug', 'e2e-fixtures')
      window.localStorage.setItem(
        'sitelayer.probe.acting-as',
        JSON.stringify({ role: 'admin', company_slug: 'e2e-fixtures', note: 'local Probe smoke' }),
      )
    })

    const captureJson = waitForCaptureJson(page)

    await page.goto(`/financial/estimate-pushes/${PUSH_ID}`)
    await expect(page.getByText('approved', { exact: true })).toBeVisible()
    await expect(page.getByText('Frame scaffold bay')).toBeVisible()
    await expect(page.getByText('2.00 × $640.00 · SCAF-FRAME')).toBeVisible()
    await page.getByRole('button', { name: 'Inspect Capture (dev)' }).click()

    const capture = await captureJson
    expectEstimatePushCapture(capture)
  },
)

test(
  'exposes estimate-push Probe payload through the gated browser diagnostic surface',
  {
    tag: ['@estimate', '@capture'],
  },
  async ({ page }) => {
    await installApiMocks(page)

    await page.addInitScript(() => {
      window.localStorage.setItem('sitelayer.act-as', 'e2e-admin')
      window.localStorage.setItem('sitelayer.active-company-slug', 'e2e-fixtures')
      window.localStorage.setItem('sitelayer.probe.diagnostics', '1')
      window.localStorage.setItem(
        'sitelayer.probe.acting-as',
        JSON.stringify({ role: 'admin', company_slug: 'e2e-fixtures', note: 'local Probe smoke' }),
      )
    })

    await page.goto(`/financial/estimate-pushes/${PUSH_ID}`)
    await expect(page.getByText('approved', { exact: true })).toBeVisible()
    await expect(page.getByText('Frame scaffold bay')).toBeVisible()
    await expect(page.getByText('2.00 × $640.00 · SCAF-FRAME')).toBeVisible()

    await expect
      .poll(
        async () => {
          const capture = await readDiagnosticCapture(page)
          return Array.isArray(capture.path?.workflow_event_log_tail) ? capture.path.workflow_event_log_tail.length : 0
        },
        { timeout: 5_000 },
      )
      .toBe(1)

    const capture = await readDiagnosticCapture(page)
    expectEstimatePushCapture(capture)
  },
)

function expectEstimatePushCapture(capture: CaptureSmoke): void {
  const path = capture.path
  expect(path).toBeTruthy()

  expect(capture.capture_version).toBe(1)
  expect(capture.probe_id).toBe('sitelayer.estimate_push')
  expect(path).toMatchObject({
    route: `/financial/estimate-pushes/${PUSH_ID}`,
    entity_type: 'estimate_push',
    entity_id: PUSH_ID,
    tail_error: null,
  })
  expect(path?.workflow_event_log_tail).toEqual(workflowEventTail)
  expect(capture.page_state).toMatchObject({
    state: 'approved',
    state_version: 3,
    next_events: ['POST_REQUESTED'],
    subtotal: '1280.00',
    approved_by: 'e2e-admin',
    workflow_engine: 'deterministic-v1',
    workflow_run_id: 'workflow-run-probe-smoke',
    line_count: 1,
  })
  expect(capture.principal).toMatchObject({
    source: 'dev-fallback',
    active_company_slug: 'e2e-fixtures',
    active_company_role: 'admin',
  })
  expect(capture.acting_as).toMatchObject({
    role: 'admin',
    company_slug: 'e2e-fixtures',
    note: 'local Probe smoke',
  })
  expect(capture.deploy).toEqual({ app_build_sha: BUILD_SHA, env: null })
}

async function installApiMocks(page: Page): Promise<void> {
  await page.route('http://localhost:3001/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/api/estimate-pushes/${PUSH_ID}`) {
      await fulfillJson(route, snapshot)
      return
    }

    if (path === '/api/features') {
      await fulfillJson(route, {
        tier: 'local',
        flags: ['qbo-live', 'read-prod-ro'],
        ribbon: null,
      })
      return
    }

    if (path === '/api/session') {
      await fulfillJson(route, {
        activeCompany: { role: 'admin' },
      })
      return
    }

    if (path === '/api/workflow-event-log') {
      expect(url.searchParams.get('entity_type')).toBe('estimate_push')
      expect(url.searchParams.get('entity_id')).toBe(PUSH_ID)
      expect(url.searchParams.get('limit')).toBe('3')
      await fulfillJson(route, { events: workflowEventTail })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `unmocked Probe smoke API path: ${path}` }),
    })
  })
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': 'http://localhost:3100',
      'access-control-expose-headers': 'x-sitelayer-build-sha',
      'x-sitelayer-build-sha': BUILD_SHA,
    },
    body: JSON.stringify(body),
  })
}

async function waitForCaptureJson(page: Page): Promise<CaptureSmoke> {
  const message = await page.waitForEvent('console', (msg) => msg.text().startsWith('[ADR-0019 Capture JSON]'))
  const args = message.args()
  const raw = args[1] ? await args[1].jsonValue() : message.text().replace('[ADR-0019 Capture JSON]', '').trim()
  expect(typeof raw).toBe('string')
  return JSON.parse(raw as string) as CaptureSmoke
}

async function readDiagnosticCapture(page: Page): Promise<CaptureSmoke> {
  return page.evaluate(() => {
    const probe = (
      window as Window & {
        __sitelayerProbe?: {
          estimatePushCapture?: () => unknown
        }
      }
    ).__sitelayerProbe
    if (!probe?.estimatePushCapture) throw new Error('estimate-push Probe diagnostic surface is not registered')
    return probe.estimatePushCapture()
  }) as Promise<CaptureSmoke>
}
