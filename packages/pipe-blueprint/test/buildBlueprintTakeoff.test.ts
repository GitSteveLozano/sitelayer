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

  it('live path: accepts in-memory pdfBytes (multipart upload flow) and hashes them identically to the on-disk pdfPath case', async () => {
    // Multipart-streaming dispatcher hands the pipeline (a) the storage
    // key as a logical label and (b) the persisted bytes directly. The
    // pipeline must hash + base64 the bytes, never touch the filesystem.
    const classify = await loadJson<unknown>('mock-claude-classify-response.json')
    const extract = await loadJson<unknown>('mock-claude-extract-response.json')
    const { client, callLog } = makeFakeClient([JSON.stringify(classify), JSON.stringify(extract)])
    const sha = await pdfSha256()
    const bytes = await readFile(PDF_PATH)
    const logicalKey = 'company-1/blueprint-abc/uploaded.pdf'
    const capturedAt = '2026-05-10T12:00:00.000Z'

    const result = await buildBlueprintTakeoff({
      pdfPath: logicalKey,
      pdfBytes: bytes,
      capturedAt,
      projectId: 'live-project',
      anthropicClient: client as unknown as never,
    })

    // SHA matches the on-disk bytes, the artifact records the Spaces key
    // as the source path (not a local filesystem path), and the override
    // capturedAt comes through verbatim.
    expect(result.capturedAt).toBe(capturedAt)
    const artifact = result.sourceArtifact as {
      kind: 'blueprint'
      blueprint: { pdfSha256: string; sourcePdfPath: string }
    }
    expect(artifact.kind).toBe('blueprint')
    expect(artifact.blueprint.pdfSha256).toBe(sha)
    expect(artifact.blueprint.sourcePdfPath).toBe(logicalKey)
    // Two real Anthropic calls were dispatched (classify + extract).
    expect(callLog).toHaveLength(2)
    expect(result.quantities.length).toBeGreaterThan(0)
  })

  it('live path: passes the PDF as a base64 document block to Anthropic and parses strict JSON back', async () => {
    // This is the explicit "wired to Anthropic" assertion: capture the
    // request the SDK saw and verify the document block payload + media
    // type, plus the strict-JSON parse round-trip.
    const classify = await loadJson<unknown>('mock-claude-classify-response.json')
    const extract = await loadJson<unknown>('mock-claude-extract-response.json')
    const bytes = await readFile(PDF_PATH)
    const expectedBase64 = bytes.toString('base64')

    const capturedRequests: Array<Record<string, unknown>> = []
    const client = {
      messages: {
        create: async (args: unknown) => {
          capturedRequests.push(args as Record<string, unknown>)
          const isFirst = capturedRequests.length === 1
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(isFirst ? classify : extract),
              },
            ],
          }
        },
      },
    }

    await buildBlueprintTakeoff({
      pdfPath: 'company-1/blueprint-xyz/sheet.pdf',
      pdfBytes: bytes,
      projectId: 'live-project',
      anthropicClient: client as unknown as never,
    })

    expect(capturedRequests).toHaveLength(2)
    for (const req of capturedRequests) {
      const messages = req.messages as Array<{ content: Array<Record<string, unknown>> }>
      const doc = messages[0]!.content[0]!
      expect(doc.type).toBe('document')
      const source = doc.source as { type: string; media_type: string; data: string }
      expect(source.type).toBe('base64')
      expect(source.media_type).toBe('application/pdf')
      expect(source.data).toBe(expectedBase64)
      expect(req.model).toBe('claude-opus-4-7')
    }
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
