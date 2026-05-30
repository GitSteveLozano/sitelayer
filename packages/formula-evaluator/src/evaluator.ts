import pkg from 'expr-eval'

import {
  MAX_FORMULA_LENGTH,
  MAX_RESULT_MAGNITUDE,
  type FormulaContext,
  type FormulaResult,
  type FormulaValidationError,
  type ParsedFormula,
} from './types.js'

const { Parser } = pkg

/**
 * A single hardened parser instance, reused across calls.
 *
 * Hardening rationale (expr-eval 2.0.2 carries live advisories
 * GHSA-8gw3-rxh4-v6jx prototype-pollution and GHSA-jc85-fpwf-qm7x
 * function-injection, with no upstream fix):
 *
 * - `allowMemberAccess: false` — blocks `x.constructor`, `(0).__proto__`, etc.
 *   at parse time, which is the prototype-pollution / constructor-walk exploit
 *   path. Verified: `x.constructor` throws "member access is not permitted".
 * - `operators.assignment: false` / `operators.fndef: false` — no `x = …` or
 *   `f(x) = …`; formulas are pure read-only expressions, never define state.
 * - The evaluation scope (`FormulaContext`) is typed to `number | string`
 *   only, so no function value can ever reach `evaluate()` (closes the
 *   function-injection advisory at the type + runtime layer; see
 *   `coerceContext`).
 *
 * NOTE: this module never uses `eval` or `Function`. expr-eval has its own AST
 * interpreter; we never call `.toJSFunction()` (which would synthesize a
 * `Function`).
 */
const parser = new Parser({
  allowMemberAccess: false,
  operators: {
    assignment: false,
    fndef: false,
  },
})

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
  const expression = parser.parse(formula)
  // `variables()` without member-access yields plain referenced symbol names.
  const variables = expression.variables({ withMembers: false })
  return {
    source: formula,
    expression,
    variables,
  }
}

/**
 * Build the value scope passed to expr-eval, rejecting any non-number/string
 * value defensively (the type system already forbids functions, but
 * `evaluateFormulaUnsafe` may receive untrusted runtime objects).
 */
function coerceContext(ctx: FormulaContext): Record<string, number | string> {
  const scope: Record<string, number | string> = {}
  for (const key of Object.keys(ctx)) {
    const value = ctx[key]
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`variable "${key}" is not a finite number`)
      }
      scope[key] = value
    } else if (typeof value === 'string') {
      scope[key] = value
    } else {
      // Closes GHSA-jc85-fpwf-qm7x: never let a function (or any other type)
      // into the evaluation scope.
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
  let scope: Record<string, number | string>
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
