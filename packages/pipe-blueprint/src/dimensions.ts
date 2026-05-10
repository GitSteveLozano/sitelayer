/**
 * Parse architectural dimension strings to feet.
 *
 * Accepts forms like:
 *   - "12'"
 *   - "12'-0\""
 *   - "12' 0\""
 *   - "12'-6 1/2\""
 *   - "±29'"            (treat as approximate, value = 29)
 *   - "12.5'"
 *   - "12 ft"
 *   - "12'6\"BM"        (strip trailing labels)
 *
 * Returns null on anything we don't confidently recognise. We intentionally
 * keep this conservative — the prompt asks the model to transcribe
 * dimensions verbatim, so we'd rather mark a string unparseable than
 * misread it.
 */
export function parseDimensionToFeet(raw: string): number | null {
  if (!raw) return null

  // Strip leading approximate markers and whitespace.
  let s = raw
    .replace(/[±~≈]+/g, '') // ± ~ ≈
    .replace(/\s+/g, ' ')
    .trim()

  // Strip trailing labels like "BM" / "TYP" / "OC" — these are not part of the value.
  s = s.replace(/\s*(BM|TYP|O\.?C\.?|MIN|MAX)\s*$/i, '').trim()

  if (s.length === 0) return null

  // Pattern A: "12'" or "12'-X..." or "12' X..."
  // Pattern B: "12 ft" / "12.5 ft"
  // Pattern C: bare "12.5"  → reject (ambiguous units)

  // Decimal feet with explicit unit (12.5 ft / 12.5')
  const decFt = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:ft|')$/i)
  if (decFt) return parseFloat(decFt[1]!)

  // Feet + inches form: 12'-6 1/2" or 12' 6 1/2" or 12'6"
  const ftIn = s.match(/^(-?\d+)\s*'\s*(?:-)?\s*(?:(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*"?)?\s*$/)
  if (ftIn) {
    const feet = parseInt(ftIn[1]!, 10)
    const wholeIn = ftIn[2] ? parseFloat(ftIn[2]) : 0
    const fracNum = ftIn[3] ? parseInt(ftIn[3], 10) : 0
    const fracDen = ftIn[4] ? parseInt(ftIn[4], 10) : 1
    const fracIn = fracDen > 0 ? fracNum / fracDen : 0
    const totalIn = wholeIn + fracIn
    return feet + totalIn / 12
  }

  // Inches only form: e.g. 6" or 6 1/2"
  const inchesOnly = s.match(/^(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*"$/)
  if (inchesOnly) {
    const whole = parseFloat(inchesOnly[1]!)
    const fracNum = inchesOnly[2] ? parseInt(inchesOnly[2], 10) : 0
    const fracDen = inchesOnly[3] ? parseInt(inchesOnly[3], 10) : 1
    const frac = fracDen > 0 ? fracNum / fracDen : 0
    return (whole + frac) / 12
  }

  return null
}

/**
 * Parse a titleblock scaleText like "1/4\" = 1'-0\"" into the
 * "drawing-inches per real-foot" ratio. Returns the number of drawing
 * inches that represent one foot of real distance.
 *
 * Examples:
 *   '1/4" = 1\'-0"'  → 0.25 (one quarter inch on the sheet = 1 ft real)
 *   '1/8" = 1\'-0"'  → 0.125
 *   '3/16" = 1\'-0"' → 0.1875
 *   '1" = 20\''      → 1 / 20 = 0.05
 */
export function parseArchitecturalScale(scaleText: string): { drawingInchesPerFoot: number } | null {
  if (!scaleText) return null
  const s = scaleText.replace(/\s+/g, ' ').trim()

  // Form A: <fraction-or-decimal>" = 1'[-0"] (architectural)
  // Capture LHS inches expression.
  const archMatch = s.match(/^(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*"?\s*=\s*1\s*'(?:\s*-\s*0\s*")?$/)
  if (archMatch) {
    const lhs = parseFractionOrDecimal(archMatch[1]!)
    if (lhs && lhs > 0) return { drawingInchesPerFoot: lhs }
  }

  // Form B: 1" = N'  (engineering, e.g. site plans)
  const engMatch = s.match(/^1\s*"?\s*=\s*(\d+(?:\.\d+)?)\s*'$/)
  if (engMatch) {
    const realFeet = parseFloat(engMatch[1]!)
    if (realFeet > 0) return { drawingInchesPerFoot: 1 / realFeet }
  }

  return null
}

function parseFractionOrDecimal(s: string): number | null {
  const cleaned = s.replace(/\s+/g, '')
  if (cleaned.includes('/')) {
    const [num, den] = cleaned.split('/')
    const n = parseFloat(num!)
    const d = parseFloat(den!)
    if (isFinite(n) && isFinite(d) && d !== 0) return n / d
    return null
  }
  const v = parseFloat(cleaned)
  return isFinite(v) ? v : null
}

/**
 * Given an architectural scaleText and the DPI at which the page was
 * rendered for the model, return pixelsPerFoot.
 *
 * pixelsPerFoot = drawingInchesPerFoot × DPI
 */
export function pixelsPerFootFromScaleText(scaleText: string, renderedDpi: number): number | null {
  const parsed = parseArchitecturalScale(scaleText)
  if (!parsed) return null
  return parsed.drawingInchesPerFoot * renderedDpi
}

/**
 * Numerical match between a known dimension (in feet) and a candidate
 * dimension string from the sheet. Returns true if they match within
 * `relTol` (default 2%).
 */
export function dimensionMatches(knownFt: number, candidateRaw: string, relTol = 0.02): boolean {
  const c = parseDimensionToFeet(candidateRaw)
  if (c == null || knownFt <= 0) return false
  const rel = Math.abs(c - knownFt) / knownFt
  return rel <= relTol
}
