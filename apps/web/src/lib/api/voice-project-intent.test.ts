import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the base client so we drive stage + poll responses deterministically.
const requestMock = vi.fn()
vi.mock('./client', () => ({
  request: (path: string, opts?: unknown) => requestMock(path, opts),
}))

import {
  resolveVoiceProjectIntent,
  stageVoiceProjectIntent,
  fetchVoiceProjectIntent,
  type ProposedProjectFields,
} from './voice-project-intent'

beforeEach(() => requestMock.mockReset())
afterEach(() => vi.restoreAllMocks())

describe('voice-project-intent client', () => {
  it('stage POSTs the transcript to the stage endpoint', async () => {
    requestMock.mockResolvedValueOnce({ status: 'staged', voice_intent_id: 'v1', response_pending: true })
    await stageVoiceProjectIntent('hello')
    expect(requestMock).toHaveBeenCalledWith('/api/projects/voice-intent', {
      method: 'POST',
      json: { transcript: 'hello' },
    })
  })

  it('fetch GETs the poll endpoint with the id encoded', async () => {
    requestMock.mockResolvedValueOnce({ status: 'pending', voice_intent_id: 'v 1', response_pending: true })
    await fetchVoiceProjectIntent('v 1')
    expect(requestMock).toHaveBeenCalledWith('/api/projects/voice-intent/v%201', { method: 'GET' })
  })

  it('resolve returns null immediately when the deployment reports disabled', async () => {
    requestMock.mockResolvedValueOnce({ status: 'disabled', ai_chat_enabled: false, reason: 'x' })
    const out = await resolveVoiceProjectIntent('hello', { pollIntervalMs: 1, timeoutMs: 50 })
    expect(out).toBeNull()
    // Only the stage call — no poll attempts on the disabled path.
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('resolve stages then polls until parsed, returning the proposed fields', async () => {
    const proposed: ProposedProjectFields = {
      name: 'Maple Ridge',
      customer: { match: 'new', name: 'Acme' },
      divisions: ['scaffold'],
      division_code: 'D3',
    }
    requestMock
      .mockResolvedValueOnce({ status: 'staged', voice_intent_id: 'v1', response_pending: true })
      .mockResolvedValueOnce({ status: 'pending', voice_intent_id: 'v1', response_pending: true })
      .mockResolvedValueOnce({
        status: 'parsed',
        voice_intent_id: 'v1',
        parse_audit_event_id: 'r1',
        proposed,
        created_at: 'now',
      })
    const out = await resolveVoiceProjectIntent('hello', { pollIntervalMs: 1, timeoutMs: 2000 })
    expect(out).toEqual(proposed)
  })

  it('resolve returns null when the parse never lands before the timeout', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 'staged', voice_intent_id: 'v1', response_pending: true })
      .mockResolvedValue({ status: 'pending', voice_intent_id: 'v1', response_pending: true })
    const out = await resolveVoiceProjectIntent('hello', { pollIntervalMs: 1, timeoutMs: 10 })
    expect(out).toBeNull()
  })

  it('resolve aborts cleanly when the signal fires', async () => {
    requestMock.mockResolvedValueOnce({ status: 'staged', voice_intent_id: 'v1', response_pending: true })
    const controller = new AbortController()
    controller.abort()
    const out = await resolveVoiceProjectIntent('hello', {
      signal: controller.signal,
      pollIntervalMs: 1,
      timeoutMs: 2000,
    })
    expect(out).toBeNull()
  })
})
