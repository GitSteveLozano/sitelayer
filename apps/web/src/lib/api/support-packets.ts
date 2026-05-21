import { request } from './client'

export interface CreateSupportPacketInput {
  problem?: string | null
  client: unknown
}

export interface CreateSupportPacketResponse {
  support_id: string
  request_id: string | null
  expires_at: string
}

export function createSupportPacket(input: CreateSupportPacketInput): Promise<CreateSupportPacketResponse> {
  return request<CreateSupportPacketResponse>('/api/support-packets', {
    method: 'POST',
    json: input,
  })
}
