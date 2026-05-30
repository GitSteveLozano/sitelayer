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

## No `eval` / `Function`

This package never calls `eval()` or `new Function()`. It wraps
[`expr-eval`](https://www.npmjs.com/package/expr-eval), which has its own AST
parser + tree-walking interpreter. We never call `.toJSFunction()`.

### Hardening

`expr-eval@2.0.2` ships with live advisories (prototype pollution
`GHSA-8gw3-rxh4-v6jx`, function injection `GHSA-jc85-fpwf-qm7x`) and **no
upstream fix**. Both exploit paths are closed here:

- The `Parser` is constructed with `allowMemberAccess: false`, so
  `x.constructor`, `(0).__proto__`, etc. fail at parse time (closes the
  prototype-pollution / constructor-walk path).
- `operators.assignment` and `operators.fndef` are disabled — formulas are
  pure, read-only expressions; they cannot define or mutate state.
- The evaluation scope is typed and runtime-checked to `number | string` only,
  so no function value can reach `evaluate()` (closes the function-injection
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

- Operators: `+ - * / % ^`, comparisons (`< <= > >= == !=`), logical
  (`&& || !`).
- Functions: `if(cond, a, b)`, `abs ceil floor round sqrt min max` and the
  other expr-eval math builtins.
- Numbers use a decimal point (`1.5`); comma grouping (`1,000`) is **not**
  supported and is a syntax error.
- Negative results are allowed — the caller applies the deduction sign.

## Test

```bash
npm test --workspace @sitelayer/formula-evaluator
```
