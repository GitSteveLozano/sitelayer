/**
 * buildBlueprintTakeoff — top-level entry point.
 *
 * Pipeline (research/04 §4 + CONTRACT.md):
 *   1. Read PDF, base64-encode, sha256.
 *   2. Send the PDF + CLASSIFY_PROMPT to Claude. Validate JSON against
 *      ClassifyResponse (zod).
 *   3. For each floor_plan / site_plan page, send PDF + EXTRACT_PROMPT.
 *      Validate against ExtractResponse.
 *   4. Calibrate scale per page:
 *        - opts.knownDimensionFt matched against extracted dimensionStrings
 *          → user_known_dimension (highest confidence).
 *        - else titleblock.scaleText + assumed/known DPI → titleblock_text.
 *        - else fall back to inferred (very low confidence).
 *   5. Compute deterministic quantities from polygons + scale.
 *   6. Map to TakeoffQuantity[] with full provenance.
 *   7. Build the BlueprintArtifact from per-page details.
 *   8. Run applyReviewFloor + validateTakeoffResult before returning.
 *
 * If no page is a drawing (everything is `non_drawing`/etc.) we throw
 * NoDrawingsFoundError. This is the documented behaviour — see
 * NOTES.md for rationale. Schema requires ≥1 quantity.
 */
import Anthropic from '@anthropic-ai/sdk'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import {
  type BlueprintArtifact,
  type DimensionSourceType,
  type TakeoffQuantity,
  type TakeoffResult,
  type TakeoffWarning,
  applyReviewFloor,
  validateTakeoffResult,
} from '@sitelayer/capture-schema'
import { callClaudePdfJson } from './anthropicClient.js'
import { dimensionMatches, parseDimensionToFeet, pixelsPerFootFromScaleText } from './dimensions.js'
import { polygonAreaPx2, polygonBbox, polygonPerimeterPx, segmentLengthPx } from './geometry.js'
import { CLASSIFY_PROMPT, EXTRACT_PROMPT, PROMPT_VERSION } from './prompts.js'
import {
  ClassifyResponse,
  type ClassifyPage,
  type ExtractOpening,
  type ExtractResponse,
  ExtractResponse as ExtractResponseSchema,
} from './responseSchemas.js'

export const PIPELINE_VERSION = '0.1.0' as const
export const DEFAULT_MODEL = 'claude-opus-4-7' as const
export const DEFAULT_WALL_HEIGHT_FT = 8.0 as const
/**
 * Anthropic doesn't publish a guaranteed PDF render DPI. From observation
 * + research/04, page-image rendering for documents trends ~72-150 DPI
 * with a 1568 px long-edge cap. We default to 100 DPI as a middle-of-
 * the-road assumption; callers can override with opts.assumedDpi.
 * This is documented in NOTES.md.
 */
export const DEFAULT_ASSUMED_DPI = 100 as const

/** Confidence multipliers per dimensionSourceType (CONTRACT §Confidence). */
const DIM_BOOST = {
  measured: 1.0,
  annotated: 0.95,
  inferred: 0.6,
} satisfies Record<DimensionSourceType, number>

const CONFIDENCE_FLOOR = 0.1

const PLAN_KINDS = new Set<ClassifyPage['kind']>(['floor_plan', 'site_plan'])

export class NoDrawingsFoundError extends Error {
  constructor(message = 'No drawing pages found in PDF') {
    super(message)
    this.name = 'NoDrawingsFoundError'
  }
}

export interface BuildBlueprintTakeoffOptions {
  /** Filesystem path to the PDF. Mutually exclusive with `pdfBytes` —
   *  exactly one must be provided. When `pdfBytes` is set, `pdfPath` is
   *  treated as a logical label only (e.g. a Spaces storage key) and is
   *  recorded into the BlueprintArtifact for provenance. */
  pdfPath: string
  /** In-memory PDF bytes. Use this when the PDF was streamed from a
   *  multipart upload and is already in memory (or fetched from object
   *  storage). When supplied, the pipeline skips disk I/O. `pdfPath`
   *  still labels the artifact for provenance. */
  pdfBytes?: Buffer
  /** Optional captured-at override for the case where the bytes came
   *  from an upload (no filesystem mtime). ISO-8601 with offset. */
  capturedAt?: string
  projectId: string
  /** A real-world dimension (in feet) the user knows is on the sheet. Used
   *  to calibrate scale by matching against extracted dimension strings. */
  knownDimensionFt?: number
  wallHeightFt?: number
  anthropicApiKey?: string
  /** Override the model. Default `claude-opus-4-7`. */
  model?: string
  /** Override the assumed render DPI (Anthropic doesn't publish a fixed
   *  number — see NOTES.md). */
  assumedDpi?: number
  /** Optional dependency injection for tests. If supplied, no real API
   *  client is created. */
  anthropicClient?: Anthropic
  /** When true, skip Anthropic calls and emit a fixture-driven mock. */
  dryRun?: boolean
  /** Pages to use for dry-run. Defaults to a one-floor-plan-page mock. */
  dryRunMock?: {
    classify: unknown
    extract: Record<number, unknown>
  }
}

// ─── Internal types ─────────────────────────────────────────────────────────

interface PageScaleResult {
  pixelsPerFoot: number
  source: 'titleblock_text' | 'scale_bar' | 'user_known_dimension' | 'inferred'
  confidence: number
}

interface ExtractedPage {
  pageIndex: number
  classification: ClassifyPage
  extract: ExtractResponse
}

// ─── Main entry point ──────────────────────────────────────────────────────

export async function buildBlueprintTakeoff(opts: BuildBlueprintTakeoffOptions): Promise<TakeoffResult> {
  const model = opts.model ?? DEFAULT_MODEL
  const wallHeightFt = opts.wallHeightFt ?? DEFAULT_WALL_HEIGHT_FT
  const assumedDpi = opts.assumedDpi ?? DEFAULT_ASSUMED_DPI

  // 1. Resolve PDF bytes either from in-memory buffer (multipart upload
  //    path) or from disk (CLI / fixture path). The hash + base64 payload
  //    are identical regardless of source.
  const pdfBytes = opts.pdfBytes ?? (await readFile(opts.pdfPath))
  const pdfBase64 = pdfBytes.toString('base64')
  const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex')
  let capturedAt: string
  if (opts.capturedAt) {
    capturedAt = opts.capturedAt
  } else if (opts.pdfBytes) {
    // Bytes provided directly — no filesystem mtime to lean on. Stamp now.
    capturedAt = new Date().toISOString()
  } else {
    const stats = await stat(opts.pdfPath)
    capturedAt = stats.mtime.toISOString()
  }

  // 2. Classify every page.
  const classifyRaw = await runClassify(opts, model, pdfBase64)
  const classify = ClassifyResponse.parse(classifyRaw)

  // 3. Extract on plan pages.
  const planPages = classify.pages.filter((p) => PLAN_KINDS.has(p.kind))
  const extractedPages: ExtractedPage[] = []
  for (const page of planPages) {
    const extractRaw = await runExtract(opts, model, pdfBase64, page.pageIndex)
    const extract = ExtractResponseSchema.parse(extractRaw)
    extractedPages.push({
      pageIndex: page.pageIndex,
      classification: page,
      extract,
    })
  }

  // 4–7: build quantities + artifact.
  const warnings: TakeoffWarning[] = []
  const quantities: TakeoffQuantity[] = []
  const blueprintPages: BlueprintArtifact['pages'] = []

  // Pages we'll include in the artifact even though they didn't produce
  // quantities (so the reviewer can see the model classified them).
  const allPages = classify.pages

  // Quick lookup of extract data by page index.
  const extractByPage = new Map<number, ExtractedPage>()
  for (const ep of extractedPages) extractByPage.set(ep.pageIndex, ep)

  const pageSizesPts: Array<{ w: number; h: number }> = []

  for (const page of allPages) {
    const ep = extractByPage.get(page.pageIndex)

    if (!ep) {
      // Non-drawing or non-plan page. Add a stub artifact entry, no quantities.
      blueprintPages.push({
        pageIndex: page.pageIndex,
        imageSize: { widthPx: 0, heightPx: 0 },
        classification: { kind: page.kind, confidence: page.confidence },
        scaleConfidence: 0,
        rooms: [],
        walls: [],
        notes: [],
        warnings: [],
      })
      warnings.push({
        code: 'non_drawing_skipped',
        severity: 'info',
        message: `Page ${page.pageIndex} (${page.kind}) skipped — not a plan sheet`,
      })
      continue
    }

    // Calibrate the page's scale.
    const pageScale = calibrateScale({
      extract: ep.extract,
      knownDimensionFt: opts.knownDimensionFt,
      assumedDpi,
    })

    // Build the per-page artifact + emit quantities.
    const { artifactPage, pageQuantities } = pageToArtifactAndQuantities({
      page: ep,
      pageScale,
      pdfSha256,
      detector: model,
      detectorVersion: PROMPT_VERSION,
      wallHeightFt,
    })
    blueprintPages.push(artifactPage)
    pageSizesPts.push({
      w: ep.extract.imageSize.widthPx,
      h: ep.extract.imageSize.heightPx,
    })
    quantities.push(...pageQuantities)

    if (pageScale.source === 'inferred') {
      warnings.push({
        code: 'scale_inferred',
        severity: 'warn',
        message: `Page ${ep.pageIndex} scale was inferred — quantities are low confidence`,
      })
    }
  }

  // If we found no plan pages at all, throw a typed error. The schema
  // requires ≥1 quantity; emitting an empty TakeoffResult would fail
  // validation. See NOTES.md.
  if (quantities.length === 0) {
    throw new NoDrawingsFoundError(
      `No floor_plan or site_plan pages produced quantities (saw kinds: ${Array.from(
        new Set(allPages.map((p) => p.kind)),
      ).join(', ')})`,
    )
  }

  const artifact: BlueprintArtifact = {
    sourcePdfPath: opts.pdfPath,
    pdfSha256,
    pdfMeta: {
      pages: allPages.length,
      // pageSizesPts is best-effort — rendered px stand in for pts here.
      pageSizesPts,
    },
    modelVersion: model,
    promptVersion: PROMPT_VERSION,
    pages: blueprintPages,
  }

  const takeoff: TakeoffResult = {
    schemaVersion: '1.0.0',
    takeoffId: randomUUID(),
    projectId: opts.projectId,
    capturedAt,
    producedAt: new Date().toISOString(),
    source: 'blueprint.vision',
    pipelineVersion: PIPELINE_VERSION,
    units: 'imperial',
    quantities,
    sourceArtifact: { kind: 'blueprint', blueprint: artifact },
    warnings: warnings.length ? warnings : undefined,
  }

  const withFloor = applyReviewFloor(takeoff)
  return validateTakeoffResult(withFloor)
}

// ─── Step 2/3: Anthropic calls (or dry-run mocks) ──────────────────────────

async function runClassify(opts: BuildBlueprintTakeoffOptions, model: string, pdfBase64: string): Promise<unknown> {
  if (opts.dryRun) {
    return opts.dryRunMock?.classify ?? defaultDryRunClassify()
  }
  const client = ensureClient(opts)
  return callClaudePdfJson({
    client,
    model,
    pdfBase64,
    prompt: CLASSIFY_PROMPT,
    cacheDocument: true,
  })
}

async function runExtract(
  opts: BuildBlueprintTakeoffOptions,
  model: string,
  pdfBase64: string,
  pageIndex: number,
): Promise<unknown> {
  if (opts.dryRun) {
    return opts.dryRunMock?.extract?.[pageIndex] ?? defaultDryRunExtract()
  }
  const client = ensureClient(opts)
  return callClaudePdfJson({
    client,
    model,
    pdfBase64,
    prompt: `${EXTRACT_PROMPT}\n\n(Focus on page index ${pageIndex} only.)`,
    cacheDocument: true,
  })
}

function ensureClient(opts: BuildBlueprintTakeoffOptions): Anthropic {
  if (opts.anthropicClient) return opts.anthropicClient
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY missing. Set the env var, pass anthropicApiKey, or use dryRun: true.')
  }
  return new Anthropic({ apiKey })
}

// ─── Step 4: scale calibration ─────────────────────────────────────────────

interface CalibrateScaleArgs {
  extract: ExtractResponse
  knownDimensionFt: number | undefined
  assumedDpi: number
}

export function calibrateScale(args: CalibrateScaleArgs): PageScaleResult {
  const { extract, knownDimensionFt, assumedDpi } = args

  // a) user_known_dimension — highest confidence path. Match knownDim
  //    against the model's transcribed dimension strings, then derive
  //    pixelsPerFoot from a wall whose annotated length equals that string.
  if (knownDimensionFt && knownDimensionFt > 0) {
    // Find a wall whose annotatedLengthText parses to ~knownDimensionFt.
    const wallMatch = extract.walls.find(
      (w) => w.annotatedLengthText != null && dimensionMatches(knownDimensionFt, w.annotatedLengthText),
    )
    if (wallMatch) {
      const px = segmentLengthPx(wallMatch.start, wallMatch.end)
      if (px > 0) {
        return {
          pixelsPerFoot: px / knownDimensionFt,
          source: 'user_known_dimension',
          confidence: 0.95,
        }
      }
    }

    // Or: match against the dimensionStrings list. We can't tie a string
    // back to a specific wall in this branch, so we still derive
    // pixelsPerFoot from titleblock as a best effort but mark that the
    // user dimension was at least *recognized* on the sheet.
    const stringMatch = extract.dimensionStrings.some((d) => dimensionMatches(knownDimensionFt, d))
    if (stringMatch) {
      // Couldn't bind to a wall; fall through to titleblock with a note —
      // but boost confidence because at least the dim is on the sheet.
      const tb = extract.titleblock?.scaleText
        ? pixelsPerFootFromScaleText(extract.titleblock.scaleText, assumedDpi)
        : null
      if (tb && tb > 0) {
        return {
          pixelsPerFoot: tb,
          source: 'user_known_dimension',
          confidence: 0.9,
        }
      }
    }
  }

  // b) titleblock_text — parse "1/4\" = 1'-0\"" + assumedDpi.
  const scaleText = extract.titleblock?.scaleText ?? null
  if (scaleText) {
    const px = pixelsPerFootFromScaleText(scaleText, assumedDpi)
    if (px && px > 0) {
      return {
        pixelsPerFoot: px,
        source: 'titleblock_text',
        confidence: 0.6,
      }
    }
  }

  // c) Fallback: inferred. Pick a defensible pixelsPerFoot from the
  //    image size assuming a 50ft-wide drawing area. This is a guess —
  //    all derived quantities are heavily penalized below.
  const widthPx = extract.imageSize.widthPx || 1000
  return {
    pixelsPerFoot: widthPx / 50,
    source: 'inferred',
    confidence: 0.3,
  }
}

// ─── Steps 5–7: per-page → quantities + artifact ────────────────────────────

interface PageToOutputsArgs {
  page: ExtractedPage
  pageScale: PageScaleResult
  pdfSha256: string
  detector: string
  detectorVersion: string
  wallHeightFt: number
}

interface PageToOutputsResult {
  artifactPage: BlueprintArtifact['pages'][number]
  pageQuantities: TakeoffQuantity[]
}

function pageToArtifactAndQuantities(args: PageToOutputsArgs): PageToOutputsResult {
  const { page, pageScale, pdfSha256, detector, detectorVersion, wallHeightFt } = args
  const ftPerPx = 1 / pageScale.pixelsPerFoot
  const pageQuantities: TakeoffQuantity[] = []

  // Build the room-level artifact entries while we go.
  const artifactRooms: BlueprintArtifact['pages'][number]['rooms'] = []

  for (const room of page.extract.rooms) {
    const areaPx2 = polygonAreaPx2(room.polygon)
    const perimeterPx = polygonPerimeterPx(room.polygon)
    const measuredAreaSqFt = areaPx2 * ftPerPx * ftPerPx
    const measuredPerimeterFt = perimeterPx * ftPerPx

    // Prefer annotated values when present + parseable; else measured.
    const annotatedAreaFt2 = parseAnnotatedArea(room.annotatedAreaText ?? null)
    const annotatedPerimeterFt = parseDimensionToFeet(room.annotatedPerimeterText ?? '')

    const areaSourceType: DimensionSourceType = annotatedAreaFt2 != null ? 'annotated' : 'measured'
    const perimeterSourceType: DimensionSourceType = annotatedPerimeterFt != null ? 'annotated' : 'measured'

    const areaValue = annotatedAreaFt2 != null ? annotatedAreaFt2 : measuredAreaSqFt
    const perimeterValue = annotatedPerimeterFt != null ? annotatedPerimeterFt : measuredPerimeterFt

    // Sum opening widths for this room (for baseboard subtraction +
    // wall area subtraction). Use annotated widths where parseable.
    const openingsTotalLfWidth = sumOpeningWidthsFt(room.openings)
    const openingsAreaSqft = openingsTotalLfWidth * Math.min(wallHeightFt, 7) // assume opening height ~7ft when not labelled
    const drywallAreaSqft = Math.max(perimeterValue * wallHeightFt - openingsAreaSqft, 0)
    const baseboardLf = Math.max(perimeterValue - openingsTotalLfWidth, 0)
    const doorCount = room.openings.filter((o) => o.kind === 'door').length
    const windowCount = room.openings.filter((o) => o.kind === 'window').length

    const bbox = polygonBbox(room.polygon)
    const provenance = (sourceType: DimensionSourceType) => ({
      kind: 'blueprint' as const,
      pdfSha256,
      pageIndex: page.pageIndex,
      bbox,
      scaleFt: pageScale.pixelsPerFoot,
      detector,
      detectorVersion,
      dimensionSourceType: sourceType,
    })

    const baseConfidence = Math.min(pageScale.confidence, page.classification.confidence)

    const conf = (sourceType: DimensionSourceType) => Math.max(baseConfidence * DIM_BOOST[sourceType], CONFIDENCE_FLOOR)

    const roomLabel = room.name ?? room.id

    // (a) floor area — UniFormat B3010 (interior finishes — flooring).
    pageQuantities.push({
      id: `q_${page.pageIndex}_${room.id}_floor`,
      description: `${roomLabel} — floor area`,
      uniformatCode: 'B3010',
      unit: 'sqft',
      value: round2(areaValue),
      confidence: round3(conf(areaSourceType)),
      provenance: provenance(areaSourceType),
    })

    // (b) drywall area — MasterFormat 09 29 00 gypsum board.
    pageQuantities.push({
      id: `q_${page.pageIndex}_${room.id}_drywall`,
      description: `${roomLabel} — drywall (perimeter × ${wallHeightFt}ft − openings)`,
      masterformatCode: '09 29 00',
      unit: 'sqft',
      value: round2(drywallAreaSqft),
      confidence: round3(conf(perimeterSourceType)),
      provenance: provenance(perimeterSourceType),
    })

    // (c) baseboard — MasterFormat 06 22 00 finish carpentry.
    pageQuantities.push({
      id: `q_${page.pageIndex}_${room.id}_baseboard`,
      description: `${roomLabel} — baseboard`,
      masterformatCode: '06 22 00',
      unit: 'lft',
      value: round2(baseboardLf),
      confidence: round3(conf(perimeterSourceType)),
      provenance: provenance(perimeterSourceType),
    })

    // (d) interior doors — MasterFormat 08 14 00.
    if (doorCount > 0) {
      pageQuantities.push({
        id: `q_${page.pageIndex}_${room.id}_doors`,
        description: `${roomLabel} — interior doors`,
        masterformatCode: '08 14 00',
        unit: 'ea',
        value: doorCount,
        confidence: round3(conf('measured')),
        provenance: provenance('measured'),
      })
    }

    // (e) windows — MasterFormat 08 50 00.
    if (windowCount > 0) {
      pageQuantities.push({
        id: `q_${page.pageIndex}_${room.id}_windows`,
        description: `${roomLabel} — windows`,
        masterformatCode: '08 50 00',
        unit: 'ea',
        value: windowCount,
        confidence: round3(conf('measured')),
        provenance: provenance('measured'),
      })
    }

    artifactRooms.push({
      id: room.id,
      ...(room.name ? { name: room.name } : {}),
      polygon: room.polygon,
      areaSqFt: {
        value: round2(areaValue),
        sourceType: areaSourceType,
        confidence: round3(conf(areaSourceType)),
      },
      perimeterFt: {
        value: round2(perimeterValue),
        sourceType: perimeterSourceType,
        confidence: round3(conf(perimeterSourceType)),
      },
      openings: room.openings.map((o) => buildArtifactOpening(o, conf)),
    })
  }

  // Wall-level artifact entries.
  const artifactWalls: BlueprintArtifact['pages'][number]['walls'] = page.extract.walls.map((w) => {
    const px = segmentLengthPx(w.start, w.end)
    const measuredFt = px * ftPerPx
    const annotatedFt = parseDimensionToFeet(w.annotatedLengthText ?? '')
    const sourceType: DimensionSourceType = annotatedFt != null ? 'annotated' : 'measured'
    const value = annotatedFt != null ? annotatedFt : measuredFt
    const confidence = Math.min(pageScale.confidence, page.classification.confidence) * DIM_BOOST[sourceType]

    return {
      id: w.id,
      start: w.start,
      end: w.end,
      ...(w.thicknessIn != null ? { thicknessIn: w.thicknessIn } : {}),
      lengthFt: {
        value: round2(value),
        sourceType,
        confidence: round3(Math.max(confidence, CONFIDENCE_FLOOR)),
      },
    }
  })

  const artifactPage: BlueprintArtifact['pages'][number] = {
    pageIndex: page.pageIndex,
    imageSize: page.extract.imageSize,
    classification: {
      kind: page.classification.kind,
      confidence: page.classification.confidence,
    },
    ...(page.extract.titleblock ? { titleblock: cleanTitleblock(page.extract.titleblock) } : {}),
    scale: {
      pixelsPerFoot: round3(pageScale.pixelsPerFoot),
      source: pageScale.source,
      confidence: round3(pageScale.confidence),
    },
    scaleConfidence: round3(pageScale.confidence),
    rooms: artifactRooms,
    walls: artifactWalls,
    notes: page.extract.notes,
    warnings: page.extract.warnings,
  }

  return { artifactPage, pageQuantities }
}

function buildArtifactOpening(o: ExtractOpening, conf: (s: DimensionSourceType) => number) {
  const annotatedWidthFt = parseDimensionToFeet(o.annotatedWidthText ?? '')
  const sourceType: DimensionSourceType = annotatedWidthFt != null ? 'annotated' : 'inferred'
  return {
    kind: o.kind,
    position: o.position,
    ...(annotatedWidthFt != null
      ? {
          widthFt: {
            value: round2(annotatedWidthFt),
            sourceType,
            confidence: round3(conf(sourceType)),
          },
        }
      : {}),
    ...(o.swing && o.swing !== null ? { swing: o.swing } : {}),
    ...(o.hostWallId ? { hostWallId: o.hostWallId } : {}),
  }
}

function sumOpeningWidthsFt(openings: ExtractOpening[]): number {
  let total = 0
  for (const o of openings) {
    const w = parseDimensionToFeet(o.annotatedWidthText ?? '')
    if (w != null && w > 0) total += w
    else {
      // Sensible defaults: door 3ft, window 3ft, opening 3ft.
      total += 3
    }
  }
  return total
}

function parseAnnotatedArea(text: string | null): number | null {
  if (!text) return null
  // Accept "210 SF" / "210 sf" / "210 SQFT" / "210 sq ft" / "210"
  const m = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*(?:SF|SQFT|SQ\s*FT)?\s*$/i)
  if (!m) return null
  const v = parseFloat(m[1]!)
  return isFinite(v) && v >= 0 ? v : null
}

function cleanTitleblock(
  tb: ExtractResponse['titleblock'],
): NonNullable<BlueprintArtifact['pages'][number]['titleblock']> {
  if (!tb) return {}
  const out: NonNullable<BlueprintArtifact['pages'][number]['titleblock']> = {}
  if (tb.projectName) out.projectName = tb.projectName
  if (tb.sheetNumber) out.sheetNumber = tb.sheetNumber
  if (tb.sheetTitle) out.sheetTitle = tb.sheetTitle
  if (tb.scaleText) out.scaleText = tb.scaleText
  if (typeof tb.northArrowDeg === 'number') out.northArrowDeg = tb.northArrowDeg
  if (tb.drawingDate) out.drawingDate = tb.drawingDate
  return out
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ─── Default dry-run mocks ─────────────────────────────────────────────────

function defaultDryRunClassify() {
  return {
    pages: [
      {
        pageIndex: 0,
        kind: 'floor_plan',
        confidence: 0.9,
        reasoning: 'dry-run mock floor plan',
      },
    ],
  }
}

function defaultDryRunExtract() {
  return {
    imageSize: { widthPx: 1000, heightPx: 800 },
    titleblock: {
      projectName: 'Dry-Run Project',
      sheetNumber: 'A-101',
      sheetTitle: 'Floor Plan (mock)',
      scaleText: '1/4" = 1\'-0"',
      northArrowDeg: 0,
      drawingDate: null,
    },
    dimensionStrings: ['12\'-0"', '10\'-0"'],
    rooms: [
      {
        id: 'r1',
        name: 'MOCK ROOM',
        polygon: [
          { x: 100, y: 100 },
          { x: 400, y: 100 },
          { x: 400, y: 350 },
          { x: 100, y: 350 },
        ],
        annotatedAreaText: null,
        annotatedPerimeterText: null,
        openings: [
          {
            kind: 'door',
            position: { x: 250, y: 100 },
            annotatedWidthText: '3\'-0"',
            swing: 'right',
            hostWallId: 'w1',
          },
        ],
      },
    ],
    walls: [
      {
        id: 'w1',
        start: { x: 100, y: 100 },
        end: { x: 400, y: 100 },
        thicknessIn: null,
        annotatedLengthText: '12\'-0"',
      },
    ],
    notes: ['dry-run mock'],
    warnings: [],
  }
}
