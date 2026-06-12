// Async AI blueprint-capture runner. Drains `mutation_outbox` rows of
// mutation_type='takeoff_capture_pipeline' enqueued by
// POST /api/projects/:id/takeoff-drafts/capture (apps/api/src/routes/
// takeoff-drafts.ts) when a LIVE blueprint_vision run is requested.
//
// Before 2026-06-12 the route awaited the Gemini/Anthropic vision call INLINE
// in the node:http handler (and the env-gated Anthropic path was effectively
// unbounded — ~10-min SDK timeout × per-page loop). Worse, ANY provider error
// silently served the believable DEMO_ROWS EIFS stub labelled "dry-run", so an
// estimator could review and promote invented quantities. This runner is the
// honest replacement:
//
//   - executes the shared live pipeline (packages/pipe-blueprint/src/
//     live-capture.ts) off the HTTP request path;
//   - SUCCESS → draft.capture_status='ready' + takeoff_result_json +
//     capture_provenance ('gemini-live' | 'anthropic-live') + REAL provider
//     token usage (capture_token_usage + a company_usage_log row priced from
//     actual tokens — the flat $0.25/page fiction is retired);
//   - PROVIDER ERROR → draft.capture_status='failed' + capture_error, ZERO
//     fabricated quantity rows, and the outbox row completes (no retry loop:
//     the operator re-runs capture explicitly, creating a fresh draft).
//
// Payload (written by the route):
//   { draft_id, project_id, kind, provider: 'gemini'|'anthropic',
//     payload (original capture payload), storage_path, mime_type }
//
// Idempotency:
//   - outbox idempotency_key = `takeoff_capture:run:<draftId>` — replayed
//     enqueues collapse onto one row.
//   - the runner re-reads the draft in the drain tx; a draft already 'ready'
//     is SKIPPED (never re-billed / overwritten), a missing or deleted draft
//     completes with a warning.

import type { Pool, PoolClient } from 'pg'
import type { Logger } from '@sitelayer/logger'
import {
  estimateTakeoffCost,
  runLiveBlueprintCapture,
  type LiveBlueprintCaptureOutcome,
  type RunLiveBlueprintCaptureArgs,
} from '@sitelayer/pipe-blueprint'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'
import { captureWithEntityContext } from '../instrument.js'
import type { ObjectStorageClient } from './blueprint-storage-gc.js'

export interface TakeoffCapturePayload {
  draft_id?: string
  project_id?: string
  kind?: string
  provider?: string
  payload?: Record<string, unknown>
  storage_path?: string
  mime_type?: string
}

type DraftGuardRow = {
  id: string
  capture_status: string
  deleted_at: string | null
}

/** Cap stored error text so a provider HTML error page can't bloat the row. */
function truncateError(message: string): string {
  return message.length > 2000 ? `${message.slice(0, 2000)}…` : message
}

/**
 * Price the run from REAL token usage. Best-effort: an unknown model id (e.g.
 * a GEMINI_VISION_MODEL override newer than the pricing snapshot) yields null
 * rather than a made-up number — the token counts are still stored either way.
 */
export function priceFromUsage(usage: {
  provider: 'gemini' | 'anthropic'
  model: string
  input_tokens: number | null
  output_tokens: number | null
}): number | null {
  if (usage.input_tokens == null && usage.output_tokens == null) return null
  try {
    const estimate = estimateTakeoffCost({
      provider: usage.provider === 'gemini' ? 'gemini-api' : 'anthropic-api',
      model: usage.model,
      pages: [],
      promptTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    })
    return estimate.billedUsd
  } catch {
    return null
  }
}

export type TakeoffCaptureDeps = {
  pool: Pool
  storage: ObjectStorageClient | null
  logger: Logger
  /** Injectable for tests; defaults to the shared live pipeline. */
  runCapture?: (args: RunLiveBlueprintCaptureArgs) => Promise<LiveBlueprintCaptureOutcome>
}

/**
 * Build the takeoff_capture_pipeline runner — a drainAgentMutations wrapper
 * that validates the payload, loads the blueprint bytes from object storage,
 * executes the shared live pipeline, and transitions the draft to its
 * reviewable ('ready') or 'failed' state inside the drain's transaction.
 */
export function createTakeoffCaptureRunner(deps: TakeoffCaptureDeps) {
  const { pool, storage, logger, runCapture = runLiveBlueprintCapture } = deps

  return async function drainTakeoffCaptures(companyId: string): Promise<AgentDrainSummary> {
    return drainAgentMutations<TakeoffCapturePayload>(
      pool,
      'takeoff_capture_pipeline',
      companyId,
      'takeoff_capture_pipeline',
      async (client: PoolClient, cid: string, payload: TakeoffCapturePayload) => {
        const draftId = typeof payload?.draft_id === 'string' ? payload.draft_id : null
        if (!draftId) {
          throw new Error('takeoff_capture_pipeline payload missing draft_id')
        }

        // Re-read the draft in the drain's tx (RLS GUC already bound) and
        // lock it so a concurrent worker can't double-run the provider.
        const guard = await client.query<DraftGuardRow>(
          `select id, capture_status, deleted_at
             from takeoff_drafts
            where company_id = $1 and id = $2
            for update`,
          [cid, draftId],
        )
        const draft = guard.rows[0]
        if (!draft || draft.deleted_at) {
          logger.warn(
            { company_id: cid, draft_id: draftId, found: Boolean(draft) },
            '[takeoff-capture] draft missing or deleted — skipping run',
          )
          return { insightsCreated: 0 }
        }
        if (draft.capture_status === 'ready') {
          // Already completed (replayed outbox row) — never re-bill the
          // provider or overwrite a reviewed result.
          logger.info({ company_id: cid, draft_id: draftId }, '[takeoff-capture] draft already ready — skipping')
          return { insightsCreated: 0 }
        }

        const failDraft = async (message: string): Promise<{ insightsCreated: number }> => {
          await client.query(
            `update takeoff_drafts
               set capture_status = 'failed',
                   capture_error = $3,
                   capture_provenance = null,
                   version = version + 1,
                   updated_at = now()
             where company_id = $1 and id = $2`,
            [cid, draftId, truncateError(message)],
          )
          logger.error(
            { company_id: cid, draft_id: draftId, capture_error: truncateError(message) },
            '[takeoff-capture] live capture failed — draft marked failed (NO stub rows)',
          )
          return { insightsCreated: 0 }
        }

        const provider =
          payload.provider === 'anthropic' ? 'anthropic' : payload.provider === 'gemini' ? 'gemini' : null
        if (!provider) {
          return failDraft(`unsupported capture provider: ${String(payload.provider)}`)
        }
        const projectId = typeof payload.project_id === 'string' ? payload.project_id : null
        const storagePath = typeof payload.storage_path === 'string' ? payload.storage_path : null
        if (!projectId || !storagePath) {
          return failDraft('takeoff_capture_pipeline payload missing project_id or storage_path')
        }
        if (!storage) {
          return failDraft('worker object-storage backend not configured — cannot read blueprint bytes')
        }

        let bytes: Buffer
        try {
          bytes = await storage.get(storagePath)
        } catch (err) {
          return failDraft(
            `failed to read blueprint from storage (${storagePath}): ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        let outcome: LiveBlueprintCaptureOutcome
        try {
          outcome = await runCapture({
            provider,
            projectId,
            input: { bytes, mimeType: typeof payload.mime_type === 'string' ? payload.mime_type : 'application/pdf' },
            storagePath,
            payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
          })
        } catch (err) {
          // HONESTY CONTRACT: a provider error is a FAILED draft with the
          // error surfaced. It must never fall back to demo/stub quantities.
          captureWithEntityContext(err, {
            scope: 'takeoff_capture_pipeline',
            entity_type: 'takeoff_draft',
            company_id: cid,
            extra_tags: { draft_id: draftId, provider },
          })
          return failDraft(err instanceof Error ? err.message : String(err))
        }

        const reviewRequired = outcome.result.quantities.some((q) => q.confidence < 0.5)
        await client.query(
          `update takeoff_drafts
             set takeoff_result_json = $3::jsonb,
                 review_required = $4,
                 pipeline_version = $5,
                 capture_status = 'ready',
                 capture_provenance = $6,
                 capture_error = null,
                 capture_token_usage = $7::jsonb,
                 version = version + 1,
                 updated_at = now()
           where company_id = $1 and id = $2`,
          [
            cid,
            draftId,
            JSON.stringify(outcome.result),
            reviewRequired,
            outcome.pipelineVersion,
            outcome.provenance,
            JSON.stringify(outcome.usage),
          ],
        )

        // Cost attribution from REAL provider usage (Gemini usageMetadata /
        // Anthropic usage). billed_usd is null when the model id is missing
        // from the pricing snapshot — we store the truth (tokens) and decline
        // to invent dollars.
        const billedUsd = priceFromUsage(outcome.usage)
        await client.query(
          `insert into company_usage_log (
             company_id, operation, cost_usd, description, request_id, sentry_trace, metadata
           ) values ($1, $2, $3, $4, null, null, $5::jsonb)`,
          [
            cid,
            'blueprint_vision_capture',
            (billedUsd ?? 0).toFixed(6),
            `blueprint_vision:capture provider=${provider} model=${outcome.usage.model}`,
            JSON.stringify({
              estimation: 'provider_usage',
              provider,
              model: outcome.usage.model,
              input_tokens: outcome.usage.input_tokens,
              output_tokens: outcome.usage.output_tokens,
              billed_usd: billedUsd,
              pipeline_version: outcome.pipelineVersion,
              draft_id: draftId,
            }),
          ],
        )

        logger.info(
          {
            company_id: cid,
            draft_id: draftId,
            provider,
            provenance: outcome.provenance,
            quantities: outcome.result.quantities.length,
            review_required: reviewRequired,
            input_tokens: outcome.usage.input_tokens,
            output_tokens: outcome.usage.output_tokens,
            billed_usd: billedUsd,
          },
          '[takeoff-capture] live capture complete — draft ready',
        )
        return { insightsCreated: 1 }
      },
    )
  }
}
