import { describe, it, expect } from 'vitest'

import {
  parseFormula,
  evaluateFormula,
  evaluateFormulaUnsafe,
  validateFormula,
  MAX_FORMULA_LENGTH,
  type FormulaContext,
} from './index.js'

function ctx(extra: Record<string, number | string> = {}): FormulaContext {
  return { measurement_quantity: 0, measurement_unit: 'sqft', ...extra }
}

describe('evaluateFormulaUnsafe — normal arithmetic (plan §2 cases)', () => {
  it('"5 + 3" → 8', () => {
    const r = evaluateFormulaUnsafe('5 + 3', ctx())
    expect(r.ok).toBe(true)
    expect(r.value).toBe(8)
  })

  it('"x * 2" with {x:4} → 8', () => {
    const r = evaluateFormulaUnsafe('x * 2', ctx({ x: 4 }))
    expect(r.ok).toBe(true)
    expect(r.value).toBe(8)
  })

  it('"measurement_quantity * 1.1 / coverage_rate" → 17.1875', () => {
    const r = evaluateFormulaUnsafe('measurement_quantity * 1.1 / coverage_rate', {
      measurement_quantity: 500,
      measurement_unit: 'sqft',
      coverage_rate: 32,
    })
    expect(r.ok).toBe(true)
    expect(r.value).toBeCloseTo(17.1875, 10)
  })

  it('locale: "1.5 + 2.5" → 4 (decimal point, no comma grouping)', () => {
    const r = evaluateFormulaUnsafe('1.5 + 2.5', ctx())
    expect(r.ok).toBe(true)
    expect(r.value).toBe(4)
  })

  it('comma-grouped "1,000" is rejected as a syntax error (no locale grouping)', () => {
    const r = evaluateFormulaUnsafe('1,000', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SYNTAX_ERROR')
  })
})

describe('waste / coverage style formulas', () => {
  it('applies a waste multiplier: measurement_quantity * (1 + waste_pct/100)', () => {
    const r = evaluateFormulaUnsafe('measurement_quantity * (1 + waste_pct / 100)', {
      measurement_quantity: 1000,
      measurement_unit: 'sqft',
      waste_pct: 10,
    })
    expect(r.ok).toBe(true)
    expect(r.value).toBeCloseTo(1100, 10)
  })

  it('ceil of bags needed: ceil(measurement_quantity / coverage_rate)', () => {
    const r = evaluateFormulaUnsafe('ceil(measurement_quantity / coverage_rate)', {
      measurement_quantity: 500,
      measurement_unit: 'sqft',
      coverage_rate: 80,
    })
    expect(r.ok).toBe(true)
    expect(r.value).toBe(7) // 500/80 = 6.25 → 7
  })

  it('supports min/max/abs/floor/round/% and ^', () => {
    expect(evaluateFormulaUnsafe('max(3, 7)', ctx()).value).toBe(7)
    expect(evaluateFormulaUnsafe('min(3, 7)', ctx()).value).toBe(3)
    expect(evaluateFormulaUnsafe('abs(-5)', ctx()).value).toBe(5)
    expect(evaluateFormulaUnsafe('floor(2.9)', ctx()).value).toBe(2)
    expect(evaluateFormulaUnsafe('round(2.5)', ctx()).value).toBe(3)
    expect(evaluateFormulaUnsafe('7 % 3', ctx()).value).toBe(1)
    expect(evaluateFormulaUnsafe('2 ^ 3', ctx()).value).toBe(8)
  })

  it('supports if(cond, a, b) ternary-style builtin', () => {
    const r = evaluateFormulaUnsafe('if(measurement_quantity > 100, 2, 1)', {
      measurement_quantity: 250,
      measurement_unit: 'sqft',
    })
    expect(r.ok).toBe(true)
    expect(r.value).toBe(2)
  })

  it('negative results are allowed (caller signs by is_deduction)', () => {
    const r = evaluateFormulaUnsafe('measurement_quantity * -1', {
      measurement_quantity: 40,
      measurement_unit: 'lf',
    })
    expect(r.ok).toBe(true)
    expect(r.value).toBe(-40)
  })
})

describe('undefined variables', () => {
  it('"x + y" with only {x:1} → UNDEFINED_VARIABLE (not silent 0)', () => {
    const r = evaluateFormulaUnsafe('x + y', ctx({ x: 1 }))
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('UNDEFINED_VARIABLE')
    expect(r.error?.message).toContain('y')
  })

  it('reports all missing variables', () => {
    const r = evaluateFormulaUnsafe('a + b + c', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('UNDEFINED_VARIABLE')
    expect(r.error?.message).toContain('a')
    expect(r.error?.message).toContain('b')
    expect(r.error?.message).toContain('c')
  })
})

describe('invalid results', () => {
  it('"1 / 0" → DIVIDE_BY_ZERO', () => {
    const r = evaluateFormulaUnsafe('1 / 0', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('DIVIDE_BY_ZERO')
  })

  it('"measurement_quantity / 0" → DIVIDE_BY_ZERO', () => {
    const r = evaluateFormulaUnsafe('measurement_quantity / 0', {
      measurement_quantity: 100,
      measurement_unit: 'sqft',
    })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('DIVIDE_BY_ZERO')
  })

  it('"sqrt(-1)" → INVALID_RESULT (NaN)', () => {
    const r = evaluateFormulaUnsafe('sqrt(-1)', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('INVALID_RESULT')
  })

  it('result above the 1e9 magnitude bound → INVALID_RESULT', () => {
    const r = evaluateFormulaUnsafe('1e9 * 10', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('INVALID_RESULT')
  })

  it('non-finite input variable → INVALID_RESULT', () => {
    const r = evaluateFormulaUnsafe('x + 1', {
      measurement_quantity: 0,
      measurement_unit: 'sqft',
      x: Number.POSITIVE_INFINITY,
    })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('INVALID_RESULT')
  })
})

describe('empty / too-long / malformed input', () => {
  it('empty string → SYNTAX_ERROR', () => {
    const r = evaluateFormulaUnsafe('', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SYNTAX_ERROR')
  })

  it('whitespace-only → SYNTAX_ERROR', () => {
    const r = evaluateFormulaUnsafe('   ', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SYNTAX_ERROR')
  })

  it(`${MAX_FORMULA_LENGTH + 1}-char string → TOO_LONG`, () => {
    const long = `1${'+1'.repeat(MAX_FORMULA_LENGTH)}` // well over the cap
    expect(long.length).toBeGreaterThan(MAX_FORMULA_LENGTH)
    const r = evaluateFormulaUnsafe(long, ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('TOO_LONG')
  })

  it('malformed syntax → SYNTAX_ERROR', () => {
    const r = evaluateFormulaUnsafe('5 + * 3', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SYNTAX_ERROR')
  })

  it('unbalanced parens → SYNTAX_ERROR', () => {
    const r = evaluateFormulaUnsafe('(5 + 3', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SYNTAX_ERROR')
  })
})

describe('sandbox hardening (expr-eval advisory mitigations)', () => {
  it('member access is blocked (prototype-pollution path GHSA-8gw3-rxh4-v6jx)', () => {
    const r = evaluateFormulaUnsafe('x.constructor', ctx({ x: 1 }))
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SYNTAX_ERROR')
  })

  it('constructor walk on a literal is blocked', () => {
    const r = evaluateFormulaUnsafe('(0).constructor', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SYNTAX_ERROR')
  })

  it('assignment is disabled (no state mutation)', () => {
    const r = evaluateFormulaUnsafe('x = 5', ctx({ x: 1 }))
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SYNTAX_ERROR')
  })

  it('function definition is disabled', () => {
    const r = evaluateFormulaUnsafe('f(x) = x', ctx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SYNTAX_ERROR')
  })

  it('a function value in the context is rejected (GHSA-jc85-fpwf-qm7x)', () => {
    // Bypass the type system the way an untrusted JSON payload might.
    const hostile = {
      measurement_quantity: 1,
      measurement_unit: 'sqft',
      evil: (() => 1) as unknown as number,
    } as FormulaContext
    const r = evaluateFormulaUnsafe('measurement_quantity + 1', hostile)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('INVALID_RESULT')
  })
})

describe('parseFormula / evaluateFormula (cached handle path)', () => {
  it('parses once and evaluates many times', () => {
    const parsed = parseFormula('measurement_quantity * factor')
    expect(parsed.variables).toContain('measurement_quantity')
    expect(parsed.variables).toContain('factor')

    const a = evaluateFormula(parsed, { measurement_quantity: 10, measurement_unit: 'sqft', factor: 2 })
    const b = evaluateFormula(parsed, { measurement_quantity: 100, measurement_unit: 'sqft', factor: 3 })
    expect(a.value).toBe(20)
    expect(b.value).toBe(300)
  })

  it('parseFormula throws on too-long input', () => {
    const long = `1${'+1'.repeat(MAX_FORMULA_LENGTH)}`
    expect(() => parseFormula(long)).toThrow()
  })

  it('parseFormula throws on empty input', () => {
    expect(() => parseFormula('   ')).toThrow()
  })

  it('parseFormula throws on malformed syntax', () => {
    expect(() => parseFormula('5 +')).toThrow()
  })
})

describe('validateFormula', () => {
  it('valid simple formula → valid:true, no errors', () => {
    const r = validateFormula('measurement_quantity * 1.1')
    expect(r.valid).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('empty → invalid', () => {
    expect(validateFormula('').valid).toBe(false)
    expect(validateFormula('   ').valid).toBe(false)
  })

  it('too long → invalid', () => {
    const long = `1${'+1'.repeat(MAX_FORMULA_LENGTH)}`
    const r = validateFormula(long)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain(String(MAX_FORMULA_LENGTH))
  })

  it('malformed syntax → invalid with parser message', () => {
    const r = validateFormula('5 + * 3')
    expect(r.valid).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('requiredVars: references an allowed var → valid', () => {
    const r = validateFormula('measurement_quantity / coverage_rate', [
      'measurement_quantity',
      'measurement_unit',
      'coverage_rate',
    ])
    expect(r.valid).toBe(true)
  })

  it('requiredVars: references an unknown var → invalid', () => {
    const r = validateFormula('measurement_quantity / mystery_var', ['measurement_quantity', 'measurement_unit'])
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain('mystery_var')
  })
})
