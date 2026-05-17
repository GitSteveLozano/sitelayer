import type { Pool } from 'pg'
import { drainCompanyCamPolls, type CompanyCamPollSummary } from '../companycam-poll.js'

export function createCompanyCamPollRunner(deps: { pool: Pool }) {
  const { pool } = deps

  return async function drain(companyId: string): Promise<CompanyCamPollSummary> {
    return drainCompanyCamPolls(pool, companyId)
  }
}
