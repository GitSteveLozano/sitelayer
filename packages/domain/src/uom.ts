/**
 * Typed unit-of-measure (UoM) + conversion + dimensional-guard layer.
 *
 * Takeoff Deep Dive (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §4 "Units", the top
 * canonical silent-error class). Units are free text everywhere in sitelayer —
 * `takeoff_measurements.unit`, `service_item_assembly_components.unit`,
 * `service_items.unit`, estimate lines — with NO enum, NO conversion table, and
 * NO dimensional guard. The assembly-explode notes call this out directly:
 * "measurement-in-sqft, component-per-lf → dimensionally-incorrect output,
 * silently." Multiplying a square-foot measurement by a per-linear-foot
 * component quantity produces a number with no physical meaning, and nothing
 * catches it.
 *
 * This module is the TYPED LAYER that sits ABOVE the pervasive free text. It is
 * intentionally ADDITIVE and non-destructive:
 *
 *   - `normalizeUnit(freeText)` maps the messy real-world spellings ('SF',
 *     'sq ft', 'square feet', 'SQFT') onto a small canonical enum, or returns
 *     `null` when the text is unrecognised (so existing free-text rows are
 *     simply "unknown", never rejected).
 *   - every canonical unit declares a `dimension` (area / length / count /
 *     volume) and a `factor` to that dimension's base unit, giving a single
 *     conversion table (SY = 9 SF, CY = 27 CF, SQUARE = 100 SF, YD = 3 FT, …).
 *   - `convert(qty, from, to)` converts within a dimension and refuses across
 *     dimensions; `assertCompatible(a, b)` is the dimensional guard.
 *
 * Pure, dependency-free, deterministic — same discipline as the rest of
 * @sitelayer/domain. No DB, no I/O, no clock.
 *
 * FOLLOW-UP (flagged, NOT in this slice): a typed `unit_canonical` column plus
 * an expand/backfill/contract migration of the existing free-text columns. The
 * free text is pervasive and a hard rejection mid-flight would break live rows,
 * so this slice ships only the typed layer + a NON-FATAL guard. See the
 * deep-dive §6 item "UoM migration".
 */

/** The four physical dimensions a takeoff unit can measure. */
export type UnitDimension = 'area' | 'length' | 'count' | 'volume'

export const UNIT_DIMENSIONS: readonly UnitDimension[] = ['area', 'length', 'count', 'volume']

/**
 * The canonical unit enum. Deliberately small — the units that actually appear
 * in construction takeoff (the L&A seed, PlanSwift, Steve's pricing sheets):
 *
 *   length:  IN, FT, YD, LF (LF is "linear foot" — same dimension/factor as FT,
 *            kept distinct because estimators write both and the label matters)
 *   area:    SQIN, SQFT (a.k.a SF), SQYD (SY), SQUARE (roofing 100 SF)
 *   volume:  CUFT (CF), CUYD (CY)
 *   count:   EA (each), plus job-ish countables that are dimensionless-per-item
 *            (JOB, HR are modeled as `count` so they normalize but never convert
 *            into a physical dimension — see the `convert` guard).
 *
 * Base unit per dimension (factor === 1): length=FT, area=SQFT, volume=CUFT,
 * count=EA. Every other unit's `factor` is "how many base units one of me is".
 */
export type CanonicalUnit =
  | 'IN'
  | 'FT'
  | 'YD'
  | 'LF'
  | 'SQIN'
  | 'SQFT'
  | 'SQYD'
  | 'SQUARE'
  | 'CUFT'
  | 'CUYD'
  | 'EA'
  | 'JOB'
  | 'HR'

export interface UnitDef {
  /** Canonical key (also the display token). */
  canonical: CanonicalUnit
  dimension: UnitDimension
  /**
   * How many of this dimension's BASE unit are in one of this unit.
   * e.g. SQYD.factor = 9 because 1 square yard = 9 square feet (base = SQFT).
   * The base unit of each dimension has factor 1.
   */
  factor: number
  /** Human label for warnings / UI. */
  label: string
}

/**
 * The registry: canonical unit → definition. Conversion within a dimension is
 * `qty * from.factor / to.factor`. The factors encode the standard table:
 *   YD = 3 FT, SQYD = 9 SQFT, SQUARE = 100 SQFT, CUYD = 27 CUFT, etc.
 */
export const UNIT_REGISTRY: Readonly<Record<CanonicalUnit, UnitDef>> = {
  // length (base FT)
  IN: { canonical: 'IN', dimension: 'length', factor: 1 / 12, label: 'inch' },
  FT: { canonical: 'FT', dimension: 'length', factor: 1, label: 'foot' },
  LF: { canonical: 'LF', dimension: 'length', factor: 1, label: 'linear foot' },
  YD: { canonical: 'YD', dimension: 'length', factor: 3, label: 'yard' },
  // area (base SQFT)
  SQIN: { canonical: 'SQIN', dimension: 'area', factor: 1 / 144, label: 'square inch' },
  SQFT: { canonical: 'SQFT', dimension: 'area', factor: 1, label: 'square foot' },
  SQYD: { canonical: 'SQYD', dimension: 'area', factor: 9, label: 'square yard' },
  SQUARE: { canonical: 'SQUARE', dimension: 'area', factor: 100, label: 'roofing square (100 SF)' },
  // volume (base CUFT)
  CUFT: { canonical: 'CUFT', dimension: 'volume', factor: 1, label: 'cubic foot' },
  CUYD: { canonical: 'CUYD', dimension: 'volume', factor: 27, label: 'cubic yard' },
  // count (base EA). JOB/HR are countable units that normalize but never
  // convert into a physical dimension (see convert()).
  EA: { canonical: 'EA', dimension: 'count', factor: 1, label: 'each' },
  JOB: { canonical: 'JOB', dimension: 'count', factor: 1, label: 'job' },
  HR: { canonical: 'HR', dimension: 'count', factor: 1, label: 'hour' },
}

export const CANONICAL_UNITS: readonly CanonicalUnit[] = Object.keys(UNIT_REGISTRY) as CanonicalUnit[]

/**
 * The alias table: the messy free-text spellings estimators actually type,
 * mapped to a canonical unit. Keys are MATCHED CASE-INSENSITIVELY after
 * trimming and collapsing internal whitespace + dropping '.' and a single
 * trailing plural 's' (so 'sq. ft.', 'Sq Ft', 'square feet', 'SQFTs' all hit
 * the same entry). The canonical tokens themselves are matched too (a canonical
 * unit always normalizes to itself).
 *
 * Anything NOT in here returns `null` from normalizeUnit — the explicit
 * "unknown / leave as free text" signal the non-fatal guard relies on.
 */
const UNIT_ALIASES: Readonly<Record<string, CanonicalUnit>> = {
  // length
  in: 'IN',
  inch: 'IN',
  inche: 'IN', // 'inches' -> trailing-s stripped
  ft: 'FT',
  foot: 'FT',
  feet: 'FT',
  lf: 'LF',
  'lin ft': 'LF',
  'linear ft': 'LF',
  'linear foot': 'LF',
  'linear feet': 'LF',
  lnft: 'LF',
  yd: 'YD',
  yard: 'YD',
  // area
  sqin: 'SQIN',
  'sq in': 'SQIN',
  'square inch': 'SQIN',
  sf: 'SQFT',
  sqft: 'SQFT',
  'sq ft': 'SQFT',
  'square foot': 'SQFT',
  'square feet': 'SQFT',
  sy: 'SQYD',
  sqyd: 'SQYD',
  'sq yd': 'SQYD',
  'square yard': 'SQYD',
  square: 'SQUARE',
  sq: 'SQUARE',
  squares: 'SQUARE',
  // volume
  cf: 'CUFT',
  cuft: 'CUFT',
  'cu ft': 'CUFT',
  'cubic foot': 'CUFT',
  'cubic feet': 'CUFT',
  cy: 'CUYD',
  cuyd: 'CUYD',
  'cu yd': 'CUYD',
  'cubic yard': 'CUYD',
  // count
  ea: 'EA',
  each: 'EA',
  unit: 'EA',
  pc: 'EA',
  piece: 'EA',
  count: 'EA',
  ct: 'EA',
  job: 'JOB',
  ls: 'JOB',
  'lump sum': 'JOB',
  hr: 'HR',
  hour: 'HR',
  hrs: 'HR',
}

/**
 * Canonicalise a free-text key for alias lookup: lowercase, trim, drop periods,
 * and collapse internal whitespace to a single space. 'Sq. Ft.' -> 'sq ft'.
 * Returns '' for empty. Does NOT strip a trailing plural 's' — normalizeUnit
 * tries this exact form first (so short codes like 'ls' survive) and the
 * singularized form second.
 */
function canonicalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Normalize a free-text unit string to a canonical unit, or `null` when the
 * text is unrecognised. NEVER throws. A null result is the explicit "unknown,
 * leave as free text" signal — callers (e.g. the explode guard) treat null as
 * "can't reason about this unit" and silently skip the dimensional check rather
 * than rejecting the row.
 */
export function normalizeUnit(freeText: string | null | undefined): CanonicalUnit | null {
  if (freeText === null || freeText === undefined) return null
  const key = canonicalizeKey(freeText)
  if (key === '') return null
  // A canonical token (already uppercase) normalizes to itself.
  const upper = freeText.trim().toUpperCase()
  if (Object.prototype.hasOwnProperty.call(UNIT_REGISTRY, upper)) return upper as CanonicalUnit
  // Try the exact cleaned form first (so short codes like 'ls' survive), then a
  // singularized form ('squares' -> 'square', 'inches' -> 'inche') for plurals.
  const exact = UNIT_ALIASES[key]
  if (exact) return exact
  if (key.length > 1 && key.endsWith('s')) {
    const singular = UNIT_ALIASES[key.slice(0, -1)]
    if (singular) return singular
  }
  return null
}

/** Look up the registry def for a canonical unit. */
export function unitDef(unit: CanonicalUnit): UnitDef {
  return UNIT_REGISTRY[unit]
}

/**
 * The dimension of a free-text or canonical unit, or `null` when unrecognised.
 * Convenience over `normalizeUnit` + `unitDef`.
 */
export function unitDimension(unit: string | CanonicalUnit | null | undefined): UnitDimension | null {
  const canonical = typeof unit === 'string' ? normalizeUnit(unit) : (unit ?? null)
  if (canonical === null) return null
  return UNIT_REGISTRY[canonical].dimension
}

/** The error a hard conversion / compatibility check raises. */
export class UnitDimensionError extends Error {
  readonly from: CanonicalUnit
  readonly to: CanonicalUnit
  readonly fromDimension: UnitDimension
  readonly toDimension: UnitDimension
  constructor(from: CanonicalUnit, to: CanonicalUnit) {
    const fromDef = UNIT_REGISTRY[from]
    const toDef = UNIT_REGISTRY[to]
    super(
      `Incompatible units: ${from} (${fromDef.dimension}) cannot convert to ${to} (${toDef.dimension}) — different physical dimension`,
    )
    this.name = 'UnitDimensionError'
    this.from = from
    this.to = to
    this.fromDimension = fromDef.dimension
    this.toDimension = toDef.dimension
  }
}

/**
 * Are two canonical units in the same physical dimension (and therefore
 * convertible / safe to multiply against)? Count-dimension units (EA/JOB/HR) are
 * same-dimension with each other but do not carry a real conversion factor
 * between unlike countables — see {@link convert}.
 */
export function areCompatible(a: CanonicalUnit, b: CanonicalUnit): boolean {
  return UNIT_REGISTRY[a].dimension === UNIT_REGISTRY[b].dimension
}

/**
 * The dimensional guard. Returns `{ ok: true }` when `a` and `b` are in the
 * same dimension (or either is unrecognised — see note), and a structured
 * error otherwise. NEVER throws by default so callers can surface a non-fatal
 * warning; pass `{ throwOnError: true }` to make it throw a {@link
 * UnitDimensionError} (the strict-write path the migration follow-up will use).
 *
 * Inputs may be free text or canonical. When EITHER side fails to normalize
 * (unknown free text), the result is `{ ok: true, recognized: false }` — we
 * cannot prove an incompatibility, so the guard MUST NOT fire (the whole point
 * of the additive, free-text-tolerant design). Only two RECOGNISED units of
 * DIFFERENT dimensions produce `{ ok: false }`.
 */
export interface CompatibilityResult {
  ok: boolean
  /** True only when BOTH inputs normalized to a known canonical unit. */
  recognized: boolean
  a: CanonicalUnit | null
  b: CanonicalUnit | null
  /** Populated when ok === false. */
  message?: string
  fromDimension?: UnitDimension
  toDimension?: UnitDimension
}

export function assertCompatible(
  a: string | CanonicalUnit | null | undefined,
  b: string | CanonicalUnit | null | undefined,
  options: { throwOnError?: boolean } = {},
): CompatibilityResult {
  const ca = typeof a === 'string' ? normalizeUnit(a) : (a ?? null)
  const cb = typeof b === 'string' ? normalizeUnit(b) : (b ?? null)

  // Unknown on either side: cannot prove incompatibility -> do not fire.
  if (ca === null || cb === null) {
    return { ok: true, recognized: false, a: ca, b: cb }
  }

  if (areCompatible(ca, cb)) {
    return { ok: true, recognized: true, a: ca, b: cb }
  }

  const message = new UnitDimensionError(ca, cb).message
  if (options.throwOnError) {
    throw new UnitDimensionError(ca, cb)
  }
  return {
    ok: false,
    recognized: true,
    a: ca,
    b: cb,
    message,
    fromDimension: UNIT_REGISTRY[ca].dimension,
    toDimension: UNIT_REGISTRY[cb].dimension,
  }
}

/**
 * Convert a quantity from one canonical unit to another within the same
 * dimension. Throws {@link UnitDimensionError} across dimensions.
 *
 * Count-dimension caveat: converting between two DIFFERENT count units
 * (e.g. EA -> JOB, or EA -> HR) is meaningless (an "each" is not an "hour"),
 * so convert() throws for unlike count units even though they share the `count`
 * dimension. Identity count conversions (EA -> EA) pass through as the quantity
 * unchanged.
 *
 * `from`/`to` may be free text or canonical; unrecognised free text throws a
 * plain Error (the caller asked for a real conversion and gave us garbage).
 */
export function convert(qty: number, from: string | CanonicalUnit, to: string | CanonicalUnit): number {
  const cf = normalizeUnit(from)
  const ct = normalizeUnit(to)
  if (cf === null) throw new Error(`convert: unrecognised source unit ${JSON.stringify(from)}`)
  if (ct === null) throw new Error(`convert: unrecognised target unit ${JSON.stringify(to)}`)
  if (!Number.isFinite(qty)) throw new Error(`convert: non-finite quantity ${qty}`)

  const fromDef = UNIT_REGISTRY[cf]
  const toDef = UNIT_REGISTRY[ct]
  if (fromDef.dimension !== toDef.dimension) {
    throw new UnitDimensionError(cf, ct)
  }
  // Identity passes through (covers EA->EA, FT->FT, etc.).
  if (cf === ct) return qty
  // Unlike count units have no physical conversion factor between them.
  if (fromDef.dimension === 'count') {
    throw new Error(
      `convert: cannot convert between unlike count units ${cf} and ${ct} — countables are not interconvertible`,
    )
  }
  // Same-dimension physical conversion via the shared base unit.
  return (qty * fromDef.factor) / toDef.factor
}
