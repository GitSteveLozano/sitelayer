/**
 * End-to-end tests for buildBlueprintTakeoff.
 *
 * The Anthropic client is stubbed by passing a fake `anthropicClient`
 * into options. We never make a real API call.
 */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildBlueprintTakeoff, NoDrawingsFoundError } from '../src/extract.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX = join(__dirname, '..', 'fixtures')
const PDF_PATH = join(FIX, 'tiny.pdf')

async function pdfSha256(): Promise<string> {
  const bytes = await readFile(PDF_PATH)
  return createHash('sha256').update(bytes).digest('hex')
}

interface FakeContent {
  type: 'text'
  text: string
}
interface FakeResponse {
  content: FakeContent[]
}

function makeFakeClient(responses: string[]): {
  client: { messages: { create: (..._args: unknown[]) => Promise<FakeResponse> } }
  callLog: Array<{ promptStart: string }>
} {
  let i = 0
  const callLog: Array<{ promptStart: string }> = []
  const client = {
    messages: {
      create: async (args: unknown): Promise<FakeResponse> => {
        const a = args as {
          messages: Array<{ content: Array<{ type: string; text?: string }> }>
        }
        const txt = a.messages[0]?.content.find((c) => c.type === 'text')?.text ?? ''
        callLog.push({ promptStart: txt.slice(0, 60) })
        const r = responses[i++]
        if (r == null) throw new Error('fake client out of responses')
        return { content: [{ type: 'text', text: r }] }
      },
    },
  }
  return { client, callLog }
}

async function loadJson<T>(name: string): Promise<T> {
  const raw = await readFile(join(FIX, name), 'utf8')
  return JSON.parse(raw) as T
}

describe('buildBlueprintTakeoff (mocked Anthropic)', () => {
  it('produces a TakeoffResult matching the golden fixture', async () => {
    const classify = await loadJson<unknown>('mock-claude-classify-response.json')
    const extract = await loadJson<unknown>('mock-claude-extract-response.json')
    const expected = await loadJson<Record<string, unknown>>('expected-takeoff-from-mock.json')
    const sha = await pdfSha256()

    const { client } = makeFakeClient([JSON.stringify(classify), JSON.stringify(extract)])

    const result = await buildBlueprintTakeoff({
      pdfPath: PDF_PATH,
      projectId: 'test-project',
      // Cast: our fake matches the surface area we use.
      anthropicClient: client as unknown as never,
    })

    // Strip non-deterministic + path-dependent fields before compare.
    const stripped = stripVolatile(result)
    const expectedStripped = stripVolatile(hydrate(expected, sha, PDF_PATH) as Record<string, unknown>)

    expect(stripped).toEqual(expectedStripped)
  })

  it('throws NoDrawingsFoundError when the PDF has no plan pages', async () => {
    const classifyAllNonDrawing = {
      pages: [
        { pageIndex: 0, kind: 'non_drawing', confidence: 0.95, reasoning: 'email' },
        { pageIndex: 1, kind: 'non_drawing', confidence: 0.92, reasoning: 'letter' },
      ],
    }
    const { client } = makeFakeClient([JSON.stringify(classifyAllNonDrawing)])

    await expect(
      buildBlueprintTakeoff({
        pdfPath: PDF_PATH,
        projectId: 'test-project',
        anthropicClient: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(NoDrawingsFoundError)
  })

  it('uses user_known_dimension when knownDimensionFt matches a wall', async () => {
    const classify = await loadJson<unknown>('mock-claude-classify-response.json')
    const extract = await loadJson<unknown>('mock-claude-extract-response.json')
    const { client } = makeFakeClient([JSON.stringify(classify), JSON.stringify(extract)])

    const result = await buildBlueprintTakeoff({
      pdfPath: PDF_PATH,
      projectId: 'test-project',
      knownDimensionFt: 12, // matches w1's annotated "12'-0""
      anthropicClient: client as unknown as never,
    })

    const page0 = (
      result.sourceArtifact as {
        blueprint: { pages: Array<{ scale?: { source: string; confidence: number } }> }
      }
    ).blueprint.pages[0]
    expect(page0).toBeDefined()
    expect(page0!.scale!.source).toBe('user_known_dimension')
    expect(page0!.scale!.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('propagates low classification confidence into quantity confidence', async () => {
    const classifyLow = {
      pages: [{ pageIndex: 0, kind: 'floor_plan', confidence: 0.3, reasoning: 'blurry' }],
    }
    const extract = await loadJson<unknown>('mock-claude-extract-response.json')
    const { client } = makeFakeClient([JSON.stringify(classifyLow), JSON.stringify(extract)])

    const result = await buildBlueprintTakeoff({
      pdfPath: PDF_PATH,
      projectId: 'test-project',
      anthropicClient: client as unknown as never,
    })

    // All quantities should be capped at min(scale.confidence, classification.confidence) = min(0.6, 0.3) = 0.3
    // After the 1.0 boost for "measured" → 0.3.
    for (const q of result.quantities) {
      expect(q.confidence).toBeLessThanOrEqual(0.3 + 1e-9)
    }
    expect(result.reviewRequired).toBe(true)
  })

  it('dry-run smoke test produces a valid TakeoffResult without an API key', async () => {
    const result = await buildBlueprintTakeoff({
      pdfPath: PDF_PATH,
      projectId: 'spike-001',
      dryRun: true,
    })
    expect(result.source).toBe('blueprint.vision')
    expect(result.units).toBe('imperial')
    expect(result.quantities.length).toBeGreaterThan(0)
  })
})

// ─── helpers ───────────────────────────────────────────────────────────────

function stripVolatile<T>(o: T): unknown {
  if (o && typeof o === 'object') {
    if (Array.isArray(o)) return o.map(stripVolatile)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === 'takeoffId' || k === 'producedAt' || k === 'capturedAt') continue
      out[k] = stripVolatile(v)
    }
    return out
  }
  return o
}

function hydrate(o: Record<string, unknown>, sha: string, pdfPath: string): unknown {
  const json = JSON.stringify(o)
    .replace(/__PDF_SHA256__/g, sha)
    .replace(/__PDF_PATH__/g, pdfPath)
  return JSON.parse(json)
}
