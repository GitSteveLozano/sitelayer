import type { Pool } from 'pg'
import { processDamageChargeInvoicePush } from '../damage-charge-push.js'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'
import { resolveCompanyQboLive } from '../qbo-live.js'

export function createDamageChargesRunner(deps: { pool: Pool }) {
  const { pool } = deps

  return async function drainDamageChargeInvoicePushes(companyId: string): Promise<AgentDrainSummary> {
    // PER-COMPANY live gating (multi-tenant). QBO_LIVE_DAMAGE_INVOICE is now a
    // cluster-wide kill switch; resolve the live decision once per drain
    // (global-env-on AND integration_connections.qbo_live_enabled) and pass it
    // explicitly so processDamageChargeInvoicePush does NOT fall back to the
    // raw global env. DEFAULT is dry-run for every company.
    const live = await resolveCompanyQboLive(pool, companyId, 'QBO_LIVE_DAMAGE_INVOICE')
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
          { liveFlag: live },
        )
        return { insightsCreated: 0 }
      },
    )
  }
}
