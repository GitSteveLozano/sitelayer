import type { Pool } from 'pg'
import { processVoiceToLogRun, type VoiceToLogPayload } from '../voice-to-log-agent.js'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'

export function createVoiceToLogRunner(deps: { pool: Pool }) {
  const { pool } = deps

  return async function drainVoiceToLog(companyId: string): Promise<AgentDrainSummary> {
    return drainAgentMutations<VoiceToLogPayload>(pool, 'voice_to_log', companyId, 'voice_to_log', processVoiceToLogRun)
  }
}
