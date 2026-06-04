// MediaProcessor — the swappable seam that turns captured media (sampled
// video frames + audio transcript + context) into a structured
// *understanding* (summary, suggested title/severity, action items) that
// enriches a context_work_item.
//
// Decoupling axis (`~/notes/OPERATOR-INTENT.md`): the understanding is produced
// inside Sitelayer (company-scoped, behind RLS); the engine that produces it is
// a swappable adapter behind this interface, never baked into mesh. mesh stays a
// subscriber. Swapping the adapter must not change the issue/timeline shapes —
// the One-Line Boundary Test for this feature.
//
// Cost posture (`~/CLAUDE.md` rules 3/4/7): the default engine is the Gemini CLI
// which rides the operator's subscription ($0); the cash Gemini API path is
// opt-in behind an explicit enable flag + key. The deterministic stub keeps the
// pipeline inert/testable when nothing is configured.

export const MEDIA_UNDERSTANDING_SEVERITIES = ['low', 'normal', 'high', 'urgent'] as const
export type MediaUnderstandingSeverity = (typeof MEDIA_UNDERSTANDING_SEVERITIES)[number]

export type MediaUnderstandFrame = {
  index: number
  time_seconds: number
  content_type: string
  bytes: Buffer
}

export type MediaUnderstandInput = {
  // Sampled video frames (JPEG/PNG buffers). Empty for audio-only input.
  frames?: MediaUnderstandFrame[]
  // Audio/voice transcript text, when available.
  transcript?: string | null
  context: {
    kind: string
    title?: string | null
    summary?: string | null
    route?: string | null
    capture_session_id?: string | null
  }
}

export type MediaUnderstanding = {
  analyzer: string
  summary: string
  suggested_title: string | null
  suggested_severity: MediaUnderstandingSeverity | null
  action_items: string[]
  confidence: number | null
}

export interface MediaProcessor {
  readonly analyzer: string
  understand(input: MediaUnderstandInput): Promise<MediaUnderstanding>
}

export type MediaUnderstandMode = 'off' | 'gemini-cli' | 'gemini-api' | 'stub'

const MEDIA_UNDERSTAND_MODES: readonly MediaUnderstandMode[] = ['off', 'gemini-cli', 'gemini-api', 'stub']

export function resolveMediaUnderstandMode(raw?: string | null): MediaUnderstandMode {
  const normalized = raw?.trim().toLowerCase()
  // Back-compat aliases so the video-analysis mode value ('gemini') maps to the
  // subscription-first CLI engine by default.
  if (normalized === 'gemini') return 'gemini-cli'
  if (normalized && (MEDIA_UNDERSTAND_MODES as readonly string[]).includes(normalized)) {
    return normalized as MediaUnderstandMode
  }
  return 'off'
}

// The strict JSON contract we ask the model to satisfy. Kept here so both the
// CLI and API adapters request the same shape and share one parser.
export const MEDIA_UNDERSTANDING_PROMPT = [
  'You are triaging a captured product-feedback session for a construction-operations app.',
  'You are given sampled screen-recording frames and/or a voice transcript plus light context.',
  'Return ONLY a single minified JSON object, no prose, no code fences, matching exactly:',
  '{"summary": string, "suggested_title": string, "suggested_severity": "low"|"normal"|"high"|"urgent", "action_items": string[], "confidence": number}',
  '- summary: 1-3 sentences describing what the user was doing and what went wrong or was requested.',
  '- suggested_title: <= 80 chars, imperative, suitable as an issue title.',
  '- suggested_severity: how urgent the issue is for the user.',
  '- action_items: concrete next steps an engineer/triager should take (0-5 items).',
  '- confidence: your confidence in this reading, 0.0 to 1.0.',
].join('\n')

export function buildMediaUnderstandingPrompt(input: MediaUnderstandInput): string {
  const ctx = input.context
  const lines = [MEDIA_UNDERSTANDING_PROMPT, '', 'Context:']
  if (ctx.title) lines.push(`- title: ${ctx.title}`)
  if (ctx.summary) lines.push(`- summary: ${ctx.summary}`)
  if (ctx.route) lines.push(`- route: ${ctx.route}`)
  lines.push(`- artifact_kind: ${ctx.kind}`)
  if (input.frames?.length) lines.push(`- video_frames_attached: ${input.frames.length}`)
  if (input.transcript && input.transcript.trim()) {
    // Bound the transcript so a long recording can't blow the prompt budget.
    lines.push('', 'Transcript:', input.transcript.trim().slice(0, 8000))
  }
  return lines.join('\n')
}

// Tolerant extraction: models sometimes wrap JSON in prose or code fences even
// when told not to. Pull the first balanced {...} object and parse it; on
// failure fall back to treating the whole text as the summary so the pipeline
// still records *something* rather than dropping the analysis.
export function parseMediaUnderstanding(raw: string, analyzer: string): MediaUnderstanding {
  const fallback = (summary: string): MediaUnderstanding => ({
    analyzer,
    summary: summary.replace(/\s+/g, ' ').trim().slice(0, 2000) || 'Media understanding produced no usable output.',
    suggested_title: null,
    suggested_severity: null,
    action_items: [],
    confidence: null,
  })
  const jsonText = extractFirstJsonObject(raw)
  if (!jsonText) return fallback(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return fallback(raw)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback(raw)
  const record = parsed as Record<string, unknown>
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  return {
    analyzer,
    summary: summary.slice(0, 2000) || fallback(raw).summary,
    suggested_title: cleanTitle(record.suggested_title),
    suggested_severity: cleanSeverity(record.suggested_severity),
    action_items: cleanActionItems(record.action_items),
    confidence: cleanConfidence(record.confidence),
  }
}

function extractFirstJsonObject(raw: string): string | null {
  const text = raw ?? ''
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function cleanTitle(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null
}

function cleanSeverity(value: unknown): MediaUnderstandingSeverity | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return (MEDIA_UNDERSTANDING_SEVERITIES as readonly string[]).includes(normalized)
    ? (normalized as MediaUnderstandingSeverity)
    : null
}

function cleanActionItems(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 280))
    .slice(0, 5)
}

function cleanConfidence(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return null
  return Math.min(1, Math.max(0, parsed))
}

// Deterministic, dependency-free understanding. Used in 'stub' mode and as the
// default test double. It never calls an external engine, so it is safe to run
// anywhere and produces stable output for a given input.
export function createStubUnderstandingProcessor(): MediaProcessor {
  return {
    analyzer: 'media-understanding-stub-v1',
    async understand(input: MediaUnderstandInput): Promise<MediaUnderstanding> {
      const transcript = input.transcript?.replace(/\s+/g, ' ').trim() ?? ''
      const frameCount = input.frames?.length ?? 0
      const pieces: string[] = []
      if (frameCount) pieces.push(`${frameCount} sampled frame(s)`)
      if (transcript) pieces.push(`${transcript.split(/\s+/).length} transcript word(s)`)
      const summary = transcript
        ? transcript.slice(0, 280)
        : `Captured ${input.context.kind} artifact with ${pieces.join(' and ') || 'no analyzable media'}.`
      return {
        analyzer: 'media-understanding-stub-v1',
        summary,
        suggested_title: input.context.title?.trim()?.slice(0, 80) ?? null,
        suggested_severity: null,
        action_items: [],
        confidence: null,
      }
    },
  }
}
