import { parseSafeExpression, type EvaluationScope } from './safe-parser.js'
import {
  MAX_FORMULA_LENGTH,
  MAX_RESULT_MAGNITUDE,
  type BooleanFormulaResult,
  type FormulaContext,
  type FormulaResult,
  type FormulaValidationError,
  type ParsedFormula,
} from './types.js'

/**
 * Engine: the in-package safe evaluator in `safe-parser.ts` (expr-eval was
 * dropped 2026-06-12 — it carried HIGH advisories GHSA-8gw3-rxh4-v6jx
 * prototype-pollution and GHSA-jc85-fpwf-qm7x function-injection with no
 * upstream fix). Security properties, by construction:
 *
 * - No `eval` / `new Function` anywhere — hand-rolled tokenizer + parser +
 *   tree-walking interpreter.
 * - Member access is not even a token: `x.constructor`, `(0).__proto__`, etc.
 *   fail at parse time (the prototype-pollution / constructor-walk path).
 * - No assignment / function definition — formulas are pure read-only
 *   expressions; `x = …` and `f(x) = …` are parse errors.
 * - Whitelist-only function table; unknown function names are parse errors.
 * - Variable resolution is own-property-only against an
 *   `Object.create(null)` scope (see `coerceContext`), so `__proto__` /
 *   `constructor` / `toString` are inert identifiers.
 * - The evaluation scope (`FormulaContext`) is typed AND runtime-checked to
 *   `number | string` only, so no function value can ever reach `evaluate()`
 *   (keeps the function-injection class dead even for untrusted JSON
 *   `formula_vars`).
 */

function syntaxError(message: string): FormulaValidationError {
  return { code: 'SYNTAX_ERROR', message }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Parse a formula string into an opaque `ParsedFormula`.
 *
 * @throws Error on `> MAX_FORMULA_LENGTH` chars or malformed syntax. Callers
 * who want a non-throwing path should use `validateFormula` /
 * `evaluateFormulaUnsafe` instead.
 */
export function parseFormula(formula: string): ParsedFormula {
  if (typeof formula !== 'string') {
    throw new Error('formula must be a string')
  }
  if (formula.length > MAX_FORMULA_LENGTH) {
    throw new Error(`formula exceeds ${MAX_FORMULA_LENGTH} characters`)
  }
  if (formula.trim().length === 0) {
    throw new Error('formula is empty')
  }
  const expression = parseSafeExpression(formula)
  return {
    source: formula,
    expression,
    variables: expression.variableNames,
  }
}

/**
 * Build the value scope passed to the evaluator, rejecting any
 * non-number/string value defensively (the type system already forbids
 * functions, but `evaluateFormulaUnsafe` may receive untrusted runtime
 * objects).
 *
 * The scope is a null-prototype object and only own enumerable keys of `ctx`
 * are copied, so a hostile `__proto__` / `constructor` key is just data and
 * nothing is ever resolved through a prototype chain.
 */
function coerceContext(ctx: FormulaContext): EvaluationScope {
  const scope: EvaluationScope = Object.create(null) as EvaluationScope
  for (const key of Object.keys(ctx)) {
    const value = ctx[key]
    // An explicit `undefined` driver means "not supplied" — drop it from scope
    // (the preflight then reports it as an undefined variable only if a formula
    // actually references it), rather than rejecting the whole context.
    if (value === undefined) continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`variable "${key}" is not a finite number`)
      }
      scope[key] = value
    } else if (typeof value === 'string') {
      scope[key] = value
    } else {
      // Never let a function (or any other type) into the evaluation scope
      // (keeps the GHSA-jc85-fpwf-qm7x function-injection class dead).
      throw new Error(`variable "${key}" must be a number or string`)
    }
  }
  return scope
}

/**
 * Evaluate a previously-parsed formula against a context.
 *
 * Never throws — all failure modes are returned as a `FormulaResult` with an
 * `error`. Failure modes:
 * - `UNDEFINED_VARIABLE`: the formula references a var not present in `ctx`.
 * - `DIVIDE_BY_ZERO`: result is `±Infinity` (commonly a literal `/ 0`).
 * - `INVALID_RESULT`: `NaN`, non-finite, non-number, or `|value| > 1e9`.
 */
export function evaluateFormula(parsed: ParsedFormula, ctx: FormulaContext): FormulaResult {
  let scope: EvaluationScope
  try {
    scope = coerceContext(ctx)
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_RESULT', message: errorMessage(err) } }
  }

  // Preflight: every referenced variable must be supplied. Do NOT silently
  // treat missing vars as 0 (per plan §2 implementation rules).
  const missing = parsed.variables.filter((name) => !(name in scope))
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'UNDEFINED_VARIABLE',
        message: `undefined variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      },
    }
  }

  let raw: unknown
  try {
    raw = parsed.expression.evaluate(scope)
  } catch (err) {
    return { ok: false, error: syntaxError(errorMessage(err)) }
  }

  if (typeof raw !== 'number') {
    return {
      ok: false,
      error: { code: 'INVALID_RESULT', message: `result is not a number (got ${typeof raw})` },
    }
  }
  if (Number.isNaN(raw)) {
    return { ok: false, error: { code: 'INVALID_RESULT', message: 'result is NaN' } }
  }
  if (!Number.isFinite(raw)) {
    // ±Infinity — most commonly division by zero.
    return { ok: false, error: { code: 'DIVIDE_BY_ZERO', message: 'result is not finite (divide by zero?)' } }
  }
  if (Math.abs(raw) > MAX_RESULT_MAGNITUDE) {
    return {
      ok: false,
      error: {
        code: 'INVALID_RESULT',
        message: `result magnitude ${raw} exceeds ${MAX_RESULT_MAGNITUDE}`,
      },
    }
  }

  return { ok: true, value: raw }
}

/**
 * One-shot parse + evaluate. Convenient for callers that don't cache a parsed
 * handle (e.g. the recompute explode path and the client-side live preview).
 * Never throws — parse failures come back as `SYNTAX_ERROR` / `TOO_LONG`.
 */
export function evaluateFormulaUnsafe(formula: string, ctx: FormulaContext): FormulaResult {
  if (typeof formula !== 'string' || formula.trim().length === 0) {
    return { ok: false, error: syntaxError('formula is empty') }
  }
  if (formula.length > MAX_FORMULA_LENGTH) {
    return {
      ok: false,
      error: { code: 'TOO_LONG', message: `formula exceeds ${MAX_FORMULA_LENGTH} characters` },
    }
  }
  let parsed: ParsedFormula
  try {
    parsed = parseFormula(formula)
  } catch (err) {
    return { ok: false, error: syntaxError(errorMessage(err)) }
  }
  return evaluateFormula(parsed, ctx)
}

/**
 * Evaluate a parsed expression as a BOOLEAN (an assembly component's
 * `include_when`). Shares the exact same hardened parser + `coerceContext`
 * sandbox as {@link evaluateFormula} — the only difference is the accepted
 * result type: the evaluator yields a JS `boolean` for a bare comparison
 * (`height > 8`) and a `number` for arithmetic (`sides`); a number is reduced to
 * truthiness (`0 → false`, any other finite value → true). NaN / non-finite /
 * other types are rejected so a malformed expression fails loudly rather than
 * silently skipping (or keeping) a component.
 *
 * Never throws. Failure modes mirror `evaluateFormula`
 * (`UNDEFINED_VARIABLE` / `INVALID_RESULT` / `SYNTAX_ERROR`).
 */
export function evaluateBooleanFormula(parsed: ParsedFormula, ctx: FormulaContext): BooleanFormulaResult {
  let scope: EvaluationScope
  try {
    scope = coerceContext(ctx)
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_RESULT', message: errorMessage(err) } }
  }

  const missing = parsed.variables.filter((name) => !(name in scope))
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'UNDEFINED_VARIABLE',
        message: `undefined variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      },
    }
  }

  let raw: unknown
  try {
    raw = parsed.expression.evaluate(scope)
  } catch (err) {
    return { ok: false, error: syntaxError(errorMessage(err)) }
  }

  if (typeof raw === 'boolean') {
    return { ok: true, value: raw }
  }
  if (typeof raw === 'number') {
    if (Number.isNaN(raw)) {
      return { ok: false, error: { code: 'INVALID_RESULT', message: 'result is NaN' } }
    }
    if (!Number.isFinite(raw)) {
      return { ok: false, error: { code: 'DIVIDE_BY_ZERO', message: 'result is not finite (divide by zero?)' } }
    }
    return { ok: true, value: raw !== 0 }
  }
  return {
    ok: false,
    error: { code: 'INVALID_RESULT', message: `result is not a boolean or number (got ${typeof raw})` },
  }
}

/**
 * One-shot parse + boolean-evaluate. Convenient for the explode path's
 * `include_when` check. Never throws — parse failures come back as
 * `SYNTAX_ERROR` / `TOO_LONG`.
 */
export function evaluateBooleanFormulaUnsafe(formula: string, ctx: FormulaContext): BooleanFormulaResult {
  if (typeof formula !== 'string' || formula.trim().length === 0) {
    return { ok: false, error: syntaxError('formula is empty') }
  }
  if (formula.length > MAX_FORMULA_LENGTH) {
    return {
      ok: false,
      error: { code: 'TOO_LONG', message: `formula exceeds ${MAX_FORMULA_LENGTH} characters` },
    }
  }
  let parsed: ParsedFormula
  try {
    parsed = parseFormula(formula)
  } catch (err) {
    return { ok: false, error: syntaxError(errorMessage(err)) }
  }
  return evaluateBooleanFormula(parsed, ctx)
}
