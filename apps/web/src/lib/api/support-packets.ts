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

export interface SupportPacketAccessLogEntry {
  id: string
  support_packet_id: string
  actor_user_id: string
  access_type: 'read' | 'list' | 'agent_prompt' | 'export'
  route: string | null
  request_id: string | null
  created_at: string
  metadata: Record<string, unknown>
}

export interface SupportPacketAccessLogResponse {
  access_log: SupportPacketAccessLogEntry[]
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

export function fetchSupportPacketAccessLog(id: string): Promise<SupportPacketAccessLogResponse> {
  return request<SupportPacketAccessLogResponse>(`/api/support-packets/${encodeURIComponent(id)}/access-log`)
}
