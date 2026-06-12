# @sitelayer/formula-evaluator

Sandboxed arithmetic evaluator for assembly-component **quantity formulas** —
the "drag an assembly onto a takeoff and it explodes into material/labor/sub
quantities with formulas and waste" feature (PlanSwift Phase 2, `§2`).

A formula computes a component's **per-unit quantity** from the attached
measurement and a few named variables. Example:

```
measurement_quantity * 1.1 / coverage_rate
```

with `{ coverage_rate: 32 }` and a 500 sqft measurement → `17.1875`.

## No `eval` / `Function` — zero dependencies

This package never calls `eval()` or `new Function()`. The engine is an
in-package tokenizer + recursive-descent parser + tree-walking interpreter
(`src/safe-parser.ts`) with **no runtime dependencies**.

It previously wrapped [`expr-eval`](https://www.npmjs.com/package/expr-eval),
which carries two HIGH advisories with **no upstream fix** (prototype
pollution `GHSA-8gw3-rxh4-v6jx`, function injection `GHSA-jc85-fpwf-qm7x`).
expr-eval was removed on 2026-06-12; the replacement engine keeps the exact
same evaluation semantics for the supported syntax (the operator
implementations are line-for-line ports) and makes both exploit classes
structurally impossible:

- Member access is not even a token — `x.constructor`, `(0).__proto__`, etc.
  fail at parse time (the prototype-pollution / constructor-walk path).
- No assignment or function definition — `x = …` / `f(x) = …` are parse
  errors; formulas are pure, read-only expressions.
- Whitelist-only operator/function tables (built on `Object.create(null)`);
  an unknown function name is a parse error.
- Variable resolution is own-property-only against a null-prototype scope —
  `__proto__` / `constructor` / `toString` are inert identifiers.
- The evaluation scope is typed and runtime-checked to `number | string` only,
  so no function value can reach `evaluate()` (kills the function-injection
  path even for untrusted JSON `formula_vars`).

## API

```typescript
import { parseFormula, evaluateFormula, evaluateFormulaUnsafe, validateFormula } from '@sitelayer/formula-evaluator'

// Cached handle (parse once, evaluate many):
const parsed = parseFormula('measurement_quantity / coverage_rate')
const r = evaluateFormula(parsed, {
  measurement_quantity: 500,
  measurement_unit: 'sqft',
  coverage_rate: 32,
})
// r: { ok: true, value: 15.625 }

// One-shot (recompute explode, client live-preview):
evaluateFormulaUnsafe('5 + 3', { measurement_quantity: 0, measurement_unit: 'sqft' })
// { ok: true, value: 8 }

// Write-time validation (assemblies CRUD 400 guard):
validateFormula('measurement_quantity * 1.1', ['measurement_quantity', 'measurement_unit'])
// { valid: true, errors: [] }
```

`evaluateFormula` / `evaluateFormulaUnsafe` never throw — every failure is a
`FormulaResult` with an `error.code`:

| code                 | when                                                           |
| -------------------- | -------------------------------------------------------------- |
| `SYNTAX_ERROR`       | empty / malformed / member-access / assignment / comma-grouped |
| `TOO_LONG`           | `> 500` chars (DoS guard, matches migration 109 CHECK)         |
| `UNDEFINED_VARIABLE` | formula references a var not in the context (never silent 0)   |
| `DIVIDE_BY_ZERO`     | result is `±Infinity`                                          |
| `INVALID_RESULT`     | `NaN`, non-finite var, abs value `> 1e9`, or non-number result |

`parseFormula` **throws** on too-long / empty / malformed input (use the
non-throwing functions above unless you want exceptions).

## Supported syntax

- Operators: `+ - * / % ^` (`^` = power, right-associative), comparisons
  (`< <= > >= == !=`), logical keywords (`and or not`), ternary
  (`cond ? a : b`).
- Functions: `if(cond, a, b)`,
  `abs ceil floor round trunc sign sqrt cbrt exp min max pow hypot roundTo`,
  logs (`log ln lg log10 log2 expm1 log1p`), trig
  (`sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh atan2`),
  `length(str)`. Anything else — including expr-eval's `random`, factorial,
  and the function-taking array helpers — is a **syntax error**.
- Constants: `PI`, `E`, `true`, `false`.
- Numbers use a decimal point (`1.5`, `1e9`); comma grouping (`1,000`) is
  **not** supported and is a syntax error.
- Negative results are allowed — the caller applies the deduction sign.

## Test

```bash
npm test --workspace @sitelayer/formula-evaluator
```
