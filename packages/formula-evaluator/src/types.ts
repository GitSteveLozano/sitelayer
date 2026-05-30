import type { Expression } from 'expr-eval'

/**
 * Variables bound when evaluating an assembly-component quantity formula.
 *
 * `measurement_quantity` and `measurement_unit` are always supplied by the
 * explode path; any additional named vars come from the component's
 * `formula_vars` JSON (e.g. `{ coverage_rate: 32 }`).
 *
 * Values are restricted to `number | string` on purpose: never allow function
 * values into the evaluation scope (closes expr-eval advisory
 * GHSA-jc85-fpwf-qm7x — "does not restrict functions passed to evaluate").
 */
export interface FormulaContext {
  measurement_quantity: number
  measurement_unit: string
  [customVar: string]: number | string
}

export type FormulaErrorCode = 'SYNTAX_ERROR' | 'UNDEFINED_VARIABLE' | 'DIVIDE_BY_ZERO' | 'INVALID_RESULT' | 'TOO_LONG'

export interface FormulaValidationError {
  code: FormulaErrorCode
  message: string
}

export interface FormulaResult {
  ok: boolean
  value?: number
  error?: FormulaValidationError
}

/**
 * Opaque wrapper over a parsed expr-eval `Expression` plus the variable names
 * it references. Callers should treat this as a handle and not reach into it.
 */
export interface ParsedFormula {
  /** The original source text (already length-validated). */
  readonly source: string
  /** Parsed expr-eval expression. */
  readonly expression: Expression
  /** Distinct variable names the expression references. */
  readonly variables: readonly string[]
}

/** Hard cap on formula length (DoS guard — matches the migration 109 CHECK). */
export const MAX_FORMULA_LENGTH = 500

/** Absolute-magnitude sanity bound on a result (typo guard). */
export const MAX_RESULT_MAGNITUDE = 1e9
