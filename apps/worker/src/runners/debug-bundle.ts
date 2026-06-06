import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { processAssembleDebugBundle, type DebugBundleSummary } from '@sitelayer/queue'

// ---------------------------------------------------------------------------
// Debug-bundle enrichment runner — tier-2 of issue-context.
//
// Mirrors runners/rental-invoice-push.ts (claim → per-row work → mark applied),
// minus the QBO circuit/live-stub selection: there is no external write here,
// only env-gated READ pulls from Sentry + Axiom that the pusher already guards
// (8s timeout, silent no-op when the creds are unset). The pusher owns the
// claim SQL + idempotent capture_artifact upsert; this runner is the per-drain
// connection + error boundary the worker.ts heartbeat wraps in
// runIfLaneActive('debug_bundle', ...).
// ---------------------------------------------------------------------------

export function createDebugBundleRunner(deps: { pool: Pool; logger: Logger }) {
  const { pool, logger } = deps

  if (!process.env.SENTRY_AUTH_TOKEN || !process.env.SENTRY_ORG) {
    logger.info('[debug-bundle] SENTRY_ORG/SENTRY_AUTH_TOKEN unset — Sentry enrichment runs as a silent no-op')
  }
  if (!process.env.AXIOM_TOKEN || !process.env.AXIOM_DATASET) {
    logger.info('[debug-bundle] AXIOM_TOKEN/AXIOM_DATASET unset — Axiom enrichment runs as a silent no-op')
  }

  return async function drainDebugBundles(companyId: string): Promise<DebugBundleSummary> {
    const client = await pool.connect()
    try {
      return await processAssembleDebugBundle(client, companyId, 5)
    } finally {
      client.release()
    }
  }
}
