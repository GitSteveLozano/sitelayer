import { z } from 'zod'

export const CatalogItem = z.object({
  sku: z.string().min(1),
  csiCode: z.string(),
  description: z.string(),
  unit: z.string(),
  unitPrice: z.number().min(0),
  laborHoursPerUnit: z.number().min(0),
  wasteFactor: z.number().min(0).max(1),
  supplierRef: z
    .object({
      vendor: z.enum(['home_depot', 'lowes', 'ferguson', 'manual']),
      id: z.string(),
      url: z.string().optional(),
    })
    .optional(),
  source: z.enum(['manual', 'home_depot_scrape', 'rsmeans', 'craftsman_nce', 'qbo_item', 'pricing_profile']),
  confidence: z.number().min(0).max(1),
  pricedAt: z.string().datetime({ offset: true }),
})
export type CatalogItem = z.infer<typeof CatalogItem>

export const PricedLine = z.object({
  id: z.string().uuid(),
  serviceItemCode: z.string(),
  csiCode: z.string(),
  divisionCode: z.string().regex(/^\d{2}$/),
  description: z.string(),
  quantity: z.number().min(0),
  unit: z.string(),
  rate: z.number().min(0),
  amount: z.number().min(0),
  breakdown: z.object({
    material: z.number().min(0),
    labor: z.number().min(0),
    waste: z.number().min(0),
    laborHours: z.number().min(0),
  }),
  source: CatalogItem.shape.source,
  confidence: z.number().min(0).max(1),
  takeoffQuantityId: z.string(),
})
export type PricedLine = z.infer<typeof PricedLine>

export const CsiDivisionRollup = z.object({
  divisionCode: z.string().regex(/^\d{2}$/),
  divisionName: z.string(),
  material: z.number(),
  labor: z.number(),
  total: z.number(),
})
export type CsiDivisionRollup = z.infer<typeof CsiDivisionRollup>

export const PricedEstimate = z.object({
  projectRef: z.object({
    companyId: z.string(),
    projectId: z.string(),
  }),
  currency: z.literal('USD'),
  pricedAt: z.string().datetime({ offset: true }),
  precedenceUsed: z.enum(['project_override', 'customer_profile', 'company_profile', 'qbo_item', 'seeded_fallback']),
  lines: z.array(PricedLine),
  rollupsByCsiDivision: z.array(CsiDivisionRollup),
  totals: z.object({
    materialSubtotal: z.number(),
    laborSubtotal: z.number(),
    wasteSubtotal: z.number(),
    overheadAndProfit: z.number(),
    grandTotal: z.number(),
  }),
})
export type PricedEstimate = z.infer<typeof PricedEstimate>

export const DEFAULT_OVERHEAD_AND_PROFIT = 0.2

/**
 * Map a CSI MasterFormat code to its 2-digit division.
 * Accepts "09 29 00" or "09" → returns "09".
 */
export function divisionOf(csiCode: string): string {
  const match = csiCode.match(/^(\d{2})/)
  if (!match) throw new Error(`Invalid CSI code: ${csiCode}`)
  return match[1]!
}

export const CSI_DIVISION_NAMES: Readonly<Record<string, string>> = {
  '00': 'Procurement and Contracting Requirements',
  '01': 'General Requirements',
  '02': 'Existing Conditions',
  '03': 'Concrete',
  '04': 'Masonry',
  '05': 'Metals',
  '06': 'Wood, Plastics, and Composites',
  '07': 'Thermal and Moisture Protection',
  '08': 'Openings',
  '09': 'Finishes',
  '10': 'Specialties',
  '11': 'Equipment',
  '12': 'Furnishings',
  '13': 'Special Construction',
  '14': 'Conveying Equipment',
  '21': 'Fire Suppression',
  '22': 'Plumbing',
  '23': 'HVAC',
  '26': 'Electrical',
  '27': 'Communications',
  '28': 'Electronic Safety and Security',
  '31': 'Earthwork',
  '32': 'Exterior Improvements',
  '33': 'Utilities',
}

export function divisionNameFor(divisionCode: string): string {
  return CSI_DIVISION_NAMES[divisionCode] ?? `Division ${divisionCode}`
}
