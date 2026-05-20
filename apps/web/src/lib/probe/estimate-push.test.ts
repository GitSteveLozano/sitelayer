import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEstimatePushProbeCachesForTests,
  fetchActiveCompanyRole,
  fetchFeatureFlags,
  fetchWorkflowEventLogTail,
  readDeployCache,
} from './estimate-push'
import { __resetBuildShaCacheForTests, getBuildSha } from '@/lib/api/client'
import type { WorkflowEventLogRow } from './types'

const sentryMock = vi.hoisted(() => ({
  getTraceData: vi.fn<() => Record<string, string>>(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

vi.mock('@/instrument', () => ({
  Sentry: sentryMock,
}))

vi.mock('@/lib/auth', () => ({
  isClerkConfigured: () => false,
}))

describe('fetchWorkflowEventLogTail', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    __resetBuildShaCacheForTests()
    __resetEstimatePushProbeCachesForTests()
    sentryMock.getTraceData.mockReset()
    sentryMock.captureException.mockReset()
    sentryMock.addBreadcrumb.mockReset()
  })

  it('loads the workflow_event_log tail through the normal API client', async () => {
    const row: WorkflowEventLogRow = {
      id: 'wel-1',
      workflow_name: 'estimate_push',
      entity_id: '11111111-1111-4111-8111-111111111111',
      event_type: 'APPROVE',
      from_state: 'reviewed',
      to_state: 'approved',
      from_state_version: 2,
      to_state_version: 3,
      actor_user_id: 'user_1',
      created_at: '2026-05-19T00:00:00.000Z',
      event_payload: { type: 'APPROVE' },
    }
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events: [row] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-sitelayer-build-sha': 'sha-1' },
      }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await fetchWorkflowEventLogTail('estimate_push', row.entity_id, 3)

    expect(result).toEqual({ rows: [row], error: null })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/api/workflow-event-log?entity_type=estimate_push&entity_id=11111111-1111-4111-8111-111111111111&limit=3',
    )
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('x-sitelayer-company-slug')).toBe('la-operations')
    expect(headers.get('x-request-id')).toBeTruthy()
  })

  it('keeps the Probe usable when the event-log endpoint fails', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await fetchWorkflowEventLogTail('estimate_push', '11111111-1111-4111-8111-111111111111', 3)

    expect(result.rows).toEqual([])
    expect(result.error).toContain('workflow_event_log tail unavailable:')
  })
})

describe('Probe side-channel fetches', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    __resetBuildShaCacheForTests()
    __resetEstimatePushProbeCachesForTests()
    sentryMock.getTraceData.mockReset()
    sentryMock.captureException.mockReset()
    sentryMock.addBreadcrumb.mockReset()
  })

  it('loads feature flags through the normal API client and latches build sha', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tier: 'local', flags: ['qbo-live', 'read-prod-ro'], ribbon: null }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-sitelayer-build-sha': 'sha-feature' },
      }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const flags = await fetchFeatureFlags()

    expect(flags).toEqual({
      'qbo-live': 1,
      QBO_LIVE_ESTIMATE_PUSH: 0,
      QBO_LIVE_RENTAL_INVOICE: 0,
      'read-prod-ro': 1,
    })
    expect(getBuildSha()).toBe('sha-feature')
    expect(readDeployCache()).toEqual({ app_build_sha: 'sha-feature', env: null })
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://localhost:3001/api/features')
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('x-sitelayer-company-slug')).toBe('la-operations')
  })

  it('loads the raw active company membership role from session', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ activeCompany: { role: 'office' } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-sitelayer-build-sha': 'sha-session' },
      }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(fetchActiveCompanyRole()).resolves.toBe('office')
    expect(getBuildSha()).toBe('sha-session')
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://localhost:3001/api/session')
  })
})
