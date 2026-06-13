#!/usr/bin/env -S npx tsx
/**
 * simulate-takeoff.ts — one-command deterministic simulation of the HEAVY PILOT
 * LEG: "upload a blueprint → run the takeoff → see the takeoff + estimate
 * result." (Track B / B1 in
 * ~/notes/sitelayer-journeys-testing-simulation-plan-2026-06-13.md, gap SIM-1.)
 *
 * What it does, end-to-end, IN-PROCESS against a throwaway/dev DB (no running
 * HTTP server, no provider API key):
 *
 *   1. SEED  — reuse `seedScenario(scenarios/takeoff-canvas-states.yaml)` to
 *      stamp a fixture company + projects + REAL blueprint PDF bytes
 *      (`writeBlueprintSourceFiles` writes the actual PDF into the configured
 *      storage backend). Idempotent: re-running produces the same state.
 *   2. CAPTURE — call the DETERMINISTIC dry-run capture directly
 *      (`runDryRunCapture` from `@sitelayer/pipe-blueprint`, the same stub the
 *      synchronous capture endpoint persists, provenance `stub-dry-run`) and
 *      INSERT the resulting draft the way `POST /takeoff-drafts/capture` does.
 *   3. PROMOTE — run the REAL promote handler in-process
 *      (`handleTakeoffDraftRoutes`) so the stub's quantities become committed
 *      `takeoff_measurements`, mapping the demo rows onto the seeded company's
 *      curated catalog codes (EPS / Basecoat / Finish Coat) via
 *      `service_item_code_overrides` so the estimate prices to a real number.
 *   4. RECOMPUTE — `createEstimateFromMeasurements` rebuilds the draft's
 *      `estimate_lines` through the pricing chain.
 *   5. SCOPE-vs-BID — `getScopeVsBid` returns the bid/scope/delta comparison.
 *   6. EMIT — print ONE JSON result to stdout AND write it to a file:
 *      { project, takeoff:{quantities,provenance}, estimate:{lines,bid_total,
 *        scope_total}, scope_vs_bid:{delta} }.
 *
 * Determinism + idempotency: the seed is ON CONFLICT DO NOTHING + ref-hashed
 * UUIDs; the capture is the fixture-driven stub (no model call); promote/
 * recompute wipe+rebuild the draft's measurements/lines each run. Re-running
 * yields the same final state and the same emitted JSON (modulo the draft's
 * random takeoffId/producedAt, which the simulation pins).
 *
 * Refuses APP_TIER=prod (like seed-scenario) — scenarios are a dev/demo concept.
 *
 * Usage:
 *   DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer_dev \
 *     npm run sim:takeoff
 *   # optional: SIM_PROJECT_REF=manual SIM_OUT=/tmp/sim.json npm run sim:takeoff
 *
 * Exit codes: 0 success · 1 bad config / prod refusal · 2 DB / pipeline error.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { runDryRunCapture } from '@sitelayer/pipe-blueprint'
import type { TakeoffQuantity, TakeoffResult } from '@sitelayer/capture-schema'
import { loadAppConfig, TierConfigError, type AppTier } from '../apps/api/src/tier.js'
import { attachMutationTx, withCompanyClient, withMutationTx } from '../apps/api/src/mutation-tx.js'
import { handleTakeoffDraftRoutes, type TakeoffDraftRouteCtx } from '../apps/api/src/routes/takeoff-drafts.js'
import { createEstimateFromMeasurements, getScopeVsBid } from '../apps/api/src/routes/estimate.js'
import { seedScenario } from './seed-scenario.js'

// ---------- DB connection (mirrors seed-scenario's pool config) ----------

function getPoolConfig(connectionString: string, tier: AppTier) {
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
  try {
    const url = new URL(connectionString)
    const sslMode = url.searchParams.get('sslmode')
    if (!rejectUnauthorized && sslMode && sslMode !== 'disable') {
      url.searchParams.delete('sslmode')
      return {
        connectionString: url.toString(),
        ssl: { rejectUnauthorized: false },
        options: `-c app.tier=${tier}`,
      }
    }
  } catch {
    return { connectionString, options: `-c app.tier=${tier}` }
  }
  return { connectionString, options: `-c app.tier=${tier}` }
}

const SCENARIO_PATH = 'scenarios/takeoff-canvas-states.yaml'
/** The canvas scenario project to simulate against. `manual` ships a real
 *  calibrated PDF, a customer, and division D4 (EIFS) so the estimate prices. */
const DEFAULT_PROJECT_REF = process.env.SIM_PROJECT_REF ?? 'manual'

/**
 * Map the dry-run stub's quantities onto the seeded company's CURATED catalog
 * so the promoted measurements price to a real, deterministic number. The stub
 * emits MasterFormat/UniFormat-coded rows (e.g. `09 29 00`) that a fresh LA
 * Operations seed does not stock; without an override the promote path keeps
 * those codes and the estimate prices them at $0. The four EIFS demo rows map
 * naturally onto the D4 (EIFS) catalog items EPS / Basecoat / Finish Coat. We
 * map by row INDEX (the stub order is fixed): wall-EPS, basecoat, sealant,
 * openings → EPS, Basecoat, Finish Coat, Finish Coat. Codes that exist in the
 * seeded catalog under division D4 clear the same catalog gate
 * `takeoff-write.ts` enforces. Indices/codes are deterministic.
 */
const OVERRIDE_CODE_BY_INDEX: ReadonlyArray<string> = ['EPS', 'Basecoat', 'Finish Coat', 'Finish Coat']

// ---------- In-process route ctx shim (drives the real promote handler) ----------

interface CapturedResponse {
  status: number
  body: unknown
}

/**
 * Build a `TakeoffDraftRouteCtx` that drives the REAL handler in-process: no
 * HTTP, admin role always granted, JSON body provided directly, the response
 * captured into `captured`. `pool`/`company` are the live objects the handler's
 * DB calls use; `withCompanyClient`/`withMutationTx` are already wired via
 * `attachMutationTx`.
 */
function buildRouteCtx(
  pool: Pool,
  companyId: string,
  body: Record<string, unknown>,
  captured: CapturedResponse,
): TakeoffDraftRouteCtx {
  return {
    pool,
    company: {
      id: companyId,
      slug: 'sim',
      name: 'sim',
      created_at: new Date(0).toISOString(),
      role: 'admin',
    } as TakeoffDraftRouteCtx['company'],
    requireRole: () => true,
    readBody: async () => body,
    sendJson: (status, responseBody) => {
      captured.status = status
      captured.body = responseBody
    },
    currentUserId: 'sim-takeoff',
  }
}

// ---------- Capture-draft insert (mirrors the synchronous capture endpoint) ----------

/**
 * Persist the dry-run `TakeoffResult` as a `blueprint_vision` review draft, the
 * same way `POST /takeoff-drafts/capture` does on its synchronous path (status
 * 'ready', provenance 'stub-dry-run'). Returns the new draft id. Idempotent per
 * project: the simulation deletes any prior sim draft first so re-runs don't
 * accrete drafts.
 */
async function insertCaptureDraft(
  companyId: string,
  projectId: string,
  result: TakeoffResult,
  pipelineVersion: string,
  provenance: string,
): Promise<string> {
  const reviewRequired = result.quantities.some((qty) => qty.confidence < 0.5)
  return withMutationTx(companyId, async (client) => {
    // Idempotency: drop the prior sim-tagged draft for this project so a re-run
    // starts clean (and its measurements cascade via draft_id ON DELETE).
    await client.query(
      `update takeoff_drafts set deleted_at = now()
        where company_id = $1 and project_id = $2 and name = $3 and deleted_at is null`,
      [companyId, projectId, 'simulate-takeoff capture'],
    )
    const inserted = await client.query<{ id: string }>(
      `insert into takeoff_drafts (
          company_id, project_id, name, type, kind, status,
          source, takeoff_result_json, review_required, pipeline_version,
          capture_status, capture_provenance
        )
        values ($1, $2, $3, 'measurement', 'takeoff', 'active',
                'blueprint_vision', $4::jsonb, $5, $6, 'ready', $7)
        returning id`,
      [
        companyId,
        projectId,
        'simulate-takeoff capture',
        JSON.stringify(result),
        reviewRequired,
        pipelineVersion,
        provenance,
      ],
    )
    const id = inserted.rows[0]?.id
    if (!id) throw new Error('failed to insert capture draft')
    return id
  })
}

// ---------- Main ----------

interface SimResult {
  project: { id: string; name: string; ref: string }
  takeoff: {
    quantities: Array<{ id: string; description: string; value: number; unit: string; confidence: number }>
    provenance: string
    draft_id: string
    pipeline_version: string
    promoted_count: number
    skipped_count: number
  }
  estimate: {
    lines: Array<{ service_item_code: string; quantity: number; unit: string; rate: number; amount: number }>
    bid_total: number
    scope_total: number
  }
  scope_vs_bid: {
    delta: number
    bid_total: number
    scope_total: number
    status?: string
  }
}

async function simulate(): Promise<SimResult> {
  const config = loadAppConfig()
  if (config.tier === 'prod') {
    throw new TierConfigError('simulate-takeoff refuses to run when APP_TIER=prod')
  }

  // 1. SEED — reuse the scenario CLI to stamp company + projects + real PDF
  //    bytes. Idempotent (ON CONFLICT DO NOTHING). seedScenario opens + closes
  //    its own pool.
  const summary = await seedScenario(path.resolve(SCENARIO_PATH))
  const companyId = summary.company_id
  const projectEntry = summary.projects.find((p) => p.ref === DEFAULT_PROJECT_REF)
  if (!projectEntry) {
    throw new Error(
      `scenario did not seed project ref "${DEFAULT_PROJECT_REF}" (have: ${summary.projects.map((p) => p.ref).join(', ')})`,
    )
  }
  const projectId = projectEntry.id

  // Our own pool for the in-process API calls (estimate recompute / scope-vs-bid
  // / promote all read it via attachMutationTx).
  const pool = new Pool(getPoolConfig(config.databaseUrl, config.tier))
  const logger = createLogger('simulate-takeoff')
  attachMutationTx({ pool, logger })

  try {
    const projectName =
      (
        await withCompanyClient(companyId, (c) =>
          c.query<{ name: string }>('select name from projects where company_id = $1 and id = $2', [
            companyId,
            projectId,
          ]),
        )
      ).rows[0]?.name ?? DEFAULT_PROJECT_REF

    // 2. CAPTURE — deterministic dry-run, in-process (no server, no key). This is
    //    the SAME TakeoffResult the synchronous capture endpoint persists.
    const capture = await runDryRunCapture(projectId, { stableIds: true })
    const draftId = await insertCaptureDraft(
      companyId,
      projectId,
      capture.result,
      capture.pipelineVersion,
      capture.provenance,
    )

    // 3. PROMOTE — drive the REAL promote handler in-process. Map every stub
    //    quantity onto a curated catalog code by index so the measurements price.
    const quantityIds = capture.result.quantities.map((qty: TakeoffQuantity) => qty.id)
    const overrides: Record<string, string> = {}
    capture.result.quantities.forEach((qty: TakeoffQuantity, i: number) => {
      const code = OVERRIDE_CODE_BY_INDEX[i] ?? OVERRIDE_CODE_BY_INDEX[OVERRIDE_CODE_BY_INDEX.length - 1]!
      overrides[qty.id] = code
    })
    const promoteResponse: CapturedResponse = { status: 0, body: null }
    const promoteCtx = buildRouteCtx(
      pool,
      companyId,
      { quantity_ids: quantityIds, service_item_code_overrides: overrides },
      promoteResponse,
    )
    const promoteUrl = new URL(`http://sim/api/projects/${projectId}/takeoff-drafts/${draftId}/promote`)
    const handled = await handleTakeoffDraftRoutes(
      { method: 'POST', url: promoteUrl.pathname } as never,
      promoteUrl,
      promoteCtx,
    )
    if (!handled || promoteResponse.status >= 400) {
      throw new Error(`promote failed (status ${promoteResponse.status}): ${JSON.stringify(promoteResponse.body)}`)
    }
    const promoteBody = promoteResponse.body as { promoted_count?: number; skipped_count?: number }

    // 4. RECOMPUTE — rebuild this draft's estimate_lines through the pricing chain.
    const estimate = await withMutationTx(companyId, async (client) =>
      createEstimateFromMeasurements(pool, companyId, projectId, { draftId, executor: client }),
    )
    if (!estimate) throw new Error('estimate recompute returned null (project not found)')

    // 5. SCOPE-vs-BID.
    const scope = await getScopeVsBid(pool, companyId, projectId, { draftId })
    if (!scope) throw new Error('scope-vs-bid returned null (project not found)')

    const bidTotal = round2(Number(estimate.bidTotal))
    const scopeTotal = round2(Number(estimate.scopeTotal))
    // compareBidVsScope (delta = bid - scope) feeds the scope object; surface it
    // directly so the consumer doesn't have to know the field name.
    const delta = round2(Number((scope as { delta?: unknown }).delta ?? bidTotal - scopeTotal))

    return {
      project: { id: projectId, name: projectName, ref: DEFAULT_PROJECT_REF },
      takeoff: {
        quantities: capture.result.quantities.map((qty: TakeoffQuantity) => ({
          id: qty.id,
          description: qty.description,
          value: qty.value,
          unit: qty.unit,
          confidence: qty.confidence,
        })),
        provenance: capture.provenance,
        draft_id: draftId,
        pipeline_version: capture.pipelineVersion,
        promoted_count: promoteBody.promoted_count ?? 0,
        skipped_count: promoteBody.skipped_count ?? 0,
      },
      estimate: {
        lines: estimate.lines.map((line) => ({
          service_item_code: line.service_item_code,
          quantity: round2(Number(line.quantity)),
          unit: line.unit,
          rate: round2(Number(line.rate)),
          amount: round2(Number(line.amount)),
        })),
        bid_total: bidTotal,
        scope_total: scopeTotal,
      },
      scope_vs_bid: {
        delta,
        bid_total: bidTotal,
        scope_total: scopeTotal,
        ...(typeof (scope as { status?: unknown }).status === 'string'
          ? { status: (scope as { status: string }).status }
          : {}),
      },
    }
  } finally {
    await pool.end()
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('simulate-takeoff.ts')
if (isMain) {
  simulate()
    .then((result) => {
      const outPath = path.resolve(process.env.SIM_OUT ?? 'simulate-takeoff.result.json')
      mkdirSync(path.dirname(outPath), { recursive: true })
      const json = JSON.stringify(result, null, 2)
      writeFileSync(outPath, json + '\n')
      process.stderr.write(`[simulate-takeoff] wrote result → ${outPath}\n`)
      process.stdout.write(json + '\n')
      process.exit(0)
    })
    .catch((err) => {
      if (err instanceof TierConfigError) {
        process.stderr.write(`[simulate-takeoff] config error: ${err.message}\n`)
        process.exit(1)
      }
      process.stderr.write(
        `[simulate-takeoff] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      )
      process.exit(2)
    })
}

export { simulate, type SimResult }
