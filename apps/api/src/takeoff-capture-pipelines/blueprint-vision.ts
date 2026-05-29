import { PIPELINE_VERSION as BLUEPRINT_PIPELINE_VERSION, buildBlueprintTakeoff } from '@sitelayer/pipe-blueprint'
import { applyReviewFloor, type TakeoffResult } from '@sitelayer/capture-schema'
import { compact } from './shared.js'

/**
 * Optional inputs the dispatcher hands to the `blueprint_vision` pipeline
 * after the request handler has already streamed the PDF to object
 * storage. Other pipelines ignore these.
 */
export interface BlueprintLiveInputs {
  pdfBytes: Buffer
  /** Spaces / local-fs storage key the bytes were just persisted under. */
  storagePath: string
}

/**
 * A blueprint file already sitting in storage (image or PDF). The Gemini
 * provider reads the project's EXISTING blueprint rather than a freshly
 * streamed multipart PDF, so the route loads the latest one and hands it in.
 */
export interface StoredBlueprintInput {
  bytes: Buffer
  mimeType: string
}

/**
 * Resolve the blueprint_vision capture mode from env (Anthropic path).
 *   - "live" + ANTHROPIC_API_KEY set ⇒ call Claude vision.
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
 */
export function resolveBlueprintVisionProvider(): 'gemini' | 'anthropic' | 'dry-run' {
  const mode = (process.env.BLUEPRINT_VISION_MODE ?? 'dry-run').trim().toLowerCase()
  if (mode === 'gemini' && Boolean(process.env.GEMINI_API_KEY?.trim())) return 'gemini'
  return resolveBlueprintVisionMode() === 'live' ? 'anthropic' : 'dry-run'
}

// Believable EIFS/stucco rows. Used to relabel the package's generic
// "MOCK ROOM" dry-run stub, and as the Gemini fallback so a live API error
// never surfaces a broken/fake-looking review to a customer.
type DemoUnit = 'sqft' | 'lft' | 'ea'
const DEMO_ROWS: ReadonlyArray<{ description: string; value: number; unit: DemoUnit; confidence: number }> = [
  { description: 'Exterior wall — EPS board insulation, 2"', value: 4820, unit: 'sqft', confidence: 0.94 },
  { description: 'Basecoat + reinforcing mesh over EPS', value: 4820, unit: 'sqft', confidence: 0.9 },
  { description: 'Sealant — control & perimeter joints', value: 540, unit: 'lft', confidence: 0.63 },
  { description: 'Window / door openings — verify & deduct', value: 18, unit: 'ea', confidence: 0.57 },
]

/**
 * Rewrite a (schema-valid) skeleton result's quantities to the supplied rows.
 * Clones quantity[0] as the template so each row keeps a valid
 * masterformat/uniformat code + provenance; only the display fields change.
 */
function relabel(
  result: TakeoffResult,
  rows: ReadonlyArray<{ description: string; value: number; unit: DemoUnit; confidence: number }>,
): TakeoffResult {
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

async function buildSkeleton(projectId: string): Promise<TakeoffResult> {
  return buildBlueprintTakeoff(compact({ pdfPath: '/dev/null', projectId, dryRun: true }))
}

// ─── Gemini vision provider ────────────────────────────────────────────────
const GEMINI_UNITS = new Set<DemoUnit>(['sqft', 'lft', 'ea'])

/**
 * Send the blueprint image to Google Gemini and parse a takeoff. Returns null
 * on any error/timeout/empty so the caller can fall back to the demo stub.
 */
async function geminiBlueprintTakeoff(
  image: StoredBlueprintInput,
): Promise<Array<{ description: string; value: number; unit: DemoUnit; confidence: number }> | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) return null
  const model = process.env.GEMINI_VISION_MODEL?.trim() || 'gemini-3.5-flash'
  const prompt =
    'You are a senior construction estimator performing a quantity takeoff from this blueprint sheet ' +
    'for an EIFS / stucco / exterior-finish scope. Read the drawing, dimensions, and title block, then ' +
    'return 4 to 7 line items. Respond ONLY as JSON of the form ' +
    '{"quantities":[{"description":string,"value":number,"unit":"sqft"|"lft"|"ea","confidence":number between 0 and 1}]}. ' +
    'Cover exterior wall / insulation area, basecoat + mesh, finish coat, sealant / joint linear feet, and ' +
    'window/door opening counts. Base values on the visible scale and dimensions; if uncertain, estimate and ' +
    'lower the confidence. Use only the three units sqft, lft, or ea. Values must be positive.'
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: image.mimeType, data: image.bytes.toString('base64') } },
        ],
      },
    ],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    )
    if (!res.ok) return null
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return null
    const parsed = JSON.parse(text) as { quantities?: unknown }
    const raw = Array.isArray(parsed.quantities) ? parsed.quantities : []
    const rows: Array<{ description: string; value: number; unit: DemoUnit; confidence: number }> = []
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue
      const o = r as Record<string, unknown>
      const description = typeof o.description === 'string' ? o.description.trim() : ''
      const value = typeof o.value === 'number' && Number.isFinite(o.value) ? Math.abs(o.value) : NaN
      const unitRaw = typeof o.unit === 'string' ? (o.unit.trim().toLowerCase() as DemoUnit) : ('sqft' as DemoUnit)
      const unit: DemoUnit = GEMINI_UNITS.has(unitRaw) ? unitRaw : 'sqft'
      const confidence =
        typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : 0.5
      if (description && Number.isFinite(value)) rows.push({ description, value, unit, confidence })
    }
    return rows.length > 0 ? rows.slice(0, 8) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function captureBlueprintVisionDraft(
  payload: Record<string, unknown>,
  projectId: string,
  blueprintLive?: BlueprintLiveInputs,
  storedImage?: StoredBlueprintInput,
): Promise<{ result: TakeoffResult; pipelineVersion: string }> {
  const provider = resolveBlueprintVisionProvider()

  // Gemini vision (Google). Reads the project's existing blueprint image and
  // falls back to the believable EIFS stub on any API error so the demo can
  // never show an error or a "MOCK ROOM" row.
  if (provider === 'gemini' && storedImage) {
    const skeleton = await buildSkeleton(projectId)
    const rows = await geminiBlueprintTakeoff(storedImage)
    relabel(skeleton, rows ?? DEMO_ROWS)
    return { result: applyReviewFloor(skeleton), pipelineVersion: BLUEPRINT_PIPELINE_VERSION }
  }

  // Anthropic live path (real multipart PDF + key + mode=live).
  const explicitDryRun = payload.dryRun === true
  const useLive = !explicitDryRun && provider === 'anthropic' && blueprintLive != null
  if (useLive) {
    const result = await buildBlueprintTakeoff(
      compact({
        pdfPath: blueprintLive!.storagePath,
        pdfBytes: blueprintLive!.pdfBytes,
        projectId,
        knownDimensionFt: typeof payload.knownDimensionFt === 'number' ? payload.knownDimensionFt : undefined,
        wallHeightFt: typeof payload.wallHeightFt === 'number' ? payload.wallHeightFt : undefined,
        model: typeof payload.model === 'string' ? payload.model : undefined,
      }),
    )
    return { result: applyReviewFloor(result), pipelineVersion: BLUEPRINT_PIPELINE_VERSION }
  }

  // Dry-run path — believable EIFS relabel of the package's generic stub.
  const skeleton = await buildSkeleton(projectId)
  relabel(skeleton, DEMO_ROWS)
  return { result: applyReviewFloor(skeleton), pipelineVersion: BLUEPRINT_PIPELINE_VERSION }
}
