import type { OperatorContextPacket } from '@/lib/operator-context'
import { request } from './client'

export type OperatorContextChatMessage = {
  id: string
  role: 'operator' | 'agent'
  body: string
  packet_generated_at?: string
}

export type StageOperatorContextChatResponse = {
  status: 'staged'
  audit_event_id: string
  response_pending: boolean
  followup_hint: string
}

export type StageOperatorContextChatInput = {
  messages: OperatorContextChatMessage[]
  operatorContext: OperatorContextPacket
}

export function stageOperatorContextChatMessage(
  input: StageOperatorContextChatInput,
): Promise<StageOperatorContextChatResponse> {
  return request('/api/ai/chat', {
    method: 'POST',
    json: {
      messages: input.messages,
      operatorContext: input.operatorContext,
    },
  })
}

/**
 * Shape of the polling endpoint that the chat-widget machine consumes
 * during the awaitingResponse state. Returns 202 with status='staged'
 * while the response is pending, 200 with status='responded' once the
 * subscription-CLI runner has written the respond_message audit row
 * back via the webhook.
 */
export type FetchOperatorContextChatResponseResult =
  | {
      status: 'staged'
      response_pending: true
      audit_event_id: string
      followup_hint?: string
    }
  | {
      status: 'responded'
      audit_event_id: string
      response_audit_event_id: string
      body: string | null
      created_at: string
      raw?: Record<string, unknown>
    }

export async function fetchOperatorContextChatResponse(
  auditEventId: string,
): Promise<FetchOperatorContextChatResponseResult> {
  return request(`/api/ai/chat/${encodeURIComponent(auditEventId)}/response`, {
    method: 'GET',
  })
}
