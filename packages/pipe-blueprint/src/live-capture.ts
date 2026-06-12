/**
 * Shared LIVE blueprint-vision capture — the single implementation used by the
 * worker runner (apps/worker/src/runners/takeoff-capture.ts) that drains
 * `takeoff_capture_pipeline` outbox rows. Moved out of
 * apps/api/src/takeoff-capture-pipelines/blueprint-vision.ts (2026-06-12) when
 * the capture endpoint went async: the API now only enqueues; this module is
 * where the provider calls actually happen.
 *
 * HONESTY CONTRACT (do not regress):
 *   - A provider error THROWS BlueprintVisionProviderError. It never falls
 *     back to demo/stub rows — the old error→DEMO_ROWS fallback let estimators
 *     review and promote invented quantities.
 *   - Every successful live run returns REAL token usage straight off the
 *     provider response (Gemini usageMetadata / Anthropic usage), so cost
 *     accounting stores actuals, never a flat per-page fiction.
 */

import { buildBlueprintTakeoff, DEFAULT_MODEL, PIPELINE_VERSION } from './extract.js'
import { RECOMMENDED_TAKEOFF_MODEL } from './cost.js'
import type { FetchLike } from './provider.js'
import { applyReviewFloor, type TakeoffResult } from '@sitelayer/capture-schema'

/** A blueprint file already sitting in object storage (image or PDF). */
export interface StoredBlueprintInput {
  bytes: Buffer
  mimeType: string
}

/** Real token usage from a live provider call. Numbers come from the provider
 *  response; `null` means the provider response did not carry the field (we
 *  store the absence rather than inventing a number). */
export interface CaptureTokenUsage {
  provider: 'gemini' | 'anthropic'
  model: string
  input_tokens: number | null
  output_tokens: number | null
}

/** Typed provider failure. The worker maps this (and any other throw) to a
 *  FAILED draft with the message surfaced — never to stub rows. */
export class BlueprintVisionProviderError extends Error {
  constructor(
    public readonly provider: 'gemini' | 'anthropic',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'BlueprintVisionProviderError'
  }
}

export type LiveTakeoffRowUnit = 'sqft' | 'lft' | 'ea'

export interface LiveTakeoffRow {
  description: string
  value: number
  unit: LiveTakeoffRowUnit
  confidence: number
}

const LIVE_ROW_UNITS = new Set<LiveTakeoffRowUnit>(['sqft', 'lft', 'ea'])

/**
 * Rewrite a (schema-valid) skeleton result's quantities to the supplied rows.
 * Clones quantity[0] as the template so each row keeps a valid
 * masterformat/uniformat code + provenance; only the display fields change.
 * Shared by the worker's Gemini live path (real extracted rows) and the API's
 * synchronous dry-run path (demo rows, provenance 'stub-dry-run').
 */
export function relabelQuantities(result: TakeoffResult, rows: ReadonlyArray<LiveTakeoffRow>): TakeoffResult {
  const template = result.quantities[0]
  if (!template) return result
  result.quantities = rows.map((row, i) => ({
    ...template,
    id: `q_${i + 1}`,
    description: row.description,
    unit: row.unit,
    value: Math.max(0, row.value),
    confidence: Math.min(1, Math.max(0, row.confidence)),
  }))
  return result
}

/** Deterministic schema-valid TakeoffResult skeleton (the package's dry-run
 *  mock). Live Gemini rows / dry-run demo rows are relabelled onto it. */
export async function buildDryRunSkeleton(projectId: string): Promise<TakeoffResult> {
  return buildBlueprintTakeoff({ pdfPath: '/dev/null', projectId, dryRun: true })
}

const GEMINI_TAKEOFF_PROMPT =
  'You are a senior construction estimator performing a quantity takeoff from this blueprint sheet ' +
  'for an EIFS / stucco / exterior-finish scope. Read the drawing, dimensions, and title block, then ' +
  'return 4 to 7 line items. Respond ONLY as JSON of the form ' +
  '{"quantities":[{"description":string,"value":number,"unit":"sqft"|"lft"|"ea","confidence":number between 0 and 1}]}. ' +
  'Cover exterior wall / insulation area, basecoat + mesh, finish coat, sealant / joint linear feet, and ' +
  'window/door opening counts. When counting openings or any "ea" quantity, count ONLY real enclosed ' +
  'habitable rooms and actual openings; do NOT split closets, hallways, or dimension/annotation zones into ' +
  'separate rooms or counts, and merge duplicates so the same item is counted at most once — if unsure, omit it. ' +
  'Base values on the visible scale and dimensions; if uncertain, estimate and ' +
  'lower the confidence. Use only the three units sqft, lft, or ea. Values must be positive.'

export interface GeminiLiveOptions {
  apiKey: string
  /** Defaults to RECOMMENDED_TAKEOFF_MODEL (gemini-3.1-flash-lite). */
  model?: string
  timeoutMs?: number
  /** Injectable for tests. */
  fetchImpl?: FetchLike
}

/**
 * Send the blueprint image/PDF to Google Gemini and parse takeoff rows plus
 * REAL usageMetadata. THROWS BlueprintVisionProviderError on any HTTP error,
 * timeout, unparseable response, or empty extraction — the caller decides what
 * a failure means (the worker marks the draft failed). No stub fallback here.
 */
export async function geminiLiveTakeoffRows(
  image: StoredBlueprintInput,
  opts: GeminiLiveOptions,
): Promise<{ rows: LiveTakeoffRow[]; usage: CaptureTokenUsage }> {
  const apiKey = opts.apiKey.trim()
  if (!apiKey) throw new BlueprintVisionProviderError('gemini', 'gemini live takeoff requires an API key')
  const model = opts.model?.trim() || RECOMMENDED_TAKEOFF_MODEL
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined)
  if (!fetchImpl) throw new BlueprintVisionProviderError('gemini', 'no fetch implementation available')

  const body = {
    contents: [
      {
        parts: [
          { text: GEMINI_TAKEOFF_PROMPT },
          { inline_data: { mime_type: image.mimeType, data: image.bytes.toString('base64') } },
        ],
      },
    ],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000)
  let res: Response
  let rawText: string
  try {
    res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    )
    rawText = await res.text()
  } catch (err) {
    throw new BlueprintVisionProviderError(
      'gemini',
      `gemini ${model} request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new BlueprintVisionProviderError(
      'gemini',
      `gemini ${model} returned HTTP ${res.status}: ${rawText.slice(0, 240)}`,
    )
  }

  let json: {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  try {
    json = JSON.parse(rawText) as typeof json
  } catch (err) {
    throw new BlueprintVisionProviderError('gemini', `gemini ${model} returned unparseable JSON envelope`, {
      cause: err,
    })
  }
  const usage: CaptureTokenUsage = {
    provider: 'gemini',
    model,
    input_tokens: typeof json.usageMetadata?.promptTokenCount === 'number' ? json.usageMetadata.promptTokenCount : null,
    output_tokens:
      typeof json.usageMetadata?.candidatesTokenCount === 'number' ? json.usageMetadata.candidatesTokenCount : null,
  }

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new BlueprintVisionProviderError('gemini', `gemini ${model} returned no candidate text`)
  let parsed: { quantities?: unknown }
  try {
    parsed = JSON.parse(text) as { quantities?: unknown }
  } catch (err) {
    throw new BlueprintVisionProviderError('gemini', `gemini ${model} candidate text is not valid JSON`, {
      cause: err,
    })
  }
  const raw = Array.isArray(parsed.quantities) ? parsed.quantities : []
  const rows: LiveTakeoffRow[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const description = typeof o.description === 'string' ? o.description.trim() : ''
    const value = typeof o.value === 'number' && Number.isFinite(o.value) ? Math.abs(o.value) : NaN
    const unitRaw =
      typeof o.unit === 'string' ? (o.unit.trim().toLowerCase() as LiveTakeoffRowUnit) : ('sqft' as LiveTakeoffRowUnit)
    const unit: LiveTakeoffRowUnit = LIVE_ROW_UNITS.has(unitRaw) ? unitRaw : 'sqft'
    const confidence = typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : 0.5
    if (description && Number.isFinite(value)) rows.push({ description, value, unit, confidence })
  }
  if (rows.length === 0) {
    throw new BlueprintVisionProviderError('gemini', `gemini ${model} extracted zero usable quantities`)
  }
  return { rows: rows.slice(0, 8), usage }
}

export type LiveCaptureProvider = 'gemini' | 'anthropic'

export interface RunLiveBlueprintCaptureArgs {
  provider: LiveCaptureProvider
  projectId: string
  /** The blueprint bytes (read from object storage by the caller). */
  input: StoredBlueprintInput
  /** Storage key — provenance label only (BlueprintArtifact.sourcePdfPath). */
  storagePath: string
  /** Original capture request payload (knownDimensionFt / wallHeightFt / model
   *  passthroughs for the Anthropic path). */
  payload?: Record<string, unknown>
  gemini?: Omit<GeminiLiveOptions, 'apiKey'> & { apiKey?: string }
  anthropic?: { apiKey?: string }
}

export interface LiveBlueprintCaptureOutcome {
  result: TakeoffResult
  pipelineVersion: string
  provenance: 'gemini-live' | 'anthropic-live'
  usage: CaptureTokenUsage
}

/**
 * Run the LIVE blueprint-vision pipeline for one draft. Throws on any provider
 * error (BlueprintVisionProviderError or the underlying error for the
 * Anthropic SDK path) — never returns fabricated rows.
 */
export async function runLiveBlueprintCapture(args: RunLiveBlueprintCaptureArgs): Promise<LiveBlueprintCaptureOutcome> {
  const payload = args.payload ?? {}

  if (args.provider === 'gemini') {
    const apiKey = args.gemini?.apiKey ?? process.env.GEMINI_API_KEY ?? ''
    const model = args.gemini?.model ?? process.env.GEMINI_VISION_MODEL?.trim() ?? undefined
    const { rows, usage } = await geminiLiveTakeoffRows(args.input, {
      apiKey,
      ...(model ? { model } : {}),
      ...(args.gemini?.timeoutMs ? { timeoutMs: args.gemini.timeoutMs } : {}),
      ...(args.gemini?.fetchImpl ? { fetchImpl: args.gemini.fetchImpl } : {}),
    })
    const skeleton = await buildDryRunSkeleton(args.projectId)
    relabelQuantities(skeleton, rows)
    return {
      result: applyReviewFloor(skeleton),
      pipelineVersion: PIPELINE_VERSION,
      provenance: 'gemini-live',
      usage,
    }
  }

  // Anthropic path — the full classify + per-page extract pipeline. Token
  // usage accumulates across every Claude call via onUsage.
  let inputTokens = 0
  let outputTokens = 0
  let sawUsage = false
  const model = typeof payload.model === 'string' ? payload.model : undefined
  const result = await buildBlueprintTakeoff({
    pdfPath: args.storagePath,
    pdfBytes: args.input.bytes,
    projectId: args.projectId,
    ...(typeof payload.knownDimensionFt === 'number' ? { knownDimensionFt: payload.knownDimensionFt } : {}),
    ...(typeof payload.wallHeightFt === 'number' ? { wallHeightFt: payload.wallHeightFt } : {}),
    ...(model ? { model } : {}),
    ...(args.anthropic?.apiKey ? { anthropicApiKey: args.anthropic.apiKey } : {}),
    onUsage: (u) => {
      sawUsage = true
      inputTokens += u.inputTokens
      outputTokens += u.outputTokens
    },
  })
  return {
    result: applyReviewFloor(result),
    pipelineVersion: PIPELINE_VERSION,
    provenance: 'anthropic-live',
    usage: {
      provider: 'anthropic',
      model: model ?? DEFAULT_MODEL,
      input_tokens: sawUsage ? inputTokens : null,
      output_tokens: sawUsage ? outputTokens : null,
    },
  }
}
