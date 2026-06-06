import type { PoolClient } from 'pg'
import Anthropic from '@anthropic-ai/sdk'

/**
 * Phase 5: voice-to-log agent.
 *
 * The foreman dictates the day's narrative; the agent turns the
 * transcript into a structured daily-log narrative + suggested
 * weather / schedule_deviations field updates.
 *
 * Two modes (mirrors the blueprint-vision dispatcher gate):
 *   - "live"   ⇒ VOICE_TO_LOG_MODE=live AND ANTHROPIC_API_KEY set ⇒ call Claude.
 *   - dry-run  ⇒ anything else ⇒ deterministic summarization stub, no API key.
 * A live failure degrades to the deterministic draft (a reviewable draft
 * beats dead-lettering a foreman's end-of-day log on a transient hiccup).
 *
 * Hard rules from the AI Layer doc:
 *   - confidence is ordinal (low | med | high), never numeric
 *   - the proposal carries a sourced attribution
 *   - dismiss is signal — handled via the existing ai_insights apply
 *     / dismiss endpoints, not in this module
 */

export interface VoiceToLogPayload {
  daily_log_id: string
  transcript: string
  source?: 'voice' | 'text'
  requested_by?: string
}

export interface VoiceToLogProposal {
  narrative: string
  weather_summary: string | null
  schedule_deviations: string[]
  confidence: 'low' | 'med' | 'high'
  rationale: string
}

interface DailyLogRow {
  id: string
  project_id: string
  occurred_on: string
  status: string
}

// Haiku is the right tier for short-transcript summarization and keeps the
// dispatcher cost-cap rule honest. Override with VOICE_TO_LOG_MODEL.
const DEFAULT_VOICE_TO_LOG_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Resolve the voice-to-log mode from env. Read at call time (not module
 * init) so tests can flip env per case. Defaults to dry-run unless the
 * operator explicitly opts into live AND a key is present.
 */
export function resolveVoiceToLogMode(): 'live' | 'dry-run' {
  const mode = (process.env.VOICE_TO_LOG_MODE ?? 'dry-run').trim().toLowerCase()
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim())
  if (mode === 'live' && hasKey) return 'live'
  return 'dry-run'
}

/**
 * Deterministic summarization — runs without an API key. Confidence keys
 * off transcript length; weather + deviations off a small word list so the
 * demo path produces sensible-looking output.
 */
export function proposeNarrativeStub(transcript: string): VoiceToLogProposal {
  const cleaned = transcript.trim().replace(/\s+/g, ' ')
  // Confidence drops fast on short transcripts — nothing to work with under ~200 chars.
  let confidence: 'low' | 'med' | 'high' = 'high'
  if (cleaned.length < 200) confidence = 'low'
  else if (cleaned.length < 600) confidence = 'med'

  const weatherWords = ['rain', 'snow', 'sun', 'wind', 'cold', 'hot', 'humid', 'cloud']
  const weatherMentioned = weatherWords.find((w) => cleaned.toLowerCase().includes(w))
  const weatherSummary = weatherMentioned ? `Weather: ${weatherMentioned} (foreman dictation)` : null

  const deviationWords = ['delayed', 'missed', 'behind', 'ahead', 'early', 'late']
  const sentences = cleaned.split(/(?<=[.!?])\s+/)
  const deviations = sentences
    .filter((s) => deviationWords.some((d) => s.toLowerCase().includes(d)))
    .slice(0, 3)
    .map((s) => s.trim())

  return {
    narrative: cleaned,
    weather_summary: weatherSummary,
    schedule_deviations: deviations,
    confidence,
    rationale:
      confidence === 'high'
        ? 'Transcript is long enough for a confident narrative draft'
        : confidence === 'med'
          ? 'Short transcript; review the narrative carefully'
          : 'Very short transcript — narrative may be incomplete',
  }
}

/**
 * Coerce a model's (possibly loose) JSON into the strict proposal shape.
 * Never trusts the model for the enum or array types.
 */
export function normalizeProposal(raw: Partial<VoiceToLogProposal> | null, transcript: string): VoiceToLogProposal {
  const cleaned = transcript.trim().replace(/\s+/g, ' ')
  const confidence: VoiceToLogProposal['confidence'] =
    raw?.confidence === 'low' || raw?.confidence === 'med' || raw?.confidence === 'high' ? raw.confidence : 'med'
  const narrative = typeof raw?.narrative === 'string' && raw.narrative.trim() ? raw.narrative.trim() : cleaned
  const weather =
    typeof raw?.weather_summary === 'string' && raw.weather_summary.trim() ? raw.weather_summary.trim() : null
  const deviations = Array.isArray(raw?.schedule_deviations)
    ? raw.schedule_deviations
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .slice(0, 3)
        .map((d) => d.trim())
    : []
  const rationale =
    typeof raw?.rationale === 'string' && raw.rationale.trim() ? raw.rationale.trim() : 'Drafted by voice-to-log model'
  return { narrative, weather_summary: weather, schedule_deviations: deviations, confidence, rationale }
}

/** Tolerant strict-JSON parse (mirrors pipe-blueprint's parser). */
function parseJsonStrict<T>(text: string): T {
  let s = text.trim()
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence) s = fence[1]!.trim()
  if (!s.startsWith('{') && !s.startsWith('[')) {
    const obj = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)
    if (obj) s = obj[1]!
  }
  return JSON.parse(s) as T
}

/** Live Claude call. Text-only message → strict JSON → normalized proposal. */
async function proposeNarrativeLive(transcript: string, model: string): Promise<VoiceToLogProposal> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const prompt = `You are summarizing a construction foreman's end-of-day voice dictation into a structured daily-log entry.

Return ONLY a JSON object with this exact shape (no prose, no markdown fence):
{
  "narrative": string,             // 2-4 sentence clean summary of the day in the foreman's voice
  "weather_summary": string|null,  // short weather note if mentioned, else null
  "schedule_deviations": string[], // up to 3 short phrases for delays/missed/ahead/behind items, else []
  "confidence": "low"|"med"|"high",// your confidence given transcript length and clarity
  "rationale": string              // one sentence on why that confidence
}

Transcript:
"""
${transcript.trim()}
"""`
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = response.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  return normalizeProposal(parseJsonStrict<Partial<VoiceToLogProposal>>(text), transcript)
}

async function proposeNarrative(transcript: string): Promise<VoiceToLogProposal> {
  if (resolveVoiceToLogMode() === 'live') {
    try {
      return await proposeNarrativeLive(
        transcript,
        process.env.VOICE_TO_LOG_MODEL?.trim() || DEFAULT_VOICE_TO_LOG_MODEL,
      )
    } catch (err) {
      // Degrade gracefully — a deterministic draft is reviewable; a thrown
      // error would dead-letter the run after the drain's retry budget.
      console.warn('[voice-to-log] live inference failed; using deterministic draft', err)
      const stub = proposeNarrativeStub(transcript)
      return { ...stub, rationale: `${stub.rationale} (live model unavailable; deterministic fallback)` }
    }
  }
  return proposeNarrativeStub(transcript)
}

export async function processVoiceToLogRun(
  client: PoolClient,
  companyId: string,
  payload: VoiceToLogPayload,
): Promise<{ insightsCreated: number; proposal: VoiceToLogProposal | null }> {
  if (!payload?.daily_log_id || !payload?.transcript) {
    throw new Error('voice_to_log payload missing daily_log_id or transcript')
  }

  // Verify the daily log belongs to this company. The route check is
  // there but the worker re-validates: outbox rows can outlive their
  // referenced row if the foreman deleted the draft mid-flight.
  // Throw rather than silently succeed — the drain treats a thrown
  // error as 'failed' (with backoff up to 5 attempts) which keeps the
  // visibility into broken runs that "no insights produced" would lose.
  const log = await client.query<DailyLogRow>(
    `select id, project_id, occurred_on, status
     from daily_logs
     where company_id = $1 and id = $2`,
    [companyId, payload.daily_log_id],
  )
  if (!log.rows[0]) {
    throw new Error(`voice_to_log: daily_log ${payload.daily_log_id} not found for company`)
  }

  const proposal = await proposeNarrative(payload.transcript)

  await client.query(
    `insert into ai_insights
       (company_id, kind, entity_type, entity_id, payload, confidence,
        attribution, source_run_id, produced_by)
     values ($1, 'voice_to_log', 'daily_log', $2, $3::jsonb, $4, $5, $6, 'agent:voice_to_log')`,
    [
      companyId,
      payload.daily_log_id,
      JSON.stringify(proposal),
      proposal.confidence,
      `Drafted from ${payload.source ?? 'text'} transcript (${payload.transcript.length} chars)`,
      payload.requested_by ?? null,
    ],
  )

  return { insightsCreated: 1, proposal }
}
