import type { Pool } from 'pg'
import { processTakeoffToBidRun, type TakeoffToBidPayload } from '../takeoff-to-bid-agent.js'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'

export function createTakeoffToBidRunner(deps: { pool: Pool }) {
  const { pool } = deps

  return async function drainTakeoffToBid(companyId: string): Promise<AgentDrainSummary> {
    return drainAgentMutations<TakeoffToBidPayload>(
      pool,
      'takeoff_to_bid',
      companyId,
      'takeoff_to_bid',
      processTakeoffToBidRun,
    )
  }
}
