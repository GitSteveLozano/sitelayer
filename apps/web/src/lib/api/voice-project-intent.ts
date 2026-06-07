import { request } from './client'

/**
 * Voice-driven project setup (v1) — client wrappers.
 *
 * Voice PROPOSES proposed project fields; the human CONFIRMS via the regular
 * POST /api/projects. These wrappers only stage a transcript and poll for the
 * parsed fields — they NEVER create a project.
 *
 * The feature is gated by the same `ai_chat_enabled` flag the operator-context
 * chat reads (the parse path is the same mesh hand-off), so callers reuse
 * `useAiChatEnabled()` from operator-context-chat.ts for the visibility gate.
 */

/** Shape returned once the parse lands (mirrors the API's ProposedProjectFields). */
export interface ProposedProjectFields {
  name: string | null
  customer: { match: 'existing' | 'new'; name: string | null }
  divisions: string[]
  division_code: string | null
}

export type StageVoiceIntentResponse =
  | {
      status: 'staged'
      voice_intent_id: string
      response_pending: boolean
      mesh_task_id: string | null
      dispatch_error: string | null
      followup_hint: string
    }
  | {
      // Returned (HTTP 200) when voice setup is not configured (no mesh access).
      // The server stages nothing; the web hides the mic / surfaces nothing.
      status: 'disabled'
      ai_chat_enabled: false
      reason: string
    }

export function stageVoiceProjectIntent(transcript: string): Promise<StageVoiceIntentResponse> {
  return request('/api/projects/voice-intent', {
    method: 'POST',
    json: { transcript },
  })
}

export type FetchVoiceIntentResult =
  | {
      status: 'pending'
      voice_intent_id: string
      response_pending: true
      followup_hint?: string
    }
  | {
      status: 'parsed'
      voice_intent_id: string
      parse_audit_event_id: string
      proposed: ProposedProjectFields | null
      created_at: string
    }

export function fetchVoiceProjectIntent(voiceIntentId: string): Promise<FetchVoiceIntentResult> {
  return request(`/api/projects/voice-intent/${encodeURIComponent(voiceIntentId)}`, {
    method: 'GET',
  })
}

/**
 * Stage a transcript, then poll until the parse lands (or the deadline/abort).
 * Returns the proposed fields on success, or null when the parse didn't land in
 * time / the signal aborted / the feature is disabled. Never throws on the
 * disabled path — the caller treats null as "no proposal".
 */
export async function resolveVoiceProjectIntent(
  transcript: string,
  opts: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<ProposedProjectFields | null> {
  const pollIntervalMs = opts.pollIntervalMs ?? 1500
  const timeoutMs = opts.timeoutMs ?? 45_000
  const staged = await stageVoiceProjectIntent(transcript)
  if (staged.status === 'disabled') return null

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return null
    await delay(pollIntervalMs, opts.signal)
    if (opts.signal?.aborted) return null
    const result = await fetchVoiceProjectIntent(staged.voice_intent_id)
    if (result.status === 'parsed') return result.proposed
  }
  return null
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
