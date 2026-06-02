import { expect, test, type Page, type Route } from '@playwright/test'

const SHARE_TOKEN = 'portal-feedback-smoke-token'
const BUILD_SHA = 'portal-feedback-smoke-build-sha'

type JsonObject = Record<string, unknown>

type PortalCaptureState = {
  captureSessionId: string | null
  startBodies: JsonObject[]
  eventBodies: JsonObject[]
  uploads: Array<{ kind: string; body: string; headers: Record<string, string> }>
  finalizeBodies: JsonObject[]
  discardCount: number
}

test('records invited portal feedback with mic audio and opt-in DOM replay', { tag: '@capture' }, async ({ page }) => {
  const state: PortalCaptureState = {
    captureSessionId: null,
    startBodies: [],
    eventBodies: [],
    uploads: [],
    finalizeBodies: [],
    discardCount: 0,
  }
  await installFakeMediaRecorder(page)
  await installPortalApiMocks(page, state)

  await page.goto(`/portal/estimates/${SHARE_TOKEN}?capture_invite=invite-1&capture_replay=1`)
  await expect(page.getByText('Acme Roof Access')).toBeVisible()

  await page.getByRole('button', { name: 'Record feedback' }).click()
  await page.getByPlaceholder('What should we look at?').fill('Verify Scale did nothing after I tapped it.')
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByText('Recording feedback')).toBeVisible()
  await expect.poll(() => state.startBodies.length).toBe(1)

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText('Feedback sent')).toBeVisible()

  expect(state.captureSessionId).toMatch(/^[0-9a-f-]{36}$/)
  expect(state.startBodies[0]).toMatchObject({
    capture_session_id: state.captureSessionId,
    mode: 'feedback',
    consent_version: 'portal-feedback-v1',
    route_path: `/portal/estimates/${SHARE_TOKEN}`,
    metadata: {
      portal_surface: 'estimate_portal',
      capture_invite_present: true,
    },
    consent_scope: {
      portal_surface: 'estimate_portal',
      streams: ['audio', 'dom_replay'],
      dom_replay: true,
    },
  })
  expect(state.eventBodies.flatMap((body) => body.events as JsonObject[])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event_type: 'portal.feedback.recording_started' }),
      expect.objectContaining({
        event_type: 'portal.feedback.recording_stopped',
        payload: { note_length: 43 },
      }),
    ]),
  )
  expect(state.uploads.map((upload) => upload.kind).sort()).toEqual(['audio', 'rrweb'])
  expect(
    state.uploads.every((upload) => upload.headers['x-sitelayer-capture-session-id'] === state.captureSessionId),
  ).toBe(true)
  expect(state.uploads.find((upload) => upload.kind === 'audio')?.body).toContain('"source":"record_feedback"')
  expect(state.uploads.find((upload) => upload.kind === 'rrweb')?.body).toContain(
    '"artifact_type":"capture.rrweb_replay"',
  )
  expect(state.finalizeBodies).toEqual([
    expect.objectContaining({
      summary: 'Verify Scale did nothing after I tapped it.',
      severity: 'normal',
      route_path: `/portal/estimates/${SHARE_TOKEN}`,
      category: 'record_feedback',
    }),
  ])
})

async function installFakeMediaRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const track = { stop() {} }
    const fakeStream = { getTracks: () => [track] }
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          if (!constraints.audio) throw new Error('audio constraint was not requested')
          return fakeStream
        },
      },
    })

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true
      }

      state: RecordingState = 'inactive'
      mimeType: string
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onstop: ((event: Event) => void) | null = null

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? 'audio/webm'
      }

      start() {
        this.state = 'recording'
      }

      stop() {
        this.state = 'inactive'
        const blob = new Blob(['fake portal feedback audio'], { type: this.mimeType })
        window.setTimeout(() => {
          this.ondataavailable?.({ data: blob } as BlobEvent)
          this.onstop?.(new Event('stop'))
        }, 0)
      }
    }

    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    })
  })
}

async function installPortalApiMocks(page: Page, state: PortalCaptureState): Promise<void> {
  await page.route('http://localhost:3001/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (method === 'OPTIONS') {
      await fulfillCors(route)
      return
    }

    if (method === 'GET' && path === `/api/portal/estimates/${SHARE_TOKEN}`) {
      await fulfillJson(route, portalEstimateFixture)
      return
    }

    if (method === 'POST' && path === `/api/portal/estimates/${SHARE_TOKEN}/capture-sessions`) {
      const body = postJson(request.postData())
      state.startBodies.push(body)
      state.captureSessionId = String(body.capture_session_id)
      expect(request.headers()['x-sitelayer-capture-session-id']).toBe(state.captureSessionId)
      await fulfillJson(route, {
        capture_session: {
          id: state.captureSessionId,
          mode: 'feedback',
          status: 'open',
          started_at: '2026-05-31T22:00:00.000Z',
          last_seen_at: '2026-05-31T22:00:00.000Z',
        },
      })
      return
    }

    const sessionPath = `/api/portal/estimates/${SHARE_TOKEN}/capture-sessions/${state.captureSessionId}`
    if (state.captureSessionId && method === 'POST' && path === `${sessionPath}/events`) {
      expect(request.headers()['x-sitelayer-capture-session-id']).toBe(state.captureSessionId)
      const body = postJson(request.postData())
      state.eventBodies.push(body)
      await fulfillJson(route, { accepted: Array.isArray(body.events) ? body.events.length : 0 }, 202)
      return
    }

    if (state.captureSessionId && method === 'POST' && path === `${sessionPath}/artifacts/upload`) {
      const buffer = await request.postDataBuffer()
      const text = buffer?.toString('utf8') ?? ''
      const kind = multipartField(text, 'kind')
      state.uploads.push({ kind, body: text, headers: request.headers() })
      await fulfillJson(
        route,
        {
          artifact: {
            id: `artifact-${state.uploads.length}`,
            kind,
            storage_key: `company/capture-sessions/${state.captureSessionId}/artifact-${state.uploads.length}`,
            content_type: kind === 'rrweb' ? 'application/json' : 'audio/webm',
            byte_size: buffer?.byteLength ?? 0,
            content_hash: `sha256:${kind}`,
            redaction_version: 'capture-artifact-v1',
          },
        },
        201,
      )
      return
    }

    if (state.captureSessionId && method === 'POST' && path === `${sessionPath}/finalize`) {
      expect(request.headers()['x-sitelayer-capture-session-id']).toBe(state.captureSessionId)
      const body = postJson(request.postData())
      state.finalizeBodies.push(body)
      await fulfillJson(route, {
        work_item: {
          id: 'work-item-portal-feedback-smoke',
          title: body.title ?? 'Portal feedback recording',
          summary: body.summary ?? '',
          status: 'new',
          lane: 'triage',
          severity: body.severity ?? 'normal',
          route: body.route_path ?? null,
          capture_session_id: state.captureSessionId,
        },
        support_packet: {
          id: 'support-packet-portal-feedback-smoke',
          expires_at: '2026-06-30T22:00:00.000Z',
        },
        event: null,
      })
      return
    }

    if (state.captureSessionId && method === 'POST' && path === `${sessionPath}/discard`) {
      state.discardCount += 1
      await fulfillJson(route, {
        capture_session: {
          id: state.captureSessionId,
          mode: 'feedback',
          status: 'discarded',
          started_at: '2026-05-31T22:00:00.000Z',
          last_seen_at: '2026-05-31T22:00:00.000Z',
        },
      })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ error: `unmocked portal capture smoke API path: ${method} ${path}` }),
    })
  })
}

function postJson(raw: string | null): JsonObject {
  expect(raw).toBeTruthy()
  return JSON.parse(raw ?? '{}') as JsonObject
}

function multipartField(body: string, name: string): string {
  const match = body.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`))
  return match?.[1]?.trim() ?? ''
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
    'access-control-allow-origin': 'http://localhost:3100',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-request-id,sentry-trace,baggage,x-sitelayer-capture-session-id',
  }
}

const portalEstimateFixture = {
  id: 'estimate-share-portal-feedback-smoke',
  project_name: 'Acme Roof Access',
  company_name: 'Sitelayer Demo',
  recipient_email: 'pilot@example.com',
  recipient_name: 'Pilot User',
  sent_at: '2026-05-31T18:00:00.000Z',
  expires_at: '2026-06-07T18:00:00.000Z',
  status: 'pending',
  accepted_at: null,
  declined_at: null,
  decline_reason: null,
  signer_name: null,
  estimate: {
    bid_total: 1280,
    scope_total: 1280,
    captured_at: '2026-05-31T18:00:00.000Z',
    lines: [
      {
        service_item_code: 'SCAF-FRAME',
        quantity: 2,
        unit: 'ea',
        rate: 640,
        amount: 1280,
        division_code: 'D4',
      },
    ],
  },
} as const
