import { expect, test, type Page, type Route } from '@playwright/test'

const API_ORIGIN = `http://localhost:${process.env.STEVE_CAPTURE_SMOKE_API_PORT ?? process.env.E2E_API_PORT ?? 3001}`
const WEB_ORIGIN = `http://localhost:${process.env.STEVE_CAPTURE_SMOKE_WEB_PORT ?? 5175}`

type JsonObject = Record<string, unknown>

type CaptureRequest = {
  body: JsonObject
  headers: Record<string, string>
}

type SteveCaptureState = {
  captureSessionId: string | null
  starts: CaptureRequest[]
  events: CaptureRequest[]
  finalizes: CaptureRequest[]
}

test('Steve review link prewarms and reuses a text issue capture session', { tag: '@capture' }, async ({ page }) => {
  const note = 'Steve smoke: markup changed but total did not update.'
  const state: SteveCaptureState = {
    captureSessionId: null,
    starts: [],
    events: [],
    finalizes: [],
  }
  await failIfMicrophoneRequested(page)
  await installSteveCaptureApiMocks(page, state)

  await page.goto('/collab/steve?target=/m-preview')
  await expect(page).toHaveURL(/\/m-preview\?.*collab=steve/, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: /send issue/i })).toBeVisible({ timeout: 30_000 })

  await expect.poll(() => state.starts.length).toBe(1)
  const prewarm = state.starts[0]
  expect(prewarm?.body).toMatchObject({
    mode: 'feedback',
    consent_version: 'authenticated-feedback-v1',
    route_path: '/m-preview',
    metadata: {
      surface: 'authenticated_app',
      company_slug: 'e2e-fixtures',
      capture_profile: 'text_issue_prewarm',
      collab_mode: 'steve',
    },
    consent_scope: {
      surface: 'authenticated_app',
      streams: ['text_note', 'registered_artifacts'],
      audio: false,
      dom_replay: false,
    },
  })
  expect(prewarm?.headers['x-sitelayer-act-as']).toBe('e2e-admin')
  expect(prewarm?.headers['x-sitelayer-company-slug']).toBe('e2e-fixtures')

  const prewarmedSessionId = String(prewarm?.body.capture_session_id ?? '')
  expect(prewarmedSessionId).toMatch(/^[0-9a-f-]{36}$/)
  expect(state.captureSessionId).toBe(prewarmedSessionId)

  await page.getByPlaceholder('What is wrong?').fill(note)
  await page.getByRole('button', { name: /send issue/i }).click()

  await expect(page.getByText(/Sent .*support-packet-steve-smoke.*work-item-steve-smoke/)).toBeVisible()

  await expect.poll(() => state.starts.length).toBe(2)
  const submitUpsert = state.starts[1]
  expect(submitUpsert?.body).toMatchObject({
    capture_session_id: prewarmedSessionId,
    mode: 'feedback',
    metadata: {
      capture_profile: 'text_issue',
      collab_mode: 'steve',
    },
  })

  expect(state.events).toHaveLength(1)
  expect(state.events[0]?.body.events).toEqual([
    expect.objectContaining({
      event_type: 'authenticated.feedback.issue_submitted',
      event_class: 'authenticated_feedback',
      route_path: '/m-preview',
      payload: {
        note_length: note.length,
        collab_mode: 'steve',
      },
    }),
  ])

  expect(state.finalizes).toHaveLength(1)
  expect(state.finalizes[0]?.body).toMatchObject({
    title: 'In-app issue report',
    summary: note,
    severity: 'normal',
    lane: 'triage',
    route_path: '/m-preview',
    route: '/m-preview',
    category: 'record_feedback',
  })

  await expect
    .poll(() =>
      page.evaluate(() => ({
        captureSession: window.sessionStorage.getItem('sitelayer.capture-session'),
        collabMode: window.localStorage.getItem('sitelayer.collab-mode'),
        activeCompany: window.localStorage.getItem('sitelayer.active-company-slug'),
      })),
    )
    .toEqual({
      captureSession: null,
      collabMode: 'steve',
      activeCompany: 'e2e-fixtures',
    })
})

async function failIfMicrophoneRequested(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new Error('Steve text issue smoke must not request microphone access')
        },
      },
    })
  })
}

async function installSteveCaptureApiMocks(page: Page, state: SteveCaptureState): Promise<void> {
  await page.route(`${API_ORIGIN}/api/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (method === 'OPTIONS') {
      await fulfillCors(route)
      return
    }

    if (method === 'POST' && path === '/api/capture-sessions') {
      const body = postJson(request.postData())
      const captureSessionId = String(body.capture_session_id ?? '')
      if (!state.captureSessionId) {
        state.captureSessionId = captureSessionId
      } else {
        expect(captureSessionId).toBe(state.captureSessionId)
      }
      state.starts.push({ body, headers: request.headers() })
      await fulfillJson(route, {
        capture_session: {
          id: captureSessionId,
          mode: 'feedback',
          status: 'open',
          started_at: '2026-06-04T12:00:00.000Z',
          last_seen_at: '2026-06-04T12:00:00.000Z',
        },
      })
      return
    }

    const sessionPath = state.captureSessionId ? `/api/capture-sessions/${state.captureSessionId}` : null
    if (sessionPath && method === 'POST' && path === `${sessionPath}/events`) {
      expect(request.headers()['x-sitelayer-capture-session-id']).toBe(state.captureSessionId)
      const body = postJson(request.postData())
      state.events.push({ body, headers: request.headers() })
      await fulfillJson(route, { accepted: Array.isArray(body.events) ? body.events.length : 0 }, 202)
      return
    }

    if (sessionPath && method === 'POST' && path === `${sessionPath}/finalize`) {
      expect(request.headers()['x-sitelayer-capture-session-id']).toBe(state.captureSessionId)
      const body = postJson(request.postData())
      state.finalizes.push({ body, headers: request.headers() })
      await fulfillJson(route, {
        work_item: {
          id: 'work-item-steve-smoke',
          title: body.title ?? 'In-app issue report',
          summary: body.summary ?? '',
          status: 'new',
          lane: 'triage',
          severity: body.severity ?? 'normal',
          route: body.route_path ?? null,
          capture_session_id: state.captureSessionId,
        },
        support_packet: {
          id: 'support-packet-steve-smoke',
          expires_at: '2026-06-30T22:00:00.000Z',
        },
        event: null,
      })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ error: `unmocked Steve capture smoke API path: ${method} ${path}` }),
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
    headers: corsHeaders(),
    body: JSON.stringify(body),
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': WEB_ORIGIN,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers':
      'content-type,x-request-id,sentry-trace,baggage,x-sitelayer-capture-session-id,x-sitelayer-act-as,x-sitelayer-company-slug',
  }
}
