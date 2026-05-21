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
