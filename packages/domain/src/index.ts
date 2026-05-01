export type WorkflowStage = 'foundation' | 'takeoff' | 'field' | 'sync' | 'analytics' | 'extensions'

export interface TenantTemplate {
  slug: string
  name: string
  description: string
}

export interface DivisionTemplate {
  code: string
  name: string
  sortOrder: number
}

export interface ServiceItemTemplate {
  code: string
  name: string
  category: 'measurable' | 'accounting'
  unit: 'sqft' | 'lf' | 'ea' | 'hr' | 'job'
  defaultRate: number | null
  /**
   * Default division this service item is curated for. Used to seed
   * `service_item_divisions` so the takeoff catalog enforcement layer has at
   * least one allowed division per item out of the box. See migration
   * `011_service_item_xref_backfill.sql`.
   */
  defaultDivisionCode: string
}

export interface CostInputs {
  laborCost: number
  materialCost: number
  subCost: number
}

export interface MarginResult {
  revenue: number
  cost: number
  profit: number
  margin: number
}

export interface BonusTier {
  minMargin: number
  payoutPercent: number
}

export interface TakeoffPoint {
  x: number
  y: number
}

export interface PolygonGeometry {
  kind: 'polygon'
  points: TakeoffPoint[]
  sheet_scale?: number | null
  calibration_length?: number | null
  calibration_unit?: string | null
}

export interface LinealGeometry {
  kind: 'lineal'
  points: TakeoffPoint[]
  sheet_scale?: number | null
  calibration_length?: number | null
  calibration_unit?: string | null
}

export interface VolumeGeometry {
  kind: 'volume'
  length: number
  width: number
  height: number
  unit?: string | null
}

export type TakeoffGeometry = PolygonGeometry | LinealGeometry | VolumeGeometry

export interface ProductivitySample {
  quantity: number
  hours: number
}

export interface ProductivityResult {
  samples: number
  total_quantity: number
  total_hours: number
  avg: number
  p50: number | null
  p90: number | null
}

export const WORKFLOW_STAGES: WorkflowStage[] = ['foundation', 'takeoff', 'field', 'sync', 'analytics', 'extensions']

export const LA_TEMPLATE: TenantTemplate = {
  slug: 'la-operations',
  name: 'L&A Operations',
  description: 'Seed template for the original customer workflow.',
}

export const LA_DIVISIONS: DivisionTemplate[] = [
  { code: 'D1', name: 'Stucco', sortOrder: 1 },
  { code: 'D2', name: 'Masonry', sortOrder: 2 },
  { code: 'D3', name: 'Siding', sortOrder: 3 },
  { code: 'D4', name: 'EIFS', sortOrder: 4 },
  { code: 'D5', name: 'Paper and Wire', sortOrder: 5 },
  { code: 'D6', name: 'Snow Removal', sortOrder: 6 },
  { code: 'D7', name: 'Warranty', sortOrder: 7 },
  { code: 'D8', name: 'Overhead', sortOrder: 8 },
  { code: 'D9', name: 'Scaffolding', sortOrder: 9 },
]

export const LA_SERVICE_ITEMS: ServiceItemTemplate[] = [
  // EIFS system stack (D4)
  { code: 'EPS', name: 'EPS', category: 'measurable', unit: 'sqft', defaultRate: 4, defaultDivisionCode: 'D4' },
  {
    code: 'Basecoat',
    name: 'Basecoat',
    category: 'measurable',
    unit: 'sqft',
    defaultRate: 2.5,
    defaultDivisionCode: 'D4',
  },
  {
    code: 'Finish Coat',
    name: 'Finish Coat',
    category: 'measurable',
    unit: 'sqft',
    defaultRate: 3.5,
    defaultDivisionCode: 'D4',
  },
  // Paper and Wire envelope work (D5)
  {
    code: 'Air Barrier',
    name: 'Air Barrier',
    category: 'measurable',
    unit: 'sqft',
    defaultRate: 1.8,
    defaultDivisionCode: 'D5',
  },
  {
    code: 'Envelope Seal',
    name: 'Envelope Seal',
    category: 'measurable',
    unit: 'lf',
    defaultRate: 2,
    defaultDivisionCode: 'D5',
  },
  // Siding (D3)
  {
    code: 'Cementboard',
    name: 'Cementboard',
    category: 'measurable',
    unit: 'sqft',
    defaultRate: 3.25,
    defaultDivisionCode: 'D3',
  },
  // Masonry (D2)
  {
    code: 'Cultured Stone',
    name: 'Cultured Stone',
    category: 'measurable',
    unit: 'sqft',
    defaultRate: 12,
    defaultDivisionCode: 'D2',
  },
  {
    code: 'Caulking',
    name: 'Caulking',
    category: 'measurable',
    unit: 'lf',
    defaultRate: 4.5,
    defaultDivisionCode: 'D2',
  },
  {
    code: 'Flashing',
    name: 'Flashing',
    category: 'measurable',
    unit: 'lf',
    defaultRate: 8,
    defaultDivisionCode: 'D2',
  },
  // Accounting line items live under Overhead (D8) by default — they are not
  // crew labor but still need to land in some division so rollups don't drop
  // them.
  {
    code: 'Change Order',
    name: 'Change Order',
    category: 'accounting',
    unit: 'job',
    defaultRate: null,
    defaultDivisionCode: 'D8',
  },
  {
    code: 'Deposit',
    name: 'Deposit',
    category: 'accounting',
    unit: 'job',
    defaultRate: null,
    defaultDivisionCode: 'D8',
  },
  {
    code: 'Holdback',
    name: 'Holdback',
    category: 'accounting',
    unit: 'job',
    defaultRate: null,
    defaultDivisionCode: 'D8',
  },
]

export const DEFAULT_BONUS_RULE = {
  basis: 'margin',
  threshold: 0.15,
  tiers: [
    { minMargin: 0.15, payoutPercent: 0.04 },
    { minMargin: 0.2, payoutPercent: 0.09 },
    { minMargin: 0.25, payoutPercent: 0.14 },
    { minMargin: 0.3, payoutPercent: 0.19 },
  ],
} as const

export function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 2,
  }).format(value)
}

/**
 * Sum a list of money-like values (numeric strings from Postgres, or
 * already-numeric JS values) with no floating-point drift. Internally
 * accumulates integer cents — safe up to ~$90 trillion. Returns the
 * sum as a fixed-decimal string suitable for writing back to a
 * Postgres `numeric(12,2)` column or wire JSON.
 *
 * Why this exists: `[0.1, 0.2, 0.3].reduce((s, v) => s + Number(v), 0)`
 * is `0.6000000000000001` in JS. Sums of estimate lines, billing run
 * lines, and rental amounts hit this every time. Per-value reads are
 * fine (any 2-decimal value < 2^45 round-trips exactly through
 * IEEE-754); only the running sum drifts.
 *
 * Inputs that are NaN, infinite, undefined, or non-numeric strings are
 * treated as zero — the caller's responsibility to pre-validate if
 * those should be rejected. Returns '0.00' for an empty list.
 */
export function sumMoney(values: ReadonlyArray<number | string | null | undefined>): string {
  let cents = 0n
  for (const value of values) {
    if (value === null || value === undefined) continue
    cents += moneyToCents(value)
  }
  const sign = cents < 0n ? '-' : ''
  const abs = cents < 0n ? -cents : cents
  const dollars = abs / 100n
  const remainder = abs % 100n
  return `${sign}${dollars.toString()}.${remainder.toString().padStart(2, '0')}`
}

/**
 * Parse a single money-like value to integer cents. Handles the
 * Postgres numeric(12,2) string shape (e.g. "1234.56", "-7.89") and
 * JS numbers. Anything that doesn't parse cleanly returns 0n.
 */
function moneyToCents(value: number | string): bigint {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(2) : '0') : value.trim()
  // Match optional sign + integer + optional fractional part. Reject
  // exponent notation since Postgres numeric never emits it for the
  // column types we use here.
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return 0n
  const [, sign, intPart, fracPart = ''] = match
  // Round to 2 decimal places via banker-ish floor toward zero of the
  // 3rd digit. Using truncation here (not rounding) matches Postgres
  // numeric(12,2) implicit cast behaviour for trailing precision.
  const cents2 = (fracPart + '00').slice(0, 2)
  const n = BigInt(intPart!) * 100n + BigInt(cents2)
  return sign === '-' ? -n : n
}

export function calculateProjectCost(inputs: CostInputs): number {
  return roundMoney(inputs.laborCost + inputs.materialCost + inputs.subCost)
}

export function calculateMargin(inputs: { revenue: number; cost: number }): MarginResult {
  const profit = roundMoney(inputs.revenue - inputs.cost)
  const margin = inputs.revenue === 0 ? 0 : roundPercent(profit / inputs.revenue)
  return {
    revenue: roundMoney(inputs.revenue),
    cost: roundMoney(inputs.cost),
    profit,
    margin,
  }
}

export type BidVsScopeStatus = 'ok' | 'warn' | 'mismatch'

export interface BidVsScopeComparison {
  bid_total: number
  scope_total: number
  delta: number
  delta_pct: number
  status: BidVsScopeStatus
}

/**
 * Compare the contract bid (`bidTotal`, e.g. a single $/sqft figure multiplied
 * out by the quoted quantity) against the sum of scope line amounts
 * (`scopeTotal`, e.g. EPS + Basecoat + ...). Returns the signed delta
 * (bid minus scope, positive when the bid is higher than the sum of scope
 * rates), the absolute percentage of the bid that the delta represents, and a
 * status bucket used by the UI to warn the estimator.
 *
 * Thresholds per the product brief:
 *   |delta| <= 1% of bid  -> ok
 *   1% <  |delta| <= 5%   -> warn
 *   |delta| >  5%          -> mismatch
 *
 * A zero bid with a zero scope is reported as `ok`/0%. A zero bid with any
 * non-zero scope is reported as `mismatch`/100% so the caller cannot silently
 * miss an unreconciled scope.
 */
export function compareBidVsScope(inputs: { bidTotal: number; scopeTotal: number }): BidVsScopeComparison {
  const bidTotal = Number.isFinite(inputs.bidTotal) ? Number(inputs.bidTotal) : 0
  const scopeTotal = Number.isFinite(inputs.scopeTotal) ? Number(inputs.scopeTotal) : 0
  const delta = roundMoney(bidTotal - scopeTotal)
  const denominator = Math.abs(bidTotal)
  const deltaPct = denominator === 0 ? (delta === 0 ? 0 : 1) : roundPercent(Math.abs(delta) / denominator)
  let status: BidVsScopeStatus
  if (deltaPct <= 0.01) {
    status = 'ok'
  } else if (deltaPct <= 0.05) {
    status = 'warn'
  } else {
    status = 'mismatch'
  }
  return {
    bid_total: roundMoney(bidTotal),
    scope_total: roundMoney(scopeTotal),
    delta,
    delta_pct: deltaPct,
    status,
  }
}

export function calculateBonusPayout(
  margin: number,
  bonusPool: number,
  tiers: readonly BonusTier[],
): { eligible: boolean; payoutPercent: number; payout: number } {
  const eligibleTier = [...tiers]
    .filter((tier) => margin >= tier.minMargin)
    .sort((left, right) => right.minMargin - left.minMargin)[0]

  if (!eligibleTier) {
    return { eligible: false, payoutPercent: 0, payout: 0 }
  }

  const payout = roundMoney(bonusPool * eligibleTier.payoutPercent)
  return {
    eligible: true,
    payoutPercent: eligibleTier.payoutPercent,
    payout,
  }
}

export interface BonusScenarioResult {
  margin: number
  profit: number
  eligible: boolean
  payout_percent: number
  payout: number
  next_tier_threshold: number | null
  revenue_to_next_tier: number | null
}

/**
 * Simulate a full what-if bonus scenario given a candidate revenue, cost,
 * bonus pool and the tier schedule. In addition to what `calculateBonusPayout`
 * returns, this helper computes:
 *
 *   - `next_tier_threshold`: the minimum margin needed to reach the next tier
 *     above the current one, or `null` if already at (or past) the top tier.
 *   - `revenue_to_next_tier`: how much additional revenue, holding cost
 *     constant, would be required to clear that next threshold. `null` if
 *     there is no next tier, or if the cost is zero/negative (in which case
 *     any non-zero revenue already implies 100% margin and no meaningful
 *     extra-revenue projection exists).
 *
 * Revenue of zero is treated as margin 0% and profit equal to `-cost`.
 */
export function simulateBonusScenario(input: {
  revenue: number
  cost: number
  bonus_pool: number
  tiers: readonly BonusTier[]
}): BonusScenarioResult {
  const revenue = Number.isFinite(input.revenue) ? Number(input.revenue) : 0
  const cost = Number.isFinite(input.cost) ? Number(input.cost) : 0
  const bonusPool = Number.isFinite(input.bonus_pool) ? Number(input.bonus_pool) : 0

  const { margin, profit } = calculateMargin({ revenue, cost })
  const payout = calculateBonusPayout(margin, bonusPool, input.tiers)

  const sortedTiers = [...input.tiers].sort((a, b) => a.minMargin - b.minMargin)
  const nextTier = sortedTiers.find((tier) => tier.minMargin > margin) ?? null
  const nextTierThreshold = nextTier ? nextTier.minMargin : null

  let revenueToNextTier: number | null = null
  if (nextTier && cost > 0) {
    // margin = (revenue - cost) / revenue => required revenue = cost / (1 - t)
    const requiredRevenue = cost / (1 - nextTier.minMargin)
    const delta = requiredRevenue - revenue
    revenueToNextTier = delta > 0 ? roundMoney(delta) : 0
  }

  return {
    margin,
    profit,
    eligible: payout.eligible,
    payout_percent: payout.payoutPercent,
    payout: payout.payout,
    next_tier_threshold: nextTierThreshold,
    revenue_to_next_tier: revenueToNextTier,
  }
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

export function roundPercent(value: number): number {
  return Math.round(value * 10000) / 10000
}

export function clampBoardCoordinate(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function calculatePolygonArea(points: readonly TakeoffPoint[]): number {
  if (points.length < 3) return 0
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (!current || !next) continue
    sum += current.x * next.y - next.x * current.y
  }
  return Math.abs(sum / 2)
}

export function calculatePolygonCentroid(points: readonly TakeoffPoint[]): TakeoffPoint | null {
  if (points.length < 3) return null
  let areaFactor = 0
  let cx = 0
  let cy = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (!current || !next) continue
    const cross = current.x * next.y - next.x * current.y
    areaFactor += cross
    cx += (current.x + next.x) * cross
    cy += (current.y + next.y) * cross
  }
  const area = areaFactor / 2
  if (area === 0) return null
  return { x: cx / (6 * area), y: cy / (6 * area) }
}

export function calculateTakeoffQuantity(points: readonly TakeoffPoint[], multiplier = 1): number {
  const resolvedMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
  return roundMeasurement(calculatePolygonArea(points) * resolvedMultiplier)
}

export function roundMeasurement(value: number): number {
  return Math.round(value * 100) / 100
}

export function normalizePolygonGeometry(input: unknown): PolygonGeometry | null {
  if (!isRecord(input)) return null
  if (input.kind !== 'polygon') return null
  if (!Array.isArray(input.points)) return null

  const points = input.points.map(normalizeBoardPoint)
  if (points.some((point) => point === null)) return null
  const normalizedPoints = points.filter((point): point is TakeoffPoint => point !== null)
  if (normalizedPoints.length < 3) return null

  const geometry: PolygonGeometry = {
    kind: 'polygon',
    points: normalizedPoints,
  }
  const sheetScale = positiveNumberOrNull(input.sheet_scale)
  const calibrationLength = positiveNumberOrNull(input.calibration_length)
  const calibrationUnit = typeof input.calibration_unit === 'string' ? input.calibration_unit.trim() : ''

  if (sheetScale !== null) geometry.sheet_scale = sheetScale
  if (calibrationLength !== null) geometry.calibration_length = calibrationLength
  if (calibrationUnit) geometry.calibration_unit = calibrationUnit.slice(0, 32)

  return geometry
}

function normalizeBoardPoint(input: unknown): TakeoffPoint | null {
  if (!isRecord(input)) return null
  const x = Number(input.x)
  const y = Number(input.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || x > 100 || y < 0 || y > 100) return null
  return { x: roundMeasurement(x), y: roundMeasurement(y) }
}

function positiveNumberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeLinealGeometry(input: unknown): LinealGeometry | null {
  if (!isRecord(input)) return null
  if (input.kind !== 'lineal') return null
  if (!Array.isArray(input.points)) return null

  const points = input.points.map(normalizeBoardPoint)
  if (points.some((point) => point === null)) return null
  const normalizedPoints = points.filter((point): point is TakeoffPoint => point !== null)
  if (normalizedPoints.length < 2) return null

  const geometry: LinealGeometry = {
    kind: 'lineal',
    points: normalizedPoints,
  }
  const sheetScale = positiveNumberOrNull(input.sheet_scale)
  const calibrationLength = positiveNumberOrNull(input.calibration_length)
  const calibrationUnit = typeof input.calibration_unit === 'string' ? input.calibration_unit.trim() : ''

  if (sheetScale !== null) geometry.sheet_scale = sheetScale
  if (calibrationLength !== null) geometry.calibration_length = calibrationLength
  if (calibrationUnit) geometry.calibration_unit = calibrationUnit.slice(0, 32)

  return geometry
}

export function normalizeVolumeGeometry(input: unknown): VolumeGeometry | null {
  if (!isRecord(input)) return null
  if (input.kind !== 'volume') return null

  const length = Number(input.length)
  const width = Number(input.width)
  const height = Number(input.height)
  if (!Number.isFinite(length) || length <= 0) return null
  if (!Number.isFinite(width) || width <= 0) return null
  if (!Number.isFinite(height) || height <= 0) return null

  const geometry: VolumeGeometry = {
    kind: 'volume',
    length: roundMeasurement(length),
    width: roundMeasurement(width),
    height: roundMeasurement(height),
  }
  const unit = typeof input.unit === 'string' ? input.unit.trim() : ''
  if (unit) geometry.unit = unit.slice(0, 32)

  return geometry
}

export function normalizeGeometry(input: unknown): TakeoffGeometry | null {
  if (!isRecord(input)) return null
  if (input.kind === 'polygon') return normalizePolygonGeometry(input)
  if (input.kind === 'lineal') return normalizeLinealGeometry(input)
  if (input.kind === 'volume') return normalizeVolumeGeometry(input)
  return null
}

export function calculateLinealLength(points: readonly TakeoffPoint[]): number {
  if (points.length < 2) return 0
  let total = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    if (!current || !next) continue
    const dx = next.x - current.x
    const dy = next.y - current.y
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total
}

export function calculateLinealQuantity(points: readonly TakeoffPoint[], multiplier = 1): number {
  const resolvedMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
  return roundMeasurement(calculateLinealLength(points) * resolvedMultiplier)
}

export function calculateVolumeQuantity(input: { length: number; width: number; height: number }): number {
  const { length, width, height } = input
  if (!Number.isFinite(length) || !Number.isFinite(width) || !Number.isFinite(height)) return 0
  if (length <= 0 || width <= 0 || height <= 0) return 0
  return roundMeasurement(length * width * height)
}

export function calculateGeometryQuantity(geometry: TakeoffGeometry): number {
  if (geometry.kind === 'polygon') {
    return calculateTakeoffQuantity(geometry.points, geometry.sheet_scale ?? 1)
  }
  if (geometry.kind === 'lineal') {
    return calculateLinealQuantity(geometry.points, geometry.sheet_scale ?? 1)
  }
  return calculateVolumeQuantity(geometry)
}

export function computeProductivity(input: { entries: readonly ProductivitySample[] }): ProductivityResult {
  const validRatios: number[] = []
  let totalQuantity = 0
  let totalHours = 0
  let samples = 0

  for (const entry of input.entries) {
    const quantity = Number(entry.quantity)
    const hours = Number(entry.hours)
    if (!Number.isFinite(quantity) || !Number.isFinite(hours)) continue
    if (quantity <= 0 || hours <= 0) continue
    validRatios.push(quantity / hours)
    totalQuantity += quantity
    totalHours += hours
    samples += 1
  }

  const avg = totalHours > 0 ? totalQuantity / totalHours : 0
  const p50 = samples >= 3 ? percentile(validRatios, 0.5) : null
  const p90 = samples >= 3 ? percentile(validRatios, 0.9) : null

  return {
    samples,
    total_quantity: roundMeasurement(totalQuantity),
    total_hours: roundMeasurement(totalHours),
    avg: roundMeasurement(avg),
    p50: p50 === null ? null : roundMeasurement(p50),
    p90: p90 === null ? null : roundMeasurement(p90),
  }
}

export interface GeoPoint {
  lat: number
  lng: number
}

export interface GeofenceInput {
  lat: number
  lng: number
  radius_m: number
  point: GeoPoint
}

/**
 * Earth mean radius in metres. Construction-site geofences are typically
 * 30-300 m so the spherical-earth approximation is well inside the noise
 * floor of a phone GPS fix; no ellipsoid correction needed.
 */
const EARTH_RADIUS_M = 6_371_000

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/**
 * Great-circle distance between two lat/lng points via the haversine
 * formula. Returns metres. Returns Infinity if any input is non-finite so
 * `isInsideGeofence` naturally falls to false on garbage input.
 */
export function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const lat1 = Number(a.lat)
  const lng1 = Number(a.lng)
  const lat2 = Number(b.lat)
  const lng2 = Number(b.lng)
  if (!Number.isFinite(lat1) || !Number.isFinite(lng1)) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(lat2) || !Number.isFinite(lng2)) return Number.POSITIVE_INFINITY

  const phi1 = toRadians(lat1)
  const phi2 = toRadians(lat2)
  const dPhi = toRadians(lat2 - lat1)
  const dLambda = toRadians(lng2 - lng1)

  const sinDPhi = Math.sin(dPhi / 2)
  const sinDLambda = Math.sin(dLambda / 2)
  const h = sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
  return EARTH_RADIUS_M * c
}

/**
 * Is `point` inside the circular geofence centered on (lat, lng) with
 * `radius_m` metres? Zero or negative radius disables the fence. Missing
 * centre coordinates also disable the fence (a project with no site
 * coordinates should never match).
 *
 * Antimeridian (the ±180° seam) is intentionally not handled — every
 * sitelayer customer is a construction crew in North America; a fence
 * straddling the seam would be meaningless here.
 */
export function isInsideGeofence(input: GeofenceInput): boolean {
  const lat = Number(input.lat)
  const lng = Number(input.lng)
  const radius = Number(input.radius_m)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  if (!Number.isFinite(radius) || radius <= 0) return false
  const distance = haversineDistanceMeters({ lat, lng }, input.point)
  if (!Number.isFinite(distance)) return false
  return distance <= radius
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0] ?? 0
  const clamped = Math.min(1, Math.max(0, fraction))
  const rank = clamped * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower] ?? 0
  const weight = rank - lower
  const lowerValue = sorted[lower] ?? 0
  const upperValue = sorted[upper] ?? 0
  return lowerValue + (upperValue - lowerValue) * weight
}

// ---------------------------------------------------------------------------
// Rentals (Avontus-style rental tracking)
// ---------------------------------------------------------------------------
//
// Rentals are billed on a rolling cadence: each tick (default 7 days) emits
// one `material_bills` row of `bill_type='rental'` for the period that just
// ended. The invoice clock starts at `delivered_on` and advances in
// `invoice_cadence_days` steps. Once the item is returned, we bill through
// `returned_on` and stop.
//
// The helpers below are pure so they can be covered by unit tests and reused
// from both the API manual-trigger endpoint and the worker heartbeat job.

export type RentalStatus = 'active' | 'returned' | 'invoiced_pending' | 'closed'

export interface RentalForInvoice {
  daily_rate: number | string
  delivered_on: string // YYYY-MM-DD
  returned_on?: string | null // YYYY-MM-DD | null
  invoice_cadence_days: number
  last_invoiced_through?: string | null // YYYY-MM-DD | null
  status?: RentalStatus
}

export interface RentalInvoiceResult {
  /** Days billed in this invoice (>= 0). Zero means "skip, nothing to bill". */
  days: number
  /** Amount in dollars rounded to cents. */
  amount: number
  /** Period start (inclusive, YYYY-MM-DD). */
  period_start: string
  /** Period end (inclusive, YYYY-MM-DD). */
  period_end: string
  /** Next `last_invoiced_through` after this invoice fires. */
  invoiced_through: string
  /** When the next cadence tick should happen (ISO). Null when the rental is fully billed. */
  next_invoice_at: string | null
  /** Terminal status after this invoice fires. */
  next_status: RentalStatus
}

function parseISODate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return new Date(NaN)
  const [, year, month, day] = match
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
}

function formatISODate(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0')
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = date.getUTCDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDaysUtc(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function diffDaysUtc(laterISO: string, earlierISO: string): number {
  const later = parseISODate(laterISO).getTime()
  const earlier = parseISODate(earlierISO).getTime()
  if (Number.isNaN(later) || Number.isNaN(earlier)) return 0
  return Math.round((later - earlier) / 86_400_000)
}

/**
 * Calculate the next invoice amount for a rental.
 *
 * Edge cases handled:
 *   - `delivered_on` in the future: no billable days yet — returns days=0.
 *   - `returned_on` before the last invoiced period: the rental is already
 *     fully billed — returns days=0 and `next_status='closed'`.
 *   - `last_invoiced_through` null: the billing clock starts at delivered_on.
 *   - `returned_on` within the cadence window: truncates the period to
 *     `returned_on` and marks the rental as closed.
 */
export function calculateRentalInvoice(
  rental: RentalForInvoice,
  referenceDate: string = formatISODate(new Date()),
): RentalInvoiceResult {
  const cadence = Math.max(1, Math.floor(Number(rental.invoice_cadence_days) || 7))
  const dailyRate = Number(rental.daily_rate) || 0
  const deliveredOn = rental.delivered_on
  const returnedOn = rental.returned_on ?? null
  const lastThrough = rental.last_invoiced_through ?? null

  const periodStartISO = lastThrough ? formatISODate(addDaysUtc(parseISODate(lastThrough), 1)) : deliveredOn

  // Haven't hit the first billable day yet.
  if (
    parseISODate(periodStartISO).getTime() > parseISODate(referenceDate).getTime() &&
    !(returnedOn && parseISODate(returnedOn).getTime() >= parseISODate(periodStartISO).getTime())
  ) {
    return {
      days: 0,
      amount: 0,
      period_start: periodStartISO,
      period_end: periodStartISO,
      invoiced_through: lastThrough ?? formatISODate(addDaysUtc(parseISODate(deliveredOn), -1)),
      next_invoice_at: `${formatISODate(addDaysUtc(parseISODate(deliveredOn), cadence - 1))}T00:00:00.000Z`,
      next_status: returnedOn ? 'returned' : 'active',
    }
  }

  // Cap the period end at: (a) reference date, (b) the cadence tick, and
  // (c) returned_on (if present). The smallest of these wins.
  const cadenceEnd = addDaysUtc(parseISODate(periodStartISO), cadence - 1)
  const referenceEnd = parseISODate(referenceDate)
  const returnedEnd = returnedOn ? parseISODate(returnedOn) : null

  let periodEnd = cadenceEnd.getTime() <= referenceEnd.getTime() ? cadenceEnd : referenceEnd
  let terminal = false
  if (returnedEnd && returnedEnd.getTime() < periodEnd.getTime()) {
    periodEnd = returnedEnd
    terminal = true
  } else if (returnedEnd && returnedEnd.getTime() === periodEnd.getTime()) {
    terminal = true
  }

  const periodEndISO = formatISODate(periodEnd)

  // If returned_on is strictly before the first billable day, the rental is
  // already fully billed — there's nothing to invoice.
  if (parseISODate(periodEndISO).getTime() < parseISODate(periodStartISO).getTime()) {
    return {
      days: 0,
      amount: 0,
      period_start: periodStartISO,
      period_end: periodStartISO,
      invoiced_through: lastThrough ?? formatISODate(addDaysUtc(parseISODate(deliveredOn), -1)),
      next_invoice_at: null,
      next_status: 'closed',
    }
  }

  const days = diffDaysUtc(periodEndISO, periodStartISO) + 1
  const amount = Math.round(days * dailyRate * 100) / 100

  const nextStatus: RentalStatus = terminal ? 'closed' : returnedOn ? 'returned' : 'active'
  const nextInvoiceAt = nextStatus === 'closed' ? null : `${formatISODate(addDaysUtc(periodEnd, 1))}T00:00:00.000Z`

  return {
    days,
    amount,
    period_start: periodStartISO,
    period_end: periodEndISO,
    invoiced_through: periodEndISO,
    next_invoice_at: nextInvoiceAt,
    next_status: nextStatus,
  }
}

/**
 * Compute the initial `next_invoice_at` timestamp when a rental is first
 * created. The billing clock ticks `invoice_cadence_days` after
 * `delivered_on` (i.e. the first invoice covers delivered_on through
 * delivered_on + cadence - 1 inclusive and fires on the following day).
 */
export function initialRentalNextInvoiceAt(deliveredOn: string, invoiceCadenceDays: number): string {
  const cadence = Math.max(1, Math.floor(Number(invoiceCadenceDays) || 7))
  const delivered = parseISODate(deliveredOn)
  if (Number.isNaN(delivered.getTime())) return `${deliveredOn}T00:00:00.000Z`
  return `${formatISODate(addDaysUtc(delivered, cadence))}T00:00:00.000Z`
}

// ---------------------------------------------------------------------------
// Job rental contracts (inventory replacement billing)
// ---------------------------------------------------------------------------

export type JobRentalRateUnit = 'day' | 'cycle' | 'week' | 'month' | 'each'

export interface JobRentalContractForBilling {
  billing_cycle_days: number
  billing_start_date: string // YYYY-MM-DD
  last_billed_through?: string | null // YYYY-MM-DD | null
  next_billing_date?: string | null // YYYY-MM-DD | null
}

export interface JobRentalLineForBilling {
  id: string
  inventory_item_id?: string | null
  item_code?: string | null
  item_description?: string | null
  quantity: number | string
  agreed_rate: number | string
  rate_unit: string
  on_rent_date: string // YYYY-MM-DD
  off_rent_date?: string | null // YYYY-MM-DD | null
  last_billed_through?: string | null // YYYY-MM-DD | null
  billable?: boolean | null
  taxable?: boolean | null
  status?: string | null
}

export interface JobRentalBillingLineResult {
  line_id: string
  inventory_item_id: string | null
  quantity: number
  agreed_rate: number
  rate_unit: JobRentalRateUnit
  billable_days: number
  period_start: string
  period_end: string
  amount: number
  taxable: boolean
  description: string
}

export interface JobRentalBillingRunResult {
  period_start: string
  period_end: string
  due_date: string
  next_billing_date: string
  billing_cycle_days: number
  is_due: boolean
  subtotal: number
  lines: JobRentalBillingLineResult[]
}

function maxISODate(values: readonly string[]): string {
  return values.reduce((max, value) => (parseISODate(value).getTime() > parseISODate(max).getTime() ? value : max))
}

function minISODate(values: readonly string[]): string {
  return values.reduce((min, value) => (parseISODate(value).getTime() < parseISODate(min).getTime() ? value : min))
}

function normalizeRentalRateUnit(value: string): JobRentalRateUnit {
  if (value === 'cycle' || value === 'week' || value === 'month' || value === 'each') return value
  return 'day'
}

function calculateJobRentalLineAmount(input: {
  quantity: number
  agreedRate: number
  rateUnit: JobRentalRateUnit
  billableDays: number
  cycleDays: number
}): number {
  const { quantity, agreedRate, rateUnit, billableDays, cycleDays } = input
  let amount = 0
  if (rateUnit === 'day') amount = quantity * agreedRate * billableDays
  if (rateUnit === 'cycle') amount = quantity * agreedRate * (billableDays / cycleDays)
  if (rateUnit === 'week') amount = quantity * agreedRate * (billableDays / 7)
  if (rateUnit === 'month') amount = quantity * agreedRate * (billableDays / 30)
  if (rateUnit === 'each') amount = quantity * agreedRate
  return roundMoney(amount)
}

/**
 * Compute the first billing date for a job rental contract. A 25-day cycle
 * starting 2026-04-01 covers 2026-04-01 through 2026-04-25 and becomes due
 * on 2026-04-26.
 */
export function initialJobRentalNextBillingDate(billingStartDate: string, billingCycleDays: number): string {
  const cadence = Math.max(1, Math.floor(Number(billingCycleDays) || 25))
  const start = parseISODate(billingStartDate)
  if (Number.isNaN(start.getTime())) return billingStartDate
  return formatISODate(addDaysUtc(start, cadence))
}

/**
 * Preview the next job-level rental billing run.
 *
 * The contract defines the billing window. Each line is independently clipped
 * by on/off-rent dates and its own last-billed-through marker so repeated runs
 * cannot double-bill the same line-period.
 */
export function calculateJobRentalBillingRun(
  contract: JobRentalContractForBilling,
  lines: readonly JobRentalLineForBilling[],
  referenceDate: string = formatISODate(new Date()),
): JobRentalBillingRunResult {
  const cycleDays = Math.max(1, Math.floor(Number(contract.billing_cycle_days) || 25))
  const periodStart = contract.last_billed_through
    ? formatISODate(addDaysUtc(parseISODate(contract.last_billed_through), 1))
    : contract.billing_start_date
  const periodEnd = formatISODate(addDaysUtc(parseISODate(periodStart), cycleDays - 1))
  const dueDate = formatISODate(addDaysUtc(parseISODate(periodEnd), 1))
  const nextBillingDate = formatISODate(addDaysUtc(parseISODate(periodEnd), cycleDays + 1))
  const isDue = parseISODate(referenceDate).getTime() >= parseISODate(dueDate).getTime()

  const billableLines: JobRentalBillingLineResult[] = []
  for (const line of lines) {
    if (line.billable === false) continue
    if (line.status === 'void' || line.status === 'cancelled') continue

    const quantity = Number(line.quantity) || 0
    const agreedRate = Number(line.agreed_rate) || 0
    if (quantity <= 0 || agreedRate < 0) continue

    const startCandidates = [periodStart, line.on_rent_date]
    if (line.last_billed_through)
      startCandidates.push(formatISODate(addDaysUtc(parseISODate(line.last_billed_through), 1)))
    const effectiveStart = maxISODate(startCandidates)

    const endCandidates = [periodEnd]
    if (line.off_rent_date) endCandidates.push(line.off_rent_date)
    const effectiveEnd = minISODate(endCandidates)

    if (parseISODate(effectiveEnd).getTime() < parseISODate(effectiveStart).getTime()) continue

    const billableDays = diffDaysUtc(effectiveEnd, effectiveStart) + 1
    const rateUnit = normalizeRentalRateUnit(String(line.rate_unit ?? 'day'))
    const amount = calculateJobRentalLineAmount({
      quantity,
      agreedRate,
      rateUnit,
      billableDays,
      cycleDays,
    })

    if (amount <= 0) continue

    const label = [line.item_code, line.item_description].filter(Boolean).join(' - ') || 'Rental item'
    billableLines.push({
      line_id: line.id,
      inventory_item_id: line.inventory_item_id ?? null,
      quantity,
      agreed_rate: agreedRate,
      rate_unit: rateUnit,
      billable_days: billableDays,
      period_start: effectiveStart,
      period_end: effectiveEnd,
      amount,
      taxable: line.taxable !== false,
      description: `${label} (${effectiveStart} to ${effectiveEnd}, ${billableDays} day${
        billableDays === 1 ? '' : 's'
      }, qty ${quantity})`,
    })
  }

  const subtotal = roundMoney(billableLines.reduce((sum, line) => sum + line.amount, 0))
  return {
    period_start: periodStart,
    period_end: periodEnd,
    due_date: dueDate,
    next_billing_date: nextBillingDate,
    billing_cycle_days: cycleDays,
    is_due: isDue,
    subtotal,
    lines: billableLines,
  }
}

// Rental billing workflow types/reducer/selectors moved to
// @sitelayer/workflows. This file kept the *math* (calculateJobRentalBillingRun
// etc.) — reducer, snapshot, and event types belong with other deterministic
// workflows. See docs/DETERMINISTIC_WORKFLOWS.md and packages/workflows/.

// ===========================================================================
// LABOR BURDEN
// ===========================================================================
//
// Pure burden math shared by the API endpoint and any future worker
// rollup. Migration 032 carries the per-worker burden columns and the
// per-project daily budget.
//
// Conventions:
//   - `cents` is integer cents to avoid float drift through the
//     hours × rate × multipliers chain. UI converts to dollars at
//     render time.
//   - Overtime threshold defaults to 8 hours in a single span. Phase 5
//     can refine to weekly OT or shop-configurable rules.

export const DEFAULT_OVERTIME_HOUR_THRESHOLD = 8

export interface LaborBurdenWorkerInput {
  worker_id: string
  /** Sum of straight-time hours (within the OT threshold). */
  straight_hours: number
  /** Sum of OT hours (over the threshold). */
  ot_hours: number
  /** Worker's base hourly rate, in integer cents. */
  base_hourly_cents: number
  /** Burden multipliers as percentages (e.g. 20 = 20%). */
  insurance_pct: number
  benefits_pct: number
  ot_premium_pct: number
}

export interface LaborBurdenWorkerResult {
  worker_id: string
  straight_hours: number
  ot_hours: number
  /** Loaded straight-time rate (cents/hr). */
  loaded_hourly_cents: number
  /** Loaded OT rate (cents/hr). */
  ot_loaded_hourly_cents: number
  /** Burdened dollars for straight time, in cents. */
  straight_cents: number
  /** Burdened dollars for OT, in cents. */
  ot_cents: number
  /** straight_cents + ot_cents */
  total_cents: number
}

/**
 * Per-worker burden. Pure; no clamping or rounding beyond what the
 * eventual `Math.round` for cents requires. Hours are accepted as
 * floats (decimal hours).
 */
export function calculateWorkerBurden(input: LaborBurdenWorkerInput): LaborBurdenWorkerResult {
  const { worker_id, straight_hours, ot_hours, base_hourly_cents, insurance_pct, benefits_pct, ot_premium_pct } = input
  const burdenMultiplier = 1 + insurance_pct / 100 + benefits_pct / 100
  const otMultiplier = 1 + ot_premium_pct / 100
  const loadedHourly = base_hourly_cents * burdenMultiplier
  const otLoadedHourly = loadedHourly * otMultiplier
  const straightCents = Math.round(loadedHourly * straight_hours)
  const otCents = Math.round(otLoadedHourly * ot_hours)
  return {
    worker_id,
    straight_hours,
    ot_hours,
    loaded_hourly_cents: Math.round(loadedHourly),
    ot_loaded_hourly_cents: Math.round(otLoadedHourly),
    straight_cents: straightCents,
    ot_cents: otCents,
    total_cents: straightCents + otCents,
  }
}

export interface LaborBurdenSummary {
  total_cents: number
  total_straight_hours: number
  total_ot_hours: number
  /** Sum of straight + OT across all workers. */
  total_hours: number
  /** Loaded $ per hour averaged across the totals (0 when total_hours=0). */
  blended_loaded_hourly_cents: number
  per_worker: LaborBurdenWorkerResult[]
}

/** Sum a list of per-worker results into the day-level rollup. */
export function summarizeLaborBurden(rows: LaborBurdenWorkerResult[]): LaborBurdenSummary {
  let totalCents = 0
  let totalStraight = 0
  let totalOt = 0
  for (const row of rows) {
    totalCents += row.total_cents
    totalStraight += row.straight_hours
    totalOt += row.ot_hours
  }
  const totalHours = totalStraight + totalOt
  const blended = totalHours > 0 ? Math.round(totalCents / totalHours) : 0
  return {
    total_cents: totalCents,
    total_straight_hours: totalStraight,
    total_ot_hours: totalOt,
    total_hours: totalHours,
    blended_loaded_hourly_cents: blended,
    per_worker: rows,
  }
}

/**
 * Split a worker's total hours into straight + OT against the
 * configured threshold (default 8h/day). Hours below the threshold are
 * straight; hours above are OT.
 */
export function splitStraightAndOt(
  totalHours: number,
  threshold: number = DEFAULT_OVERTIME_HOUR_THRESHOLD,
): { straight_hours: number; ot_hours: number } {
  if (totalHours <= 0) return { straight_hours: 0, ot_hours: 0 }
  if (totalHours <= threshold) return { straight_hours: totalHours, ot_hours: 0 }
  return { straight_hours: threshold, ot_hours: totalHours - threshold }
}
