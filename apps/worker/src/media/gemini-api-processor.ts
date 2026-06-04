// Gemini API media-understanding adapter. Uploads sampled frames inline and
// asks generateContent for a structured-JSON understanding via responseSchema.
//
// This is the CASH path (metered tokens), so it is OFF unless explicitly enabled
// (`MEDIA_UNDERSTANDING_GEMINI_API_ENABLED=1`) AND a key is present — mirroring
// mesh's `MESH_ENABLE_GEMINI_API` gate (`~/CLAUDE.md` rules 3/4). flash-lite is
// the cheap default (~$0.10/$0.40 per Mtok); confirm with the operator before
// enabling at volume.

import {
  buildMediaUnderstandingPrompt,
  MEDIA_UNDERSTANDING_SEVERITIES,
  parseMediaUnderstanding,
  type MediaProcessor,
  type MediaUnderstandInput,
  type MediaUnderstanding,
} from './media-processor.js'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const ANALYZER = 'gemini-api-v1'
const DEFAULT_MODEL = 'gemini-3.1-flash-lite'
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    suggested_title: { type: 'string' },
    suggested_severity: { type: 'string', enum: [...MEDIA_UNDERSTANDING_SEVERITIES] },
    action_items: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['summary'],
}

export function geminiApiKeyFromEnv(): string | null {
  const key =
    process.env.MEDIA_UNDERSTANDING_GEMINI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
  return key && key.trim() ? key.trim() : null
}

export function geminiApiEnabled(): boolean {
  const raw = process.env.MEDIA_UNDERSTANDING_GEMINI_API_ENABLED?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

export function createGeminiApiUnderstandingProcessor(deps?: {
  fetchImpl?: FetchLike
  apiKey?: string
  model?: string
}): MediaProcessor {
  const fetchImpl = deps?.fetchImpl ?? (globalThis.fetch as FetchLike | undefined)
  if (!fetchImpl) throw new Error('gemini api processor requires a fetch implementation')
  const apiKey = deps?.apiKey ?? geminiApiKeyFromEnv()
  if (!apiKey) throw new Error('gemini api processor requires MEDIA_UNDERSTANDING_GEMINI_API_KEY (or GEMINI_API_KEY)')
  const envModel = process.env.MEDIA_UNDERSTANDING_API_MODEL?.trim()
  const model = deps?.model ?? (envModel && envModel.length > 0 ? envModel : DEFAULT_MODEL)
  const maxFrames = Math.min(readPositiveInt('MEDIA_UNDERSTANDING_API_MAX_FRAMES', 6), 16)
  const timeoutMs = readPositiveInt('MEDIA_UNDERSTANDING_API_TIMEOUT_MS', 90_000)

  return {
    analyzer: ANALYZER,
    async understand(input: MediaUnderstandInput): Promise<MediaUnderstanding> {
      const frames = (input.frames ?? []).slice(0, maxFrames)
      const parts: Array<Record<string, unknown>> = [{ text: buildMediaUnderstandingPrompt(input) }]
      for (const frame of frames) {
        parts.push({
          inline_data: {
            mime_type: frame.content_type || 'image/jpeg',
            data: frame.bytes.toString('base64'),
          },
        })
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetchImpl(
          `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: RESPONSE_SCHEMA,
              },
            }),
            signal: controller.signal,
          },
        )
      } finally {
        clearTimeout(timer)
      }
      const text = await response.text().catch(() => '')
      if (!response.ok) {
        throw new Error(`gemini api generateContent failed: ${response.status} ${text.slice(0, 240)}`)
      }
      return parseMediaUnderstanding(extractCandidateText(text), ANALYZER)
    },
  }
}

// generateContent wraps the model output in candidates[0].content.parts[].text;
// pull the concatenated text so the shared parser can read the JSON.
export function extractCandidateText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const parts = parsed.candidates?.[0]?.content?.parts ?? []
    const text = parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
    return text || raw
  } catch {
    return raw
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
