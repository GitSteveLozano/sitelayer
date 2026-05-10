import { describe, it, expect, vi, afterEach } from 'vitest'
import { pollLumaJob, submitVideoToLuma } from '../src/luma-client.js'
import { fetchPhotogrammetryTakeoff } from '../src/index.js'
import { validateTakeoffResult } from '@sitelayer/capture-schema'

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json' },
  })
}

describe('submitVideoToLuma', () => {
  it('POSTs multipart with auth header and parses slug', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ slug: 'luma-slug-123', status: 'NEW' }))

    const result = await submitVideoToLuma({
      videoPath: '/dev/null/fake.mp4',
      apiKey: 'test-key',
      title: 'test capture',
      fetchImpl: fetchMock,
      fileLoader: async () => new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'video/mp4' }),
    })

    expect(result.jobId).toBe('luma-slug-123')
    expect(result.status).toBe('queued')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/capture$/)
    expect(init?.method).toBe('POST')
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('luma-api-key=test-key')
    expect(init?.body).toBeInstanceOf(FormData)
  })

  it('throws when the response is non-2xx', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 401 }))
    await expect(
      submitVideoToLuma({
        videoPath: '/dev/null/fake.mp4',
        apiKey: 'bad-key',
        fetchImpl: fetchMock,
        fileLoader: async () => new Blob([new Uint8Array([0])]),
      }),
    ).rejects.toThrow(/Luma submit failed/)
  })
})

describe('pollLumaJob', () => {
  it('GETs status and pulls mesh + preview URLs out of artifacts', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        slug: 'luma-slug-123',
        status: 'FINISHED',
        artifacts: [
          { type: 'preview', url: 'https://blob.example/preview.png' },
          { type: 'glb', url: 'https://blob.example/mesh.glb' },
        ],
      }),
    )

    const result = await pollLumaJob({
      jobId: 'luma-slug-123',
      apiKey: 'test-key',
      fetchImpl: fetchMock,
    })

    expect(result.jobId).toBe('luma-slug-123')
    expect(result.status).toBe('succeeded')
    expect(result.meshUrl).toBe('https://blob.example/mesh.glb')
    expect(result.previewImageUrl).toBe('https://blob.example/preview.png')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/capture\/luma-slug-123$/)
    expect(init?.method).toBe('GET')
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('luma-api-key=test-key')
  })

  it('maps DISPATCHED → processing and returns no mesh url', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ slug: 'x', status: 'DISPATCHED', artifacts: [] }))
    const result = await pollLumaJob({
      jobId: 'x',
      apiKey: 'k',
      fetchImpl: fetchMock,
    })
    expect(result.status).toBe('processing')
    expect(result.meshUrl).toBeUndefined()
  })
})

describe('fetchPhotogrammetryTakeoff', () => {
  it('returns a review-required TakeoffResult that validates', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        slug: 'luma-slug-abc',
        status: 'FINISHED',
        artifacts: [{ type: 'glb', url: 'https://blob.example/mesh.glb' }],
      }),
    )
    // Patch global fetch since fetchPhotogrammetryTakeoff doesn't expose
    // a fetchImpl override (it goes through the default Luma client path).
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch)

    const takeoff = await fetchPhotogrammetryTakeoff('luma-slug-abc', 'spike-001', { apiKey: 'test-key' })

    // Validates against the contract schema.
    expect(() => validateTakeoffResult(takeoff)).not.toThrow()

    expect(takeoff.source).toBe('photogrammetry')
    expect(takeoff.reviewRequired).toBe(true)
    expect(takeoff.quantities).toHaveLength(1)
    const q = takeoff.quantities[0]!
    expect(q.confidence).toBeLessThan(0.1)
    expect(q.description).toMatch(/human labeling required/i)

    expect(takeoff.sourceArtifact?.kind).toBe('photogrammetry')
    if (takeoff.sourceArtifact?.kind === 'photogrammetry') {
      expect(takeoff.sourceArtifact.photogrammetry.meshUrl).toBe('https://blob.example/mesh.glb')
      expect(takeoff.sourceArtifact.photogrammetry.vendor).toBe('luma')
      expect(takeoff.sourceArtifact.photogrammetry.vendorJobId).toBe('luma-slug-abc')
    }
  })

  it('throws if the job has not yet succeeded', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ slug: 'x', status: 'DISPATCHED', artifacts: [] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch)
    await expect(fetchPhotogrammetryTakeoff('x', 'spike-001', { apiKey: 'k' })).rejects.toThrow(/not yet succeeded/)
  })
})
