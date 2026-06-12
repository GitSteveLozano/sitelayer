/**
 * Thin wrapper around `@anthropic-ai/sdk`. Two responsibilities:
 *   - send a PDF as a `document` content block + a text prompt
 *   - parse the strict-JSON text response back into an object
 *
 * Kept narrow so tests can mock either the SDK or this wrapper.
 */
import Anthropic from '@anthropic-ai/sdk'

export interface CallClaudePdfOptions {
  client: Anthropic
  model: string
  pdfBase64: string
  prompt: string
  maxTokens?: number
  cacheDocument?: boolean
  /** Receives the REAL token usage off the Anthropic response (response.usage)
   *  for each call, so callers can persist actual spend instead of inventing a
   *  flat per-page estimate. Optional + non-throwing: usage accounting must
   *  never fail the extraction itself. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
}

export async function callClaudePdfJson<T = unknown>(opts: CallClaudePdfOptions): Promise<T> {
  const { client, model, pdfBase64, prompt, maxTokens = 4096 } = opts

  const documentBlock: Record<string, unknown> = {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: pdfBase64,
    },
  }
  if (opts.cacheDocument) {
    documentBlock.cache_control = { type: 'ephemeral' }
  }

  // We cast the content array because the SDK's strict types lag
  // behind the platform's `document` block. The runtime accepts it.
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [documentBlock, { type: 'text', text: prompt }] as unknown as Array<never>,
      },
    ],
  })

  if (opts.onUsage) {
    try {
      opts.onUsage({
        inputTokens: typeof response.usage?.input_tokens === 'number' ? response.usage.input_tokens : 0,
        outputTokens: typeof response.usage?.output_tokens === 'number' ? response.usage.output_tokens : 0,
      })
    } catch {
      // usage accounting must never fail the extraction
    }
  }

  // Concatenate all `text` blocks from the response and parse as JSON.
  // Anthropic responses can include multiple content blocks.
  const text = response.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()

  return parseJsonStrict<T>(text)
}

/**
 * Parse strict-JSON model output. Tolerates a stray markdown fence
 * (\`\`\`json … \`\`\`) since the model occasionally adds one despite
 * the prompt forbidding it.
 */
export function parseJsonStrict<T>(text: string): T {
  let s = text.trim()
  // Strip ```json fences if present
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence) s = fence[1]!.trim()

  // If the response starts with prose, attempt to grab the first JSON object.
  if (!s.startsWith('{') && !s.startsWith('[')) {
    const obj = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)
    if (obj) s = obj[1]!
  }

  return JSON.parse(s) as T
}
