import { parseFormula } from './evaluator.js'
import { MAX_FORMULA_LENGTH } from './types.js'

export interface FormulaValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate a formula's syntax and (optionally) that it references only a
 * permitted set of variables, without evaluating it.
 *
 * Used by the assemblies CRUD path to reject a bad `quantity_formula` at write
 * time (400) before it ever reaches recompute.
 *
 * - Empty / whitespace-only → invalid.
 * - `> MAX_FORMULA_LENGTH` chars → invalid (TOO_LONG analog).
 * - Malformed syntax → invalid with the parser message.
 * - When `requiredVars` is provided, any referenced variable NOT in that list
 *   is reported as an error (preflight against the known binding set, e.g.
 *   `['measurement_quantity', 'measurement_unit', ...formula_var_keys]`).
 */
export function validateFormula(formula: string, requiredVars?: string[]): FormulaValidationResult {
  const errors: string[] = []

  if (typeof formula !== 'string') {
    return { valid: false, errors: ['formula must be a string'] }
  }
  if (formula.trim().length === 0) {
    return { valid: false, errors: ['formula is empty'] }
  }
  if (formula.length > MAX_FORMULA_LENGTH) {
    return { valid: false, errors: [`formula exceeds ${MAX_FORMULA_LENGTH} characters`] }
  }

  let variables: readonly string[]
  try {
    variables = parseFormula(formula).variables
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)] }
  }

  if (requiredVars) {
    const allowed = new Set(requiredVars)
    for (const name of variables) {
      if (!allowed.has(name)) {
        errors.push(`unknown variable: ${name}`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}
