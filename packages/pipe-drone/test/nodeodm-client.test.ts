import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  nodeOdmCreateTask,
  nodeOdmGetInfo,
  nodeOdmCommitTask,
  nodeOdmWaitForCompletion,
  NODEODM_STATUS,
} from '../src/nodeodm-client.js'

const NODE_ODM_URL = 'http://nodeodm.test:3000'

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetchSequence(responses: Array<Partial<Response> | (() => Partial<Response>)>) {
  let i = 0
  vi.mocked(fetch).mockImplementation(async () => {
    const next = responses[i++]
    const built = typeof next === 'function' ? next() : next
    return new Response(built?.body as BodyInit | null | undefined, {
      status: built?.status ?? 200,
      statusText: built?.statusText ?? 'OK',
      headers: built?.headers as HeadersInit | undefined,
    })
  })
}

describe('nodeOdmCreateTask', () => {
  it('returns the uuid from a 200 JSON response', async () => {
    mockFetchSequence([{ body: JSON.stringify({ uuid: 'abc-123' }), status: 200 }])
    const r = await nodeOdmCreateTask({ nodeOdmUrl: NODE_ODM_URL })
    expect(r.uuid).toBe('abc-123')
    expect(fetch).toHaveBeenCalledWith(`${NODE_ODM_URL}/task/new/init`, expect.objectContaining({ method: 'POST' }))
  })

  it('trims trailing slash from nodeOdmUrl', async () => {
    mockFetchSequence([{ body: JSON.stringify({ uuid: 'u' }), status: 200 }])
    await nodeOdmCreateTask({ nodeOdmUrl: NODE_ODM_URL + '/' })
    expect(fetch).toHaveBeenCalledWith(`${NODE_ODM_URL}/task/new/init`, expect.anything())
  })

  it('throws on non-2xx', async () => {
    mockFetchSequence([{ body: 'boom', status: 503, statusText: 'Unavailable' }])
    await expect(nodeOdmCreateTask({ nodeOdmUrl: NODE_ODM_URL })).rejects.toThrow(/503/)
  })

  it('throws when uuid missing from body', async () => {
    mockFetchSequence([{ body: JSON.stringify({ error: 'nope' }), status: 200 }])
    await expect(nodeOdmCreateTask({ nodeOdmUrl: NODE_ODM_URL })).rejects.toThrow(/missing uuid/)
  })
})

describe('nodeOdmGetInfo', () => {
  it('parses status code and progress', async () => {
    mockFetchSequence([
      {
        body: JSON.stringify({
          uuid: 'abc',
          status: { code: 20 },
          progress: 41.7,
        }),
        status: 200,
      },
    ])
    const info = await nodeOdmGetInfo({ nodeOdmUrl: NODE_ODM_URL, uuid: 'abc' })
    expect(info.uuid).toBe('abc')
    expect(info.status.code).toBe(NODEODM_STATUS.RUNNING)
    expect(info.status.code).toBe(20)
    expect(info.progress).toBeCloseTo(41.7, 5)
  })

  it('propagates errorMessage when failed', async () => {
    mockFetchSequence([
      {
        body: JSON.stringify({
          uuid: 'abc',
          status: { code: 30, errorMessage: 'GPU exploded' },
          progress: 0,
        }),
        status: 200,
      },
    ])
    const info = await nodeOdmGetInfo({ nodeOdmUrl: NODE_ODM_URL, uuid: 'abc' })
    expect(info.status.code).toBe(NODEODM_STATUS.FAILED)
    expect(info.status.errorMessage).toBe('GPU exploded')
  })

  it('recognises completed code 40', async () => {
    mockFetchSequence([{ body: JSON.stringify({ uuid: 'abc', status: { code: 40 }, progress: 100 }), status: 200 }])
    const info = await nodeOdmGetInfo({ nodeOdmUrl: NODE_ODM_URL, uuid: 'abc' })
    expect(info.status.code).toBe(NODEODM_STATUS.COMPLETED)
  })
})

describe('nodeOdmCommitTask', () => {
  it('POSTs to /task/new/commit/:uuid', async () => {
    mockFetchSequence([{ body: '{}', status: 200 }])
    await nodeOdmCommitTask({ nodeOdmUrl: NODE_ODM_URL, uuid: 'abc' })
    expect(fetch).toHaveBeenCalledWith(
      `${NODE_ODM_URL}/task/new/commit/abc`,
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

describe('nodeOdmWaitForCompletion', () => {
  it('returns completed when status reaches 40', async () => {
    mockFetchSequence([
      { body: JSON.stringify({ uuid: 'x', status: { code: 20 }, progress: 50 }), status: 200 },
      { body: JSON.stringify({ uuid: 'x', status: { code: 40 }, progress: 100 }), status: 200 },
    ])
    const r = await nodeOdmWaitForCompletion({
      nodeOdmUrl: NODE_ODM_URL,
      uuid: 'x',
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    })
    expect(r.status).toBe('completed')
  })

  it('returns failed with errorMessage when status reaches 30', async () => {
    mockFetchSequence([
      {
        body: JSON.stringify({ uuid: 'x', status: { code: 30, errorMessage: 'bad' }, progress: 0 }),
        status: 200,
      },
    ])
    const r = await nodeOdmWaitForCompletion({
      nodeOdmUrl: NODE_ODM_URL,
      uuid: 'x',
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    })
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.errorMessage).toBe('bad')
  })

  it('returns timeout when poll exceeds budget', async () => {
    mockFetchSequence(
      Array.from({ length: 50 }, () => () => ({
        body: JSON.stringify({ uuid: 'x', status: { code: 20 }, progress: 10 }),
        status: 200,
      })),
    )
    const r = await nodeOdmWaitForCompletion({
      nodeOdmUrl: NODE_ODM_URL,
      uuid: 'x',
      pollIntervalMs: 1,
      timeoutMs: 20,
    })
    expect(r.status).toBe('timeout')
  })
})
