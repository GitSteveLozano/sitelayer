import { describe, expect, it } from 'vitest'
import { buildBlueprintTakeoff } from './extract.js'
import type { TakeoffVisionProvider, TakeoffVisionResult } from './provider.js'

// Known-valid classify/extract JSON (mirrors the in-module dry-run fixtures, so
// it passes the same zod validation the Claude path uses).
const CLASSIFY_JSON = JSON.stringify({
  pages: [{ pageIndex: 0, kind: 'floor_plan', confidence: 0.9, reasoning: 'mock' }],
})
const EXTRACT_JSON = JSON.stringify({
  imageSize: { widthPx: 1000, heightPx: 800 },
  titleblock: {
    projectName: 'T',
    sheetNumber: 'A-101',
    sheetTitle: 'FP',
    scaleText: '1/4" = 1\'-0"',
    northArrowDeg: 0,
    drawingDate: null,
  },
  dimensionStrings: ['12\'-0"', '10\'-0"'],
  rooms: [
    {
      id: 'r1',
      name: 'ROOM',
      polygon: [
        { x: 100, y: 100 },
        { x: 400, y: 100 },
        { x: 400, y: 350 },
        { x: 100, y: 350 },
      ],
      annotatedAreaText: null,
      annotatedPerimeterText: null,
      openings: [],
    },
  ],
  walls: [
    { id: 'w1', start: { x: 100, y: 100 }, end: { x: 400, y: 100 }, thicknessIn: null, annotatedLengthText: '12\'-0"' },
  ],
  notes: ['mock'],
  warnings: [],
})

function fakeProvider(): { provider: TakeoffVisionProvider; calls: string[] } {
  const calls: string[] = []
  const provider: TakeoffVisionProvider = {
    id: 'gemini-api',
    async run(req): Promise<TakeoffVisionResult> {
      const isExtract = /Focus on page index/i.test(req.prompt)
      calls.push(isExtract ? 'extract' : 'classify')
      return {
        // gemini often wraps JSON in a ```json fence — provider path must tolerate it.
        text: isExtract ? '```json\n' + EXTRACT_JSON + '\n```' : CLASSIFY_JSON,
        cost: {
          provider: 'gemini-api',
          model: 'gemini-3.1-flash-lite',
          inputTokens: 100,
          outputTokens: 50,
          imageTokens: 0,
          billedUsd: 0.0001,
          shadowApiUsd: 0.0001,
        },
      }
    },
  }
  return { provider, calls }
}

describe('buildBlueprintTakeoff via a pluggable vision provider (gap G1/G3)', () => {
  it('routes classify + extract through the provider (not Claude) and builds a takeoff', async () => {
    const { provider, calls } = fakeProvider()
    const result = await buildBlueprintTakeoff({
      pdfPath: 'unused.pdf', // required by the type; pdfBytes overrides it so it's never read
      pdfBytes: Buffer.from('%PDF-1.4 fake-bytes'),
      projectId: 'p1',
      visionProvider: provider,
    })
    expect(result).toBeTruthy()
    // The provider drove both stages — proving Claude was bypassed entirely.
    expect(calls).toContain('classify')
    expect(calls).toContain('extract')
    // And a takeoff was produced from the provider's (fenced) JSON.
    expect(JSON.stringify(result).toLowerCase()).toContain('room')
  })
})
