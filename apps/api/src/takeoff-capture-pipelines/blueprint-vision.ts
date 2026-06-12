import {
  PIPELINE_VERSION as BLUEPRINT_PIPELINE_VERSION,
  buildDryRunSkeleton,
  relabelQuantities,
} from '@sitelayer/pipe-blueprint'
import { applyReviewFloor, type TakeoffResult } from '@sitelayer/capture-schema'

// ─── ASYNC SPLIT (2026-06-12) ───────────────────────────────────────────────
// This module is now the SYNCHRONOUS half of blueprint_vision capture only:
// the deterministic dry-run stub + per-symbol count dry-run, which demo/e2e
// fixtures depend on. The LIVE Gemini/Anthropic pipeline no longer runs in the
// HTTP handler at all — POST /capture enqueues a 'takeoff_capture_pipeline'
// outbox row and the worker runner (apps/worker/src/runners/takeoff-capture.ts)
// executes the shared implementation in
// packages/pipe-blueprint/src/live-capture.ts.
//
// HONESTY CONTRACT: the old error→DEMO_ROWS fallback is GONE. The demo rows
// below are only ever served with provenance 'stub-dry-run'; a failed live
// provider call becomes a FAILED draft (capture_error set), never believable
// fake quantities.

// ─── Per-symbol count scope (M1) ────────────────────────────────────────────
// The desktop/mobile AI auto-count setup screens let the estimator pick a
// symbol, a match sensitivity (STRICT/NORMAL/LOOSE), and which sheets to scan.
// Those controls used to be presentational — they never reached the pipeline,
// so tapping one outlet symbol returned a WHOLE-DRAFT result. This slice threads
// the scope into the capture payload (`payload.count_scope`) and honors it here:
// when a symbol is chosen, the dry-run returns a single per-symbol quantity
// (unit `ea`, value = instance count) scoped to the selected sheets at the
// chosen sensitivity, plus one marker coordinate per detected instance.
//
// FOLLOW-UP (flagged in the PR): the LIVE single-symbol vision detector. This
// path is deterministic dry-run only — wiring the live Claude/Gemini call to
// read the chosen sheets and detect just the tapped symbol is a separate slice.

export type CountSensitivity = 'STRICT' | 'NORMAL' | 'LOOSE'

export interface CountScope {
  /** The tapped symbol to count. `label` drives the quantity description. */
  symbol: { label: string; sheet?: string }
  /** Sheet codes to scan (e.g. ['M-101','M-102']). Empty ⇒ all in-scope sheets. */
  sheets: string[]
  /** Match sensitivity — scales the per-sheet hit rate in the dry-run. */
  sensitivity: CountSensitivity
}

const COUNT_SENSITIVITIES = new Set<CountSensitivity>(['STRICT', 'NORMAL', 'LOOSE'])

/**
 * Parse a `count_scope` object off the capture payload. Returns null when it is
 * absent or malformed (no symbol label) — the caller then falls back to the
 * existing whole-draft path, so a missing/garbage scope can never break capture.
 */
export function parseCountScope(payload: Record<string, unknown>): CountScope | null {
  const raw = payload.count_scope
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  const symbolRaw = obj.symbol
  if (!symbolRaw || typeof symbolRaw !== 'object' || Array.isArray(symbolRaw)) return null
  const symbolObj = symbolRaw as Record<string, unknown>
  const label = typeof symbolObj.label === 'string' ? symbolObj.label.trim() : ''
  if (!label) return null
  const symbolSheet = typeof symbolObj.sheet === 'string' ? symbolObj.sheet.trim() : ''

  const sheets = Array.isArray(obj.sheets)
    ? obj.sheets.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
    : []

  const sensitivityRaw = typeof obj.sensitivity === 'string' ? obj.sensitivity.trim().toUpperCase() : ''
  const sensitivity: CountSensitivity = COUNT_SENSITIVITIES.has(sensitivityRaw as CountSensitivity)
    ? (sensitivityRaw as CountSensitivity)
    : 'NORMAL'

  return { symbol: symbolSheet ? { label, sheet: symbolSheet } : { label }, sheets, sensitivity }
}

// Deterministic per-sheet instance counts by sensitivity. STRICT keeps only
// high-confidence hits (fewer), LOOSE casts the widest net (more), NORMAL sits
// between. Purely a believable demo distribution — never a real detector.
const SENSITIVITY_HITS_PER_SHEET: Record<CountSensitivity, number> = { STRICT: 3, NORMAL: 5, LOOSE: 7 }

// Marker confidence band by sensitivity — STRICT marks are crisper (higher
// confidence), LOOSE marks include more edge cases (lower confidence) so the
// review lane has flags to clear. Mirrors the on-screen STRICT/NORMAL/LOOSE copy.
const SENSITIVITY_BASE_CONFIDENCE: Record<CountSensitivity, number> = { STRICT: 0.92, NORMAL: 0.84, LOOSE: 0.7 }

/**
 * Stable per-instance confidence: walk DOWN from the sensitivity's base so a
 * few low-confidence instances land below the 0.7 review floor on LOOSE/NORMAL
 * scans (giving the reviewer something to keep/reject) while STRICT stays clean.
 */
function instanceConfidence(base: number, index: number, total: number): number {
  if (total <= 1) return base
  // Spread roughly 0.3 of confidence across the run, clamped to [0.35, base].
  const step = 0.3 / Math.max(total - 1, 1)
  return Math.min(1, Math.max(0.35, base - step * index))
}

/**
 * Build a deterministic per-symbol count `TakeoffResult` from the dry-run
 * skeleton. Honors `sheet scope` (instance count scales with the number of
 * selected sheets) and `sensitivity` (hit rate + confidence band). Returns ONE
 * `ea` quantity for the chosen symbol whose `geometryRefs` point at one
 * `geometry.objects[]` entry per detected instance (each carrying a `bbox`
 * marker coordinate), so the review surfaces can render real per-symbol marks.
 */
function buildPerSymbolCount(skeleton: TakeoffResult, scope: CountScope): TakeoffResult {
  const template = skeleton.quantities[0]
  if (!template) return skeleton

  // Sheet scope: one or more selected sheets multiply the per-sheet hit rate.
  // Fall back to a single nominal sheet so an empty selection still produces a
  // believable count rather than zero.
  const sheetCount = Math.max(scope.sheets.length, 1)
  const perSheet = SENSITIVITY_HITS_PER_SHEET[scope.sensitivity]
  const instanceCount = perSheet * sheetCount
  const base = SENSITIVITY_BASE_CONFIDENCE[scope.sensitivity]

  // Marker coordinates: lay the synthesized instances out on a simple grid in
  // the blueprint's pixel/board space so the review canvas has real coordinates
  // to overlay instead of the old hardcoded marker list. Encoded as
  // `geometry.objects[]` (the schema-valid home for symbol instances), each with
  // a 1x1 `bbox` at the instance origin, referenced from the quantity below.
  const cols = Math.max(1, Math.ceil(Math.sqrt(instanceCount)))
  const spacing = 160
  const objectIds: string[] = []
  const objects = Array.from({ length: instanceCount }, (_, i) => {
    const id = `sym_${i + 1}`
    objectIds.push(id)
    const x = 120 + (i % cols) * spacing
    const y = 120 + Math.floor(i / cols) * spacing
    return { id, category: scope.symbol.label, bbox: [x, y, x + 1, y + 1] }
  })

  // The instance count is the sum of the per-instance kept set; confidence on
  // the rolled-up quantity is the mean instance confidence so the review floor
  // (applyReviewFloor) flags the count when the LOOSE/NORMAL tail dips low.
  const confidences = objects.map((_, i) => instanceConfidence(base, i, instanceCount))
  const meanConfidence = confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : base

  const sheetLabel = scope.sheets.length > 0 ? scope.sheets.join(', ') : 'all sheets'
  skeleton.quantities = [
    {
      ...template,
      id: 'q_count_1',
      description: `${scope.symbol.label} — count (${scope.sensitivity}, ${sheetLabel})`,
      unit: 'ea',
      value: instanceCount,
      confidence: Math.min(1, Math.max(0, meanConfidence)),
      geometryRefs: objectIds,
    },
  ]

  // Attach the synthesized instance markers as schema-valid geometry objects so
  // the promote path + review canvas can resolve per-instance coordinates.
  skeleton.geometry = { ...(skeleton.geometry ?? {}), objects }
  return skeleton
}

/**
 * Resolve the blueprint_vision capture mode from env (Anthropic path).
 *   - "live" + ANTHROPIC_API_KEY set ⇒ Anthropic live (now executed by the
 *     worker; the route only enqueues).
 *   - any other combination ⇒ dry-run stub.
 */
export function resolveBlueprintVisionMode(): 'live' | 'dry-run' {
  const mode = (process.env.BLUEPRINT_VISION_MODE ?? 'dry-run').trim().toLowerCase()
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim())
  if (mode === 'live' && hasKey) return 'live'
  return 'dry-run'
}

/**
 * Provider selection. `BLUEPRINT_VISION_MODE=gemini` + a `GEMINI_API_KEY`
 * routes blueprint takeoff through Google Gemini vision (no Anthropic). Any
 * other config falls back to the existing Anthropic-live / dry-run logic.
 * Live providers are executed asynchronously by the worker.
 */
export function resolveBlueprintVisionProvider(): 'gemini' | 'anthropic' | 'dry-run' {
  const mode = (process.env.BLUEPRINT_VISION_MODE ?? 'dry-run').trim().toLowerCase()
  if (mode === 'gemini' && Boolean(process.env.GEMINI_API_KEY?.trim())) return 'gemini'
  return resolveBlueprintVisionMode() === 'live' ? 'anthropic' : 'dry-run'
}

// Believable EIFS/stucco rows for the DETERMINISTIC DRY-RUN ONLY (demo / e2e
// fixtures / no-key environments). Always served with provenance
// 'stub-dry-run'. These rows are NEVER a fallback for a failed live provider
// call — that path fails the draft instead (see live-capture.ts).
type DemoUnit = 'sqft' | 'lft' | 'ea'
const DEMO_ROWS: ReadonlyArray<{ description: string; value: number; unit: DemoUnit; confidence: number }> = [
  { description: 'Exterior wall — EPS board insulation, 2"', value: 4820, unit: 'sqft', confidence: 0.94 },
  { description: 'Basecoat + reinforcing mesh over EPS', value: 4820, unit: 'sqft', confidence: 0.9 },
  { description: 'Sealant — control & perimeter joints', value: 540, unit: 'lft', confidence: 0.63 },
  { description: 'Window / door openings — verify & deduct', value: 18, unit: 'ea', confidence: 0.57 },
]

/**
 * Synchronous blueprint_vision capture — DRY-RUN ONLY. The route guarantees
 * live captures never reach this function (they enqueue for the worker), so
 * every result here is the deterministic stub with honest provenance.
 */
export async function captureBlueprintVisionDraft(
  payload: Record<string, unknown>,
  projectId: string,
): Promise<{ result: TakeoffResult; pipelineVersion: string; provenance: 'stub-dry-run' }> {
  // Per-symbol count scope (M1). When the count setup screen passes a
  // `count_scope` (a tapped symbol + sheets + sensitivity), return a per-symbol
  // count shaped result honoring the sheet scope and sensitivity, instead of a
  // whole-draft takeoff. Deterministic dry-run only — the live single-symbol
  // detector is a flagged follow-up. No symbol ⇒ fall through to whole-draft so
  // the existing flow (the default) is preserved unchanged.
  const countScope = parseCountScope(payload)
  if (countScope) {
    const skeleton = await buildDryRunSkeleton(projectId)
    buildPerSymbolCount(skeleton, countScope)
    return {
      result: applyReviewFloor(skeleton),
      pipelineVersion: BLUEPRINT_PIPELINE_VERSION,
      provenance: 'stub-dry-run',
    }
  }

  // Whole-draft dry-run — believable EIFS relabel of the package's generic stub.
  const skeleton = await buildDryRunSkeleton(projectId)
  relabelQuantities(skeleton, DEMO_ROWS)
  return { result: applyReviewFloor(skeleton), pipelineVersion: BLUEPRINT_PIPELINE_VERSION, provenance: 'stub-dry-run' }
}
