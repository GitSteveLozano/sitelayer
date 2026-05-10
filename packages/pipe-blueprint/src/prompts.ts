/**
 * Prompt strings for the blueprint-vision pipeline.
 *
 * Two passes:
 *   1. CLASSIFY — per-page sheet kind + confidence. Run on every page.
 *      Cheap; lets us skip emails/quotes/elevations/details/etc.
 *   2. EXTRACT — only invoked for pages classified `floor_plan` or
 *      `site_plan`. Produces room polygons (image-pixel coords),
 *      walls, openings, titleblock, scale, and a list of dimension
 *      strings the model read off the sheet verbatim.
 *
 * Honesty rules baked into the prompts (research/04 §5):
 *   - Coordinates are in *rendered image pixels* at the resolution the
 *     model received. We never ask the model for coordinates in feet.
 *   - The model does NOT compute areas/lengths in feet. It returns
 *     polygons + verbatim dimension strings; the pipeline does the
 *     scale + arithmetic deterministically.
 *   - If a dimension is not annotated on the sheet, the model returns
 *     `null` rather than guessing.
 *
 * Both prompts demand strict JSON output (no prose, no markdown fences).
 *
 * Bumping either prompt's wording counts as a contract-affecting
 * change — bump `PROMPT_VERSION` and the pipeline's semver in
 * `package.json` together.
 */

export const PROMPT_VERSION = 'blueprint-vision/v0.3' as const

/** Classify each page of the PDF. Strict JSON output. */
export const CLASSIFY_PROMPT = `You are inspecting an architectural / construction PDF, page by page.

For EACH page in the document, classify what kind of sheet it is. Some PDFs we receive are not drawings at all — they may be emails, quotes, contracts, schedules, or scans of letters. Your output MUST handle that case (kind: "non_drawing").

Return STRICT JSON matching exactly this schema (no prose, no markdown fences, no commentary):

{
  "pages": [
    {
      "pageIndex": 0,
      "kind": "floor_plan" | "elevation" | "section" | "site_plan" | "detail" | "schedule" | "titleblock_only" | "non_drawing",
      "confidence": 0.0,
      "reasoning": "one short sentence"
    }
  ]
}

Definitions:
- floor_plan: orthographic plan view of an interior floor showing rooms, walls, doors, windows.
- elevation: orthographic exterior view of one face of the building.
- section: orthographic cut through the building.
- site_plan: plan view of the lot / site, showing the building footprint and surroundings.
- detail: a callout zoomed-in detail (often at a different scale than the main sheet). Includes structural details, scaffolding details, connection details, etc.
- schedule: a tabular schedule of doors/windows/finishes/equipment.
- titleblock_only: the page contains nothing but a titleblock + border — no drawing.
- non_drawing: an email, letter, quote, contract, or any document that isn't an architectural/construction drawing.

Rules:
- "pageIndex" is 0-based.
- "confidence" is in [0, 1]. Be honest. If a page is genuinely ambiguous (a scaffolding plan with details — both floor_plan-ish and detail-ish), pick the dominant kind and lower the confidence.
- "reasoning" is one sentence, ≤ 25 words. No markdown, no quotes inside.
- Output one JSON object per call covering ALL pages in the document. Do not output anything except the JSON.
- If you cannot read a page at all (blank, too low resolution), use "non_drawing" with low confidence and explain in reasoning.
`

/**
 * Extract rooms / walls / openings / titleblock / scale / dimension
 * strings. Run only on pages already classified as floor_plan or
 * site_plan. Strict JSON output.
 *
 * The prompt is designed so we can compute quantities deterministically
 * without trusting the model's arithmetic. The model returns polygons
 * in image-pixel coords + verbatim dimension strings; we do the
 * scale + shoelace ourselves.
 */
export const EXTRACT_PROMPT = `You are extracting takeoff geometry from a single floor-plan or site-plan page.

CRITICAL RULES:
- Coordinates ("x", "y") are in IMAGE-PIXEL units, measured on the rendered page image you received. Origin is top-left, x increases right, y increases down.
- Do NOT compute areas, lengths, or perimeters in feet. We compute those deterministically from your polygons + a calibrated scale. You only return geometry in pixels and dimension strings read off the sheet.
- If a dimension string is not printed on the sheet, return null. Do NOT guess or interpolate.
- "dimensionStrings" is a list of EVERY dimension annotation you can read on the sheet, transcribed verbatim (preserve quotes, hyphens, fractions, ± signs, "BM" suffixes, etc.).

Return STRICT JSON matching exactly this schema (no prose, no markdown fences):

{
  "imageSize":   { "widthPx": 0, "heightPx": 0 },
  "titleblock":  null | {
    "projectName":  null | "string",
    "sheetNumber":  null | "string",
    "sheetTitle":   null | "string",
    "scaleText":    null | "1/4\\" = 1'-0\\"",
    "northArrowDeg": null | 0,
    "drawingDate":  null | "ISO-8601 date if printed"
  },
  "dimensionStrings": ["12' 6 1/2\\"", "±29'", "1'-6\\""],
  "rooms": [
    {
      "id": "r1",
      "name": null | "MASTER BEDROOM",
      "polygon": [
        { "x": 100, "y": 200 },
        { "x": 100, "y": 400 },
        { "x": 300, "y": 400 },
        { "x": 300, "y": 200 }
      ],
      "annotatedAreaText":      null | "210 SF",
      "annotatedPerimeterText": null | "58'",
      "openings": [
        {
          "kind": "door" | "window" | "opening",
          "position":  { "x": 150, "y": 200 },
          "annotatedWidthText": null | "3'-0\\"",
          "swing": null | "left" | "right" | "none",
          "hostWallId": null | "w3"
        }
      ]
    }
  ],
  "walls": [
    {
      "id": "w1",
      "start": { "x": 100, "y": 200 },
      "end":   { "x": 300, "y": 200 },
      "thicknessIn":         null | 6,
      "annotatedLengthText": null | "20'-0\\""
    }
  ],
  "notes":    ["any plan notes the estimator should see"],
  "warnings": ["scale bar unreadable", "hand-drawn detected"]
}

Rules:
- Polygons MUST be closed (first vertex == last vertex implied; do NOT repeat the first vertex).
- Vertices in clockwise or counter-clockwise order; we'll handle either.
- Every room has at least 3 polygon vertices.
- "id" values must be unique within their array.
- If you can identify the host wall for an opening, fill "hostWallId"; otherwise null.
- "thicknessIn" is the wall thickness in inches if labeled; otherwise null. Do NOT measure it from the image — only return it if printed.
- "scaleText" is verbatim from the titleblock if present (e.g. "1/4\\" = 1'-0\\""). Do NOT compute pixelsPerFoot — we do that.
- If the sheet has multiple scales (plan view + detail view), put the dominant plan-view scaleText in titleblock.scaleText and add a warning "multi_scale_sheet".
- If the page turns out to be NOT a floor/site plan, return empty rooms/walls and add warning "not_a_plan_sheet".
- Emit ONLY the JSON object. No prose. No code fences.
`
