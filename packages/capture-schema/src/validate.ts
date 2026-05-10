import { z } from 'zod'
import { TakeoffResult } from './takeoff.js'
import { PricedEstimate, CatalogItem } from './pricing.js'

export class TakeoffValidationError extends Error {
  constructor(
    message: string,
    public issues: z.ZodIssue[],
  ) {
    super(message)
    this.name = 'TakeoffValidationError'
  }
}

export function validateTakeoffResult(input: unknown): TakeoffResult {
  const parsed = TakeoffResult.safeParse(input)
  if (!parsed.success) {
    throw new TakeoffValidationError('TakeoffResult validation failed', parsed.error.issues)
  }
  return parsed.data
}

export function safeValidateTakeoffResult(
  input: unknown,
): { ok: true; value: TakeoffResult } | { ok: false; issues: z.ZodIssue[] } {
  const parsed = TakeoffResult.safeParse(input)
  if (!parsed.success) return { ok: false, issues: parsed.error.issues }
  return { ok: true, value: parsed.data }
}

export function validatePricedEstimate(input: unknown): PricedEstimate {
  const parsed = PricedEstimate.safeParse(input)
  if (!parsed.success) {
    throw new TakeoffValidationError('PricedEstimate validation failed', parsed.error.issues)
  }
  return parsed.data
}

export function validateCatalogItem(input: unknown): CatalogItem {
  const parsed = CatalogItem.safeParse(input)
  if (!parsed.success) {
    throw new TakeoffValidationError('CatalogItem validation failed', parsed.error.issues)
  }
  return parsed.data
}
