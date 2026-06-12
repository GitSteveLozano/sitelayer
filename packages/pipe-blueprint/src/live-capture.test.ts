import { describe, expect, it, vi } from 'vitest'
import {
  BlueprintVisionProviderError,
  buildDryRunSkeleton,
  geminiLiveTakeoffRows,
  relabelQuantities,
  runLiveBlueprintCapture,
} from './live-capture.js'

// The shared LIVE blueprint-vision implementation (worker-side). The honesty
// contract under test:
//   - provider errors THROW (typed) — there is NO fallback to demo/stub rows;
//   - successful runs surface REAL token usage from the provider response
//     (usageMetadata), never an invented per-page figure.

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

function geminiResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

function geminiEnvelope(quantities: unknown[], usage?: { promptTokenCount?: number; candidatesTokenCount?: number }) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ quantities }) }] } }],
    ...(usage ? { usageMetadata: usage } : {}),
  }
}

const IMAGE = { bytes: Buffer.from('fake-image'), mimeType: 'image/png' }

describe('geminiLiveTakeoffRows', () => {
  it('parses rows AND real usageMetadata token counts off the response', async () => {
    const fetchImpl = vi.fn(async () =>
      geminiResponse(
        geminiEnvelope(
          [
            { description: 'Exterior wall EPS', value: 1200, unit: 'sqft', confidence: 0.9 },
            { description: 'Sealant joints', value: 300, unit: 'lft', confidence: 0.7 },
          ],
          { promptTokenCount: 1234, candidatesTokenCount: 88 },
        ),
      ),
    )
    const { rows, usage } = await geminiLiveTakeoffRows(IMAGE, {
      apiKey: 'k',
      model: 'gemini-3.1-flash-lite',
      fetchImpl,
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ description: 'Exterior wall EPS', value: 1200, unit: 'sqft', confidence: 0.9 })
    expect(usage).toEqual({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      input_tokens: 1234,
      output_tokens: 88,
    })
  })

  it('stores null token counts when usageMetadata is absent (never invents numbers)', async () => {
    const fetchImpl = vi.fn(async () =>
      geminiResponse(geminiEnvelope([{ description: 'x', value: 1, unit: 'ea', confidence: 0.5 }])),
    )
    const { usage } = await geminiLiveTakeoffRows(IMAGE, { apiKey: 'k', fetchImpl })
    expect(usage.input_tokens).toBeNull()
    expect(usage.output_tokens).toBeNull()
  })

  it('THROWS a typed provider error on HTTP failure — no stub fallback', async () => {
    const fetchImpl = vi.fn(async () => geminiResponse({ error: { message: 'quota exceeded' } }, { status: 429 }))
    await expect(geminiLiveTakeoffRows(IMAGE, { apiKey: 'k', fetchImpl })).rejects.toThrow(BlueprintVisionProviderError)
    await expect(geminiLiveTakeoffRows(IMAGE, { apiKey: 'k', fetchImpl })).rejects.toThrow(/HTTP 429/)
  })

  it('THROWS when the model returns zero usable quantities', async () => {
    const fetchImpl = vi.fn(async () => geminiResponse(geminiEnvelope([])))
    await expect(geminiLiveTakeoffRows(IMAGE, { apiKey: 'k', fetchImpl })).rejects.toThrow(/zero usable quantities/)
  })

  it('THROWS on a network error instead of returning null', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    await expect(geminiLiveTakeoffRows(IMAGE, { apiKey: 'k', fetchImpl })).rejects.toThrow(/request failed: ECONNRESET/)
  })
})

describe('relabelQuantities', () => {
  it('rewrites quantities onto the skeleton template, clamping value/confidence', async () => {
    const skeleton = await buildDryRunSkeleton(PROJECT_ID)
    relabelQuantities(skeleton, [
      { description: 'A', value: -5, unit: 'sqft', confidence: 2 },
      { description: 'B', value: 10, unit: 'ea', confidence: 0.4 },
    ])
    expect(skeleton.quantities).toHaveLength(2)
    expect(skeleton.quantities[0]!.value).toBe(0)
    expect(skeleton.quantities[0]!.confidence).toBe(1)
    expect(skeleton.quantities[1]!.unit).toBe('ea')
    // Template fields (codes/provenance) survive the relabel.
    expect(
      skeleton.quantities[0]!.masterformatCode ??
        skeleton.quantities[0]!.uniformatCode ??
        skeleton.quantities[0]!.omniclassCode,
    ).toBeTruthy()
  })
})

describe('runLiveBlueprintCapture (gemini)', () => {
  it('returns a schema-valid result with gemini-live provenance and real usage', async () => {
    const fetchImpl = vi.fn(async () =>
      geminiResponse(
        geminiEnvelope([{ description: 'Exterior wall EPS', value: 4200, unit: 'sqft', confidence: 0.92 }], {
          promptTokenCount: 999,
          candidatesTokenCount: 42,
        }),
      ),
    )
    const outcome = await runLiveBlueprintCapture({
      provider: 'gemini',
      projectId: PROJECT_ID,
      input: IMAGE,
      storagePath: 'company/bp/blueprint.pdf',
      gemini: { apiKey: 'k', model: 'gemini-3.1-flash-lite', fetchImpl },
    })
    expect(outcome.provenance).toBe('gemini-live')
    expect(outcome.result.quantities).toHaveLength(1)
    expect(outcome.result.quantities[0]!.description).toBe('Exterior wall EPS')
    expect(outcome.usage).toEqual({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      input_tokens: 999,
      output_tokens: 42,
    })
  })

  it('propagates provider errors — the caller decides failure handling', async () => {
    const fetchImpl = vi.fn(async () => geminiResponse('upstream blew up', { status: 500 }))
    await expect(
      runLiveBlueprintCapture({
        provider: 'gemini',
        projectId: PROJECT_ID,
        input: IMAGE,
        storagePath: 'company/bp/blueprint.pdf',
        gemini: { apiKey: 'k', fetchImpl },
      }),
    ).rejects.toThrow(BlueprintVisionProviderError)
  })
})
