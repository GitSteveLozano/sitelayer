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
  { code: 'EPS', name: 'EPS', category: 'measurable', unit: 'sqft', defaultRate: 4 },
  { code: 'Basecoat', name: 'Basecoat', category: 'measurable', unit: 'sqft', defaultRate: 2.5 },
  { code: 'Finish Coat', name: 'Finish Coat', category: 'measurable', unit: 'sqft', defaultRate: 3.5 },
  { code: 'Air Barrier', name: 'Air Barrier', category: 'measurable', unit: 'sqft', defaultRate: 1.8 },
  { code: 'Envelope Seal', name: 'Envelope Seal', category: 'measurable', unit: 'lf', defaultRate: 2 },
  { code: 'Cementboard', name: 'Cementboard', category: 'measurable', unit: 'sqft', defaultRate: 3.25 },
  { code: 'Cultured Stone', name: 'Cultured Stone', category: 'measurable', unit: 'sqft', defaultRate: 12 },
  { code: 'Caulking', name: 'Caulking', category: 'measurable', unit: 'lf', defaultRate: 4.5 },
  { code: 'Flashing', name: 'Flashing', category: 'measurable', unit: 'lf', defaultRate: 8 },
  { code: 'Change Order', name: 'Change Order', category: 'accounting', unit: 'job', defaultRate: null },
  { code: 'Deposit', name: 'Deposit', category: 'accounting', unit: 'job', defaultRate: null },
  { code: 'Holdback', name: 'Holdback', category: 'accounting', unit: 'job', defaultRate: null },
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
