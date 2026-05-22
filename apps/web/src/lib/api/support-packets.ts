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

export interface SupportPacketDetail {
  id: string
  company_id: string
  actor_user_id: string
  request_id: string | null
  route: string | null
  build_sha: string | null
  problem: string | null
  client: Record<string, unknown>
  server_context: Record<string, unknown>
  created_at: string
  expires_at: string | null
  redaction_version: string
}

export interface SupportPacketDetailResponse {
  support_packet: SupportPacketDetail
  agent_prompt: string
}

export function createSupportPacket(input: CreateSupportPacketInput): Promise<CreateSupportPacketResponse> {
  return request<CreateSupportPacketResponse>('/api/support-packets', {
    method: 'POST',
    json: input,
  })
}

export function fetchSupportPacket(id: string): Promise<SupportPacketDetailResponse> {
  return request<SupportPacketDetailResponse>(`/api/support-packets/${encodeURIComponent(id)}`)
}
