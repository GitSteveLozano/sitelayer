import type { PoolClient } from 'pg'

/**
 * Phase 5: voice-to-log agent.
 *
 * The foreman dictates the day's narrative; the agent turns the
 * transcript into a structured daily-log narrative + suggested
 * scope_progress / weather / schedule_deviations field updates. The
 * actual LLM call is stubbed (deterministic summarization based on
 * length and keyword presence) so the pipeline runs without an API
 * key. Swap in the Anthropic SDK at `proposeNarrative` when the key
 * lands; the surrounding outbox plumbing stays put.
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

/**
 * Stub LLM proposal — deterministic summarization. Replace with
 * Anthropic SDK call to keep the same return shape.
 */
async function proposeNarrative(transcript: string): Promise<VoiceToLogProposal> {
  const cleaned = transcript.trim().replace(/\s+/g, ' ')
  // Confidence drops fast on short transcripts — the model has nothing
  // to work with under ~200 chars.
  let confidence: 'low' | 'med' | 'high' = 'high'
  if (cleaned.length < 200) confidence = 'low'
  else if (cleaned.length < 600) confidence = 'med'

  // Pull weather hints out of the transcript. Real model would handle
  // many phrasings; the stub keys off a small word list so the demo
  // path produces sensible-looking output.
  const weatherWords = ['rain', 'snow', 'sun', 'wind', 'cold', 'hot', 'humid', 'cloud']
  const weatherMentioned = weatherWords.find((w) => cleaned.toLowerCase().includes(w))
  const weatherSummary = weatherMentioned
    ? `Weather: ${weatherMentioned} (foreman dictation)`
    : null

  // Schedule deviations heuristic: any sentence starting with
  // "delayed", "missed", "behind", "ahead", "early".
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
