// Auto-detect the drawing scale from a sheet's title block.
//
// The hard part of "auto-scale" is reading the scale notation off the plan. The
// PDFium renderer can already extract a page's text (getPageText); this scans
// that text for an architectural ("1/4\" = 1'-0\"") or engineering ("1\" = 20'")
// scale and parses it. The notation parsing mirrors
// packages/pipe-blueprint/src/dimensions.ts:parseArchitecturalScale -- duplicated
// (not imported) so no Node-only pipe-blueprint code is pulled into the web
// bundle. Detection is surfaced to the estimator as a read-only hint; it does
// NOT change measurement quantities (the board-space -> world calibration
// pipeline is a separate, deliberate piece of work).

function parseFractionOrDecimal(raw: string): number | null {
  const s = raw.trim()
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)
  if (frac) {
    const num = parseFloat(frac[1]!)
    const den = parseFloat(frac[2]!)
    if (den > 0) return num / den
  }
  const dec = Number(s)
  return Number.isFinite(dec) ? dec : null
}

/**
 * Parse a single scale string into drawing-inches per real foot. Returns null
 * when the string isn't a recognized scale notation.
 *
 * - architectural: `<frac-or-decimal>" = 1'[-0"]` -> that fraction (e.g. 0.25)
 * - engineering: `1" = N'` -> 1/N
 */
export function parseScaleNotation(scaleText: string): { drawingInchesPerFoot: number } | null {
  const s = scaleText.trim().replace(/\s+/g, ' ')
  const arch = s.match(/^(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*"?\s*=\s*1\s*'(?:\s*-?\s*0\s*")?$/)
  if (arch) {
    const lhs = parseFractionOrDecimal(arch[1]!)
    if (lhs && lhs > 0) return { drawingInchesPerFoot: lhs }
  }
  const eng = s.match(/^1\s*"?\s*=\s*(\d+(?:\.\d+)?)\s*'$/)
  if (eng) {
    const realFeet = parseFloat(eng[1]!)
    if (realFeet > 0) return { drawingInchesPerFoot: 1 / realFeet }
  }
  return null
}

export interface DetectedScale {
  /** The matched notation, cleaned up for display, e.g. `1/4" = 1'-0"`. */
  label: string
  /** Drawing inches per real foot (e.g. 0.25 for 1/4" = 1'-0"). */
  drawingInchesPerFoot: number
  /** True when found adjacent to a "SCALE" label (higher confidence). */
  labeled: boolean
}

// Candidate scale notations anywhere in the blob: architectural `x" = 1'-0"` and
// engineering `1" = N'`. Kept loose (the leading `=` side may have odd spacing
// in extracted text); each candidate is validated by parseScaleNotation.
const ARCH_RE = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*"?\s*=\s*1\s*'(?:\s*-?\s*0?\s*")?/g
const ENG_RE = /1\s*"?\s*=\s*(\d+(?:\.\d+)?)\s*'/g

// PDFs vary on inch/foot marks: primes (U+2032/U+2033) and curly quotes
// (U+2018/2019/201C/201D) normalize to straight ' and ", and non-breaking spaces
// (U+00A0) to a regular space, before scanning.
function normalize(pageText: string): string {
  return pageText
    .replace(/[“”″]/g, '"')
    .replace(/[‘’′]/g, "'")
    .replace(/\u00a0/g, ' ')
}

/**
 * Scan extracted page text for a drawing scale. Prefers a notation sitting next
 * to the word "SCALE" (title-block convention); otherwise returns the first
 * parseable notation found. Returns null when none is present.
 */
export function detectSheetScale(pageText: string): DetectedScale | null {
  if (!pageText) return null
  const text = normalize(pageText)

  const candidates: Array<{ raw: string; index: number }> = []
  for (const re of [ARCH_RE, ENG_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      candidates.push({ raw: m[0], index: m.index })
      if (m.index === re.lastIndex) re.lastIndex += 1 // guard against zero-width
    }
  }
  if (candidates.length === 0) return null

  const scaleLabelPositions: number[] = []
  const labelRe = /scale/gi
  let lm: RegExpExecArray | null
  while ((lm = labelRe.exec(text)) !== null) scaleLabelPositions.push(lm.index)

  const nearLabel = (index: number) => scaleLabelPositions.some((p) => index - p >= 0 && index - p <= 24)

  // Prefer a labeled candidate, then earliest position.
  candidates.sort((a, b) => {
    const la = nearLabel(a.index) ? 0 : 1
    const lb = nearLabel(b.index) ? 0 : 1
    return la !== lb ? la - lb : a.index - b.index
  })

  for (const c of candidates) {
    const parsed = parseScaleNotation(c.raw.trim())
    if (parsed) {
      return {
        label: c.raw.trim().replace(/\s+/g, ' '),
        drawingInchesPerFoot: parsed.drawingInchesPerFoot,
        labeled: nearLabel(c.index),
      }
    }
  }
  return null
}
