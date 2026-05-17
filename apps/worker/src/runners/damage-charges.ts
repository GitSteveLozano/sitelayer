import type { Pool } from 'pg'
import { processDamageChargeInvoicePush } from '../damage-charge-push.js'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'

export function createDamageChargesRunner(deps: { pool: Pool }) {
  const { pool } = deps

  return async function drainDamageChargeInvoicePushes(companyId: string): Promise<AgentDrainSummary> {
    return drainAgentMutations<Record<string, unknown>>(
      pool,
      'damage_charge_invoice_push',
      companyId,
      'damage_charge_invoice_push',
      async (client, cid, payload) => {
        await processDamageChargeInvoicePush(
          client,
          cid,
          payload as Parameters<typeof processDamageChargeInvoicePush>[2],
        )
        return { insightsCreated: 0 }
      },
    )
  }
}
