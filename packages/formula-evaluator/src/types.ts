import type { SafeExpression } from './safe-parser.js'

/**
 * Variables bound when evaluating an assembly-component quantity formula (or the
 * optional boolean `include_when` expression).
 *
 * `measurement_quantity` and `measurement_unit` are always supplied by the
 * explode path. The five measurement DRIVERS (`height` / `width` / `thickness` /
 * `perimeter` / `sides`) are derived from the measurement geometry (or its
 * condition drivers, when present) so one drawn object can drive plate-LF from
 * length, stud-count from height, and sheet-count from area the PlanSwift way
 * (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §5.3 M2). They are always bound to a
 * finite number — an absent driver defaults to `0` so a formula that references
 * it stays defined (never "undefined variable"). Any additional named vars come
 * from the component's `formula_vars` JSON (e.g. `{ coverage_rate: 32 }`).
 *
 * Values are restricted to `number | string` on purpose: never allow function
 * values into the evaluation scope (the function-injection class of attack —
 * formerly expr-eval advisory GHSA-jc85-fpwf-qm7x — stays structurally dead).
 */
export interface FormulaContext {
  measurement_quantity: number
  measurement_unit: string
  // The five drivers explicitly allow `undefined` (not just `?`) so a caller may
  // pass an explicit `undefined` for an unsupplied driver under
  // `exactOptionalPropertyTypes` — `coerceContext` drops it. The explode path
  // instead binds each to a finite `0`.
  /** Driver: real-world height of the measurement (0 when geometry carries none). */
  height?: number | undefined
  /** Driver: real-world width / bounding-box span (0 when geometry carries none). */
  width?: number | undefined
  /** Driver: real-world thickness / depth (0 when geometry carries none). */
  thickness?: number | undefined
  /** Driver: real-world perimeter / total run length (0 when geometry carries none). */
  perimeter?: number | undefined
  /** Driver: vertex / segment / face count (0 when geometry carries none). */
  sides?: number | undefined
  [customVar: string]: number | string | undefined
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
 * Result of a BOOLEAN formula (an `include_when` expression). The evaluator
 * returns a JS boolean for a bare comparison (`height > 8`) and a number for
 * arithmetic (`sides`); both are accepted and reduced to truthiness here
 * (0 / false → false, any other finite number / true → true).
 */
export interface BooleanFormulaResult {
  ok: boolean
  value?: boolean
  error?: FormulaValidationError
}

/**
 * Opaque wrapper over a parsed {@link SafeExpression} plus the variable names
 * it references. Callers should treat this as a handle and not reach into it.
 */
export interface ParsedFormula {
  /** The original source text (already length-validated). */
  readonly source: string
  /** Parsed expression (in-package safe engine; no eval/Function, whitelist-only). */
  readonly expression: SafeExpression
  /** Distinct variable names the expression references. */
  readonly variables: readonly string[]
}

/**
 * The five measurement DRIVER variables the explode path always binds (each to a
 * finite number, 0 when the geometry carries none). Exposed so the assemblies
 * CRUD validator can allow a `quantity_formula` / `include_when` to reference
 * them without listing them per-call (siblings of the always-bound
 * `measurement_quantity` / `measurement_unit`).
 */
export const MEASUREMENT_DRIVER_VARS = ['height', 'width', 'thickness', 'perimeter', 'sides'] as const

/** Hard cap on formula length (DoS guard — matches the migration 109 CHECK). */
export const MAX_FORMULA_LENGTH = 500

/** Absolute-magnitude sanity bound on a result (typo guard). */
export const MAX_RESULT_MAGNITUDE = 1e9
