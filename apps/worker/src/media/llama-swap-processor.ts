// llama-swap media-understanding adapter. This is the local-GPU, no-cash path:
// llama-swap exposes llama.cpp behind an OpenAI-compatible /v1 endpoint and
// swaps/pins local GGUF models according to the host config.

import {
  buildMediaUnderstandingPrompt,
  parseMediaUnderstanding,
  type MediaProcessor,
  type MediaUnderstandInput,
  type MediaUnderstanding,
} from './media-processor.js'

export type LlamaSwapFetchLike = (url: string, init: RequestInit) => Promise<Response>

const ANALYZER = 'llama-swap-v1'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8081/v1'
const DEFAULT_MODEL = 'gemma4-12b-vision'

export function createLlamaSwapUnderstandingProcessor(deps?: {
  fetchImpl?: LlamaSwapFetchLike
  baseUrl?: string
  model?: string
}): MediaProcessor {
  const fetchImpl = deps?.fetchImpl ?? (globalThis.fetch as LlamaSwapFetchLike | undefined)
  if (!fetchImpl) throw new Error('llama-swap processor requires a fetch implementation')
  const baseUrl = normalizeBaseUrl(
    deps?.baseUrl ??
      process.env.MEDIA_UNDERSTANDING_LLAMASWAP_URL ??
      process.env.LLAMA_SWAP_OPENAI_BASE_URL ??
      DEFAULT_BASE_URL,
  )
  const model = deps?.model ?? process.env.MEDIA_UNDERSTANDING_LLAMASWAP_MODEL?.trim() ?? DEFAULT_MODEL
  const maxFrames = Math.min(readPositiveInt('MEDIA_UNDERSTANDING_LLAMASWAP_MAX_FRAMES', 8), 24)
  const timeoutMs = readPositiveInt('MEDIA_UNDERSTANDING_LLAMASWAP_TIMEOUT_MS', 120_000)
  const maxTokens = readPositiveInt('MEDIA_UNDERSTANDING_LLAMASWAP_MAX_TOKENS', 800)

  return {
    analyzer: ANALYZER,
    async understand(input: MediaUnderstandInput): Promise<MediaUnderstanding> {
      const content: Array<Record<string, unknown>> = [{ type: 'text', text: buildMediaUnderstandingPrompt(input) }]
      for (const frame of (input.frames ?? []).slice(0, maxFrames)) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${frame.content_type || 'image/jpeg'};base64,${frame.bytes.toString('base64')}`,
          },
        })
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content }],
            temperature: 0.1,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }

      const text = await response.text().catch(() => '')
      if (!response.ok) {
        throw new Error(`llama-swap chat completion failed: ${response.status} ${text.slice(0, 240)}`)
      }
      return parseMediaUnderstanding(extractOpenAIChatText(text), ANALYZER)
    },
  }
}

export function extractOpenAIChatText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      choices?: Array<{
        text?: unknown
        message?: {
          content?: unknown
        }
      }>
      output_text?: unknown
    }
    const choice = parsed.choices?.[0]
    const content = choice?.message?.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === 'string') return part
          if (part && typeof part === 'object' && 'text' in part) {
            const value = (part as { text?: unknown }).text
            return typeof value === 'string' ? value : ''
          }
          return ''
        })
        .join('')
        .trim()
      if (text) return text
    }
    if (typeof choice?.text === 'string' && choice.text.trim()) return choice.text.trim()
    if (typeof parsed.output_text === 'string' && parsed.output_text.trim()) return parsed.output_text.trim()
    return raw
  } catch {
    return raw
  }
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
