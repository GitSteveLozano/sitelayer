// Factory: maps a resolved MediaUnderstandMode to a concrete MediaProcessor.
// Returns null when no understanding engine is usable (mode 'off', or
// 'gemini-api' selected without the cash gate enabled / a key present) so the
// caller simply skips understanding for that run rather than spending or
// throwing inside the drain loop.

import {
  createGeminiApiUnderstandingProcessor,
  geminiApiEnabled,
  geminiApiKeyFromEnv,
  type FetchLike,
} from './gemini-api-processor.js'
import { createGeminiCliUnderstandingProcessor, type GeminiCliRunner } from './gemini-cli-processor.js'
import { createLlamaSwapUnderstandingProcessor, type LlamaSwapFetchLike } from './llama-swap-processor.js'
import { createStubUnderstandingProcessor, type MediaProcessor, type MediaUnderstandMode } from './media-processor.js'

export type CreateMediaUnderstandingDeps = {
  cliRunner?: GeminiCliRunner
  fetchImpl?: FetchLike
  llamaSwapFetchImpl?: LlamaSwapFetchLike
  apiKey?: string
}

export function createMediaUnderstandingProcessor(
  mode: MediaUnderstandMode,
  deps: CreateMediaUnderstandingDeps = {},
): MediaProcessor | null {
  switch (mode) {
    case 'off':
      return null
    case 'stub':
      return createStubUnderstandingProcessor()
    case 'llama-swap':
      return createLlamaSwapUnderstandingProcessor(
        deps.llamaSwapFetchImpl ? { fetchImpl: deps.llamaSwapFetchImpl } : undefined,
      )
    case 'gemini-cli':
      return createGeminiCliUnderstandingProcessor(deps.cliRunner ? { runner: deps.cliRunner } : undefined)
    case 'gemini-api': {
      const apiKey = deps.apiKey ?? geminiApiKeyFromEnv()
      // The cash path stays inert unless explicitly enabled AND keyed.
      if (!geminiApiEnabled() || !apiKey) return null
      return createGeminiApiUnderstandingProcessor(deps.fetchImpl ? { fetchImpl: deps.fetchImpl, apiKey } : { apiKey })
    }
    default:
      return null
  }
}
