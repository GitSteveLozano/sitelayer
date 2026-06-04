import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildMediaUnderstandingPrompt,
  createStubUnderstandingProcessor,
  parseMediaUnderstanding,
  resolveMediaUnderstandMode,
  type MediaUnderstandFrame,
} from './media-processor.js'
import { createMediaUnderstandingProcessor } from './create-media-understanding-processor.js'
import { createGeminiCliUnderstandingProcessor, type GeminiCliRunner } from './gemini-cli-processor.js'
import { createGeminiApiUnderstandingProcessor, extractCandidateText } from './gemini-api-processor.js'

function frame(index: number): MediaUnderstandFrame {
  return { index, time_seconds: index, content_type: 'image/jpeg', bytes: Buffer.from(`frame-${index}`) }
}

const VALID = JSON.stringify({
  summary: 'User could not save the estimate; the Save button did nothing.',
  suggested_title: 'Save button on estimate screen is unresponsive',
  suggested_severity: 'high',
  action_items: ['Reproduce on the estimate screen', 'Check the save mutation handler'],
  confidence: 0.8,
})

describe('resolveMediaUnderstandMode', () => {
  it('maps the video-mode alias and unknowns', () => {
    expect(resolveMediaUnderstandMode('gemini')).toBe('gemini-cli')
    expect(resolveMediaUnderstandMode('gemini-cli')).toBe('gemini-cli')
    expect(resolveMediaUnderstandMode('gemini-api')).toBe('gemini-api')
    expect(resolveMediaUnderstandMode('stub')).toBe('stub')
    expect(resolveMediaUnderstandMode('nonsense')).toBe('off')
    expect(resolveMediaUnderstandMode(undefined)).toBe('off')
  })
})

describe('parseMediaUnderstanding', () => {
  it('parses a clean JSON object', () => {
    const out = parseMediaUnderstanding(VALID, 'test')
    expect(out.summary).toContain('Save button')
    expect(out.suggested_title).toBe('Save button on estimate screen is unresponsive')
    expect(out.suggested_severity).toBe('high')
    expect(out.action_items).toHaveLength(2)
    expect(out.confidence).toBe(0.8)
    expect(out.analyzer).toBe('test')
  })

  it('extracts JSON wrapped in prose / code fences', () => {
    const wrapped = `Here you go:\n\`\`\`json\n${VALID}\n\`\`\`\nThanks!`
    const out = parseMediaUnderstanding(wrapped, 'test')
    expect(out.suggested_severity).toBe('high')
    expect(out.action_items).toHaveLength(2)
  })

  it('falls back to summary text when there is no JSON', () => {
    const out = parseMediaUnderstanding('the model rambled with no json', 'test')
    expect(out.summary).toBe('the model rambled with no json')
    expect(out.suggested_severity).toBeNull()
    expect(out.action_items).toEqual([])
    expect(out.confidence).toBeNull()
  })

  it('drops invalid severity, clamps confidence, caps action items', () => {
    const out = parseMediaUnderstanding(
      JSON.stringify({
        summary: 'x',
        suggested_severity: 'catastrophic',
        confidence: 3.5,
        action_items: ['a', 'b', 'c', 'd', 'e', 'f', 7],
      }),
      'test',
    )
    expect(out.suggested_severity).toBeNull()
    expect(out.confidence).toBe(1)
    expect(out.action_items).toHaveLength(5)
  })
})

describe('buildMediaUnderstandingPrompt', () => {
  it('includes context + a bounded transcript', () => {
    const prompt = buildMediaUnderstandingPrompt({
      frames: [frame(1)],
      transcript: 'word '.repeat(5000),
      context: { kind: 'video', title: 'T', route: '/estimate' },
    })
    expect(prompt).toContain('/estimate')
    expect(prompt).toContain('video_frames_attached: 1')
    expect(prompt).toContain('Transcript:')
    // transcript is sliced to 8000 chars, so the whole prompt stays bounded
    expect(prompt.length).toBeLessThan(9000)
  })
})

describe('createStubUnderstandingProcessor', () => {
  it('is deterministic and never calls out', async () => {
    const proc = createStubUnderstandingProcessor()
    const out = await proc.understand({ frames: [frame(1), frame(2)], context: { kind: 'video', title: 'Hi' } })
    expect(out.analyzer).toBe('media-understanding-stub-v1')
    expect(out.summary).toContain('2 sampled frame(s)')
    expect(out.suggested_title).toBe('Hi')
  })

  it('summarizes a transcript when no frames are present (audio path)', async () => {
    const proc = createStubUnderstandingProcessor()
    const out = await proc.understand({ transcript: 'the save button did nothing', context: { kind: 'audio' } })
    expect(out.summary).toContain('save button')
  })
})

describe('createGeminiCliUnderstandingProcessor', () => {
  it('embeds @frame refs in the prompt and parses runner stdout', async () => {
    const calls: string[][] = []
    const runner: GeminiCliRunner = async (args) => {
      calls.push(args)
      return `\`\`\`json\n${VALID}\n\`\`\``
    }
    const proc = createGeminiCliUnderstandingProcessor({ runner })
    const out = await proc.understand({ frames: [frame(1), frame(2)], context: { kind: 'video' } })
    expect(out.suggested_severity).toBe('high')
    expect(calls).toHaveLength(1)
    const cliArgs = calls[0]!
    expect(cliArgs[0]).toBe('-p')
    // two frames -> two @file references in the prompt
    expect(cliArgs[1]!.match(/@\S+/g)).toHaveLength(2)
  })
})

describe('createGeminiApiUnderstandingProcessor', () => {
  it('parses the generateContent candidate wrapper', async () => {
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: VALID }] } }] }), { status: 200 }),
    )
    const proc = createGeminiApiUnderstandingProcessor({ fetchImpl, apiKey: 'k', model: 'gemini-3.1-flash-lite' })
    const out = await proc.understand({ frames: [frame(1)], context: { kind: 'video' } })
    expect(out.suggested_severity).toBe('high')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('gemini-3.1-flash-lite:generateContent')
    expect(String(url)).not.toContain('key=')
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'k' })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(JSON.stringify(body.contents)).toContain('inline_data')
    expect(body.generationConfig).toMatchObject({
      responseFormat: {
        text: {
          mimeType: 'application/json',
          schema: expect.objectContaining({
            type: 'object',
          }),
        },
      },
    })
  })

  it('throws a clear error on non-200', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    const proc = createGeminiApiUnderstandingProcessor({ fetchImpl, apiKey: 'k' })
    await expect(proc.understand({ frames: [frame(1)], context: { kind: 'video' } })).rejects.toThrow(/500/)
  })
})

describe('extractCandidateText', () => {
  it('returns raw text when not a candidate wrapper', () => {
    expect(extractCandidateText('{"summary":"x"}')).toBe('{"summary":"x"}')
  })
})

describe('createMediaUnderstandingProcessor factory', () => {
  const ENV_KEYS = [
    'MEDIA_UNDERSTANDING_GEMINI_API_ENABLED',
    'MEDIA_UNDERSTANDING_GEMINI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ]
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('off -> null, stub -> stub, gemini-cli -> processor', () => {
    expect(createMediaUnderstandingProcessor('off')).toBeNull()
    expect(createMediaUnderstandingProcessor('stub')?.analyzer).toBe('media-understanding-stub-v1')
    expect(createMediaUnderstandingProcessor('gemini-cli')?.analyzer).toBe('gemini-cli-v1')
  })

  it('gemini-api stays inert (null) unless enabled AND keyed', () => {
    expect(createMediaUnderstandingProcessor('gemini-api')).toBeNull()
    // enabled but no key
    process.env.MEDIA_UNDERSTANDING_GEMINI_API_ENABLED = '1'
    expect(createMediaUnderstandingProcessor('gemini-api')).toBeNull()
    // enabled + key -> real processor
    const proc = createMediaUnderstandingProcessor('gemini-api', {
      apiKey: 'k',
      fetchImpl: (async () => new Response('{}')) as never,
    })
    expect(proc?.analyzer).toBe('gemini-api-v1')
  })
})
