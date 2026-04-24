export type WorkflowStage =
  | 'foundation'
  | 'takeoff'
  | 'field'
  | 'sync'
  | 'analytics'
  | 'extensions'

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

export const WORKFLOW_STAGES: WorkflowStage[] = [
  'foundation',
  'takeoff',
  'field',
  'sync',
  'analytics',
  'extensions',
]

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
    { minMargin: 0.20, payoutPercent: 0.09 },
    { minMargin: 0.25, payoutPercent: 0.14 },
    { minMargin: 0.30, payoutPercent: 0.19 },
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
