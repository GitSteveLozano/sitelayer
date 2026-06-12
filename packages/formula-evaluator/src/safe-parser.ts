/**
 * Self-contained safe expression engine — the replacement for `expr-eval`
 * (dropped 2026-06-12 over unfixed HIGH advisories GHSA-8gw3-rxh4-v6jx
 * prototype pollution and GHSA-jc85-fpwf-qm7x unrestricted evaluate
 * functions).
 *
 * Design constraints (security first):
 *
 * - **No `eval` / `new Function`** anywhere — a hand-rolled tokenizer +
 *   recursive-descent parser produces a plain AST that is interpreted by a
 *   tree walk.
 * - **Whitelist-only surface.** Only the operators and functions in the
 *   tables below exist. There is no member access (`.` is not even a token),
 *   no indexing (`[`), no assignment (`=`), no function definition, no
 *   arrays, no `in`, no string concatenation operator. An unknown function
 *   name is a parse-time error.
 * - **Prototype-pollution-safe lookups.** The operator/function/constant
 *   tables are built with `Object.create(null)`, and every dynamic lookup
 *   (including variable resolution at evaluate time) goes through an
 *   own-property check. `__proto__`, `constructor`, `toString`, … are inert
 *   identifiers: they resolve only if the caller explicitly supplied them as
 *   own properties of the scope, and otherwise behave like any other
 *   undefined variable.
 *
 * Semantics intentionally mirror the expr-eval 2.0.2 subset this package
 * exposed (the operator implementations below are line-for-line ports), so
 * existing stored formulas keep evaluating identically:
 * `+` coerces with `Number()`, comparisons are strict (`===`/`!==`),
 * `and`/`or` return `Boolean(a && b)` / `Boolean(a || b)`, `^` is
 * `Math.pow` (right-associative, binding tighter than unary minus:
 * `-2^2 === -4`), and `if(cond, a, b)` / `cond ? a : b` mirror expr-eval's
 * `condition` builtin.
 */

/** Values a formula scope may bind (enforced upstream by `coerceContext`). */
export type EvaluationScope = Record<string, number | string>

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type AstNode =
  | { kind: 'literal'; value: number | string | boolean }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; op: UnaryOpName; arg: AstNode }
  | { kind: 'binary'; op: BinaryOpName; left: AstNode; right: AstNode }
  | { kind: 'ternary'; cond: AstNode; truthy: AstNode; falsy: AstNode }
  | { kind: 'call'; name: string; args: AstNode[] }

// ---------------------------------------------------------------------------
// Operator tables (semantics ported verbatim from expr-eval 2.0.2)
// ---------------------------------------------------------------------------

type BinaryOpName = '+' | '-' | '*' | '/' | '%' | '^' | '==' | '!=' | '>' | '<' | '>=' | '<=' | 'and' | 'or'

const BINARY_OPS: Record<BinaryOpName, (a: unknown, b: unknown) => unknown> = {
  // expr-eval's `add` coerces both sides with Number() (so 'a' + 'b' → NaN,
  // never string concatenation).
  '+': (a, b) => Number(a) + Number(b),
  '-': (a, b) => (a as number) - (b as number),
  '*': (a, b) => (a as number) * (b as number),
  '/': (a, b) => (a as number) / (b as number),
  '%': (a, b) => (a as number) % (b as number),
  '^': (a, b) => Math.pow(a as number, b as number),
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>': (a, b) => (a as number) > (b as number),
  '<': (a, b) => (a as number) < (b as number),
  '>=': (a, b) => (a as number) >= (b as number),
  '<=': (a, b) => (a as number) <= (b as number),
  and: (a, b) => Boolean(a && b),
  or: (a, b) => Boolean(a || b),
}

type UnaryOpName = '-' | '+' | 'not'

const UNARY_OPS: Record<UnaryOpName, (a: unknown) => unknown> = {
  '-': (a) => -(a as number),
  '+': (a) => Number(a),
  not: (a) => !a,
}

/**
 * Decimal adjustment (port of expr-eval's `roundTo`, originally from
 * @escopecz) so `roundTo(1.005, 2)` keeps its exact historical behavior.
 */
function roundTo(value: unknown, exp: unknown): number {
  if (typeof exp === 'undefined' || +(exp as number) === 0) {
    return Math.round(value as number)
  }
  const v = +(value as number)
  const e = -+(exp as number)
  if (Number.isNaN(v) || !(typeof e === 'number' && e % 1 === 0)) {
    return NaN
  }
  const shifted = v.toString().split('e')
  const rounded = Math.round(+`${shifted[0]}e${shifted[1] ? +shifted[1] - e : -e}`)
  const back = rounded.toString().split('e')
  return +`${back[0]}e${back[1] ? +back[1] + e : e}`
}

interface FunctionSpec {
  minArgs: number
  /** `Infinity` = variadic. */
  maxArgs: number
  apply: (args: unknown[]) => unknown
}

function unaryFn(fn: (x: number) => number): FunctionSpec {
  return { minArgs: 1, maxArgs: 1, apply: (args) => fn(args[0] as number) }
}

/**
 * The complete callable surface. Deliberately EXCLUDED from expr-eval's
 * catalog: `random` (non-deterministic), `fac`/`gamma` (factorial — never a
 * construction formula), and `map`/`fold`/`filter`/`indexOf`/`join` (take
 * function/array arguments — the exact GHSA-jc85-fpwf-qm7x injection
 * surface).
 */
const FUNCTIONS: Record<string, FunctionSpec> = Object.assign(Object.create(null) as Record<string, FunctionSpec>, {
  abs: unaryFn(Math.abs),
  ceil: unaryFn(Math.ceil),
  floor: unaryFn(Math.floor),
  round: unaryFn(Math.round),
  trunc: unaryFn(Math.trunc),
  sign: unaryFn(Math.sign),
  sqrt: unaryFn(Math.sqrt),
  cbrt: unaryFn(Math.cbrt),
  exp: unaryFn(Math.exp),
  expm1: unaryFn(Math.expm1),
  log: unaryFn(Math.log),
  ln: unaryFn(Math.log),
  lg: unaryFn(Math.log10),
  log10: unaryFn(Math.log10),
  log2: unaryFn(Math.log2),
  log1p: unaryFn(Math.log1p),
  sin: unaryFn(Math.sin),
  cos: unaryFn(Math.cos),
  tan: unaryFn(Math.tan),
  asin: unaryFn(Math.asin),
  acos: unaryFn(Math.acos),
  atan: unaryFn(Math.atan),
  sinh: unaryFn(Math.sinh),
  cosh: unaryFn(Math.cosh),
  tanh: unaryFn(Math.tanh),
  asinh: unaryFn(Math.asinh),
  acosh: unaryFn(Math.acosh),
  atanh: unaryFn(Math.atanh),
  min: { minArgs: 0, maxArgs: Infinity, apply: (args) => Math.min(...(args as number[])) },
  max: { minArgs: 0, maxArgs: Infinity, apply: (args) => Math.max(...(args as number[])) },
  hypot: { minArgs: 0, maxArgs: Infinity, apply: (args) => Math.hypot(...(args as number[])) },
  pow: { minArgs: 2, maxArgs: 2, apply: (args) => Math.pow(args[0] as number, args[1] as number) },
  atan2: { minArgs: 2, maxArgs: 2, apply: (args) => Math.atan2(args[0] as number, args[1] as number) },
  roundTo: { minArgs: 1, maxArgs: 2, apply: (args) => roundTo(args[0], args[1]) },
  if: { minArgs: 3, maxArgs: 3, apply: (args) => (args[0] ? args[1] : args[2]) },
  length: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => {
      const s = args[0]
      if (typeof s !== 'string') throw new Error('length expects a string argument')
      return s.length
    },
  },
} satisfies Record<string, FunctionSpec>)

/** Parse-time constants (mirrors expr-eval's `consts`; they shadow scope vars). */
const CONSTANTS: Record<string, number | boolean> = Object.assign(
  Object.create(null) as Record<string, number | boolean>,
  {
    PI: Math.PI,
    E: Math.E,
    true: true,
    false: false,
  },
)

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { type: 'number'; value: number; pos: number }
  | { type: 'string'; value: string; pos: number }
  | { type: 'ident'; name: string; pos: number }
  | { type: 'punct'; value: string; pos: number }
  | { type: 'eof'; pos: number }

const TWO_CHAR_PUNCT = ['==', '!=', '>=', '<='] as const
const ONE_CHAR_PUNCT = new Set(['+', '-', '*', '/', '%', '^', '(', ')', ',', '>', '<', '?', ':'])

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c)
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)

const ESCAPES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  "'": "'",
  '"': '"',
  '\\': '\\',
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
})

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i] as string
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1
      continue
    }

    // Numbers: digits, optional fraction, optional exponent. A leading-dot
    // fraction (`.5`) is also accepted, matching expr-eval.
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      const start = i
      while (i < source.length && isDigit(source[i] as string)) i += 1
      if (source[i] === '.') {
        i += 1
        while (i < source.length && isDigit(source[i] as string)) i += 1
      }
      if (source[i] === 'e' || source[i] === 'E') {
        let j = i + 1
        if (source[j] === '+' || source[j] === '-') j += 1
        if (isDigit(source[j] ?? '')) {
          i = j
          while (i < source.length && isDigit(source[i] as string)) i += 1
        }
      }
      const text = source.slice(start, i)
      const value = Number(text)
      if (!Number.isFinite(value) && !text.includes('e') && !text.includes('E')) {
        throw new Error(`invalid number "${text}" at position ${start}`)
      }
      tokens.push({ type: 'number', value, pos: start })
      continue
    }

    // String literals (single or double quoted, with simple escapes).
    if (c === "'" || c === '"') {
      const quote = c
      const start = i
      i += 1
      let out = ''
      let closed = false
      while (i < source.length) {
        const ch = source[i] as string
        if (ch === '\\') {
          const esc = source[i + 1]
          if (esc !== undefined && hasOwn(ESCAPES, esc)) {
            out += ESCAPES[esc] as string
            i += 2
            continue
          }
          throw new Error(`invalid escape sequence at position ${i}`)
        }
        if (ch === quote) {
          closed = true
          i += 1
          break
        }
        out += ch
        i += 1
      }
      if (!closed) throw new Error(`unterminated string starting at position ${start}`)
      tokens.push({ type: 'string', value: out, pos: start })
      continue
    }

    if (isIdentStart(c)) {
      const start = i
      while (i < source.length && isIdentPart(source[i] as string)) i += 1
      tokens.push({ type: 'ident', name: source.slice(start, i), pos: start })
      continue
    }

    const two = source.slice(i, i + 2)
    if ((TWO_CHAR_PUNCT as readonly string[]).includes(two)) {
      tokens.push({ type: 'punct', value: two, pos: i })
      i += 2
      continue
    }
    if (ONE_CHAR_PUNCT.has(c)) {
      tokens.push({ type: 'punct', value: c, pos: i })
      i += 1
      continue
    }

    // Everything else — including `.` member access, `[` indexing, `=`
    // assignment, `!` factorial, `&`/`|`/`;` — is not part of the whitelist.
    throw new Error(`unexpected character "${c}" at position ${i}`)
  }
  tokens.push({ type: 'eof', pos: source.length })
  return tokens
}

// ---------------------------------------------------------------------------
// Parser (recursive descent; precedence mirrors expr-eval)
// ---------------------------------------------------------------------------

const COMPARISON_OPS = new Set(['==', '!=', '>', '<', '>=', '<='])

class FormulaParser {
  private readonly tokens: Token[]
  private index = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  parse(): AstNode {
    const node = this.parseTernary()
    const tok = this.peek()
    if (tok.type !== 'eof') {
      throw new Error(`unexpected ${describeToken(tok)} at position ${tok.pos} (expected end of formula)`)
    }
    return node
  }

  private peek(): Token {
    return this.tokens[this.index] as Token
  }

  private next(): Token {
    const tok = this.tokens[this.index] as Token
    if (tok.type !== 'eof') this.index += 1
    return tok
  }

  private acceptPunct(value: string): boolean {
    const tok = this.peek()
    if (tok.type === 'punct' && tok.value === value) {
      this.index += 1
      return true
    }
    return false
  }

  private acceptKeyword(name: string): boolean {
    const tok = this.peek()
    if (tok.type === 'ident' && tok.name === name) {
      this.index += 1
      return true
    }
    return false
  }

  private expectPunct(value: string): void {
    const tok = this.peek()
    if (tok.type === 'punct' && tok.value === value) {
      this.index += 1
      return
    }
    throw new Error(`expected "${value}" but found ${describeToken(tok)} at position ${tok.pos}`)
  }

  /** `cond ? a : b` — right-associative, branches evaluated lazily. */
  private parseTernary(): AstNode {
    const cond = this.parseOr()
    if (!this.acceptPunct('?')) return cond
    const truthy = this.parseTernary()
    this.expectPunct(':')
    const falsy = this.parseTernary()
    return { kind: 'ternary', cond, truthy, falsy }
  }

  private parseOr(): AstNode {
    let left = this.parseAnd()
    while (this.acceptKeyword('or')) {
      left = { kind: 'binary', op: 'or', left, right: this.parseAnd() }
    }
    return left
  }

  private parseAnd(): AstNode {
    let left = this.parseComparison()
    while (this.acceptKeyword('and')) {
      left = { kind: 'binary', op: 'and', left, right: this.parseComparison() }
    }
    return left
  }

  private parseComparison(): AstNode {
    let left = this.parseAdditive()
    for (;;) {
      const tok = this.peek()
      if (tok.type === 'punct' && COMPARISON_OPS.has(tok.value)) {
        this.index += 1
        left = { kind: 'binary', op: tok.value as BinaryOpName, left, right: this.parseAdditive() }
        continue
      }
      return left
    }
  }

  private parseAdditive(): AstNode {
    let left = this.parseMultiplicative()
    for (;;) {
      if (this.acceptPunct('+')) {
        left = { kind: 'binary', op: '+', left, right: this.parseMultiplicative() }
      } else if (this.acceptPunct('-')) {
        left = { kind: 'binary', op: '-', left, right: this.parseMultiplicative() }
      } else {
        return left
      }
    }
  }

  private parseMultiplicative(): AstNode {
    let left = this.parseUnary()
    for (;;) {
      const tok = this.peek()
      if (tok.type === 'punct' && (tok.value === '*' || tok.value === '/' || tok.value === '%')) {
        this.index += 1
        left = { kind: 'binary', op: tok.value as BinaryOpName, left, right: this.parseUnary() }
        continue
      }
      return left
    }
  }

  /**
   * Unary binds LOOSER than `^` (expr-eval's factor/exponential split):
   * `-2^2 === -(2^2) === -4`, while `2^-3` still parses (the right side of
   * `^` re-enters here).
   */
  private parseUnary(): AstNode {
    if (this.acceptPunct('-')) return { kind: 'unary', op: '-', arg: this.parseUnary() }
    if (this.acceptPunct('+')) return { kind: 'unary', op: '+', arg: this.parseUnary() }
    if (this.acceptKeyword('not')) return { kind: 'unary', op: 'not', arg: this.parseUnary() }
    return this.parseExponent()
  }

  private parseExponent(): AstNode {
    const base = this.parsePrimary()
    if (this.acceptPunct('^')) {
      // Right-associative; RHS may carry unary signs (2^-3).
      return { kind: 'binary', op: '^', left: base, right: this.parseUnary() }
    }
    return base
  }

  private parsePrimary(): AstNode {
    const tok = this.next()
    if (tok.type === 'number') return { kind: 'literal', value: tok.value }
    if (tok.type === 'string') return { kind: 'literal', value: tok.value }
    if (tok.type === 'punct' && tok.value === '(') {
      const inner = this.parseTernary()
      this.expectPunct(')')
      return inner
    }
    if (tok.type === 'ident') {
      // Function call?
      if (this.acceptPunct('(')) {
        return this.parseCall(tok.name, tok.pos)
      }
      // Parse-time constant (PI / E / true / false) — shadows scope vars,
      // matching expr-eval's consts behavior.
      if (hasOwn(CONSTANTS, tok.name)) {
        return { kind: 'literal', value: CONSTANTS[tok.name] as number | boolean }
      }
      return { kind: 'variable', name: tok.name }
    }
    throw new Error(`unexpected ${describeToken(tok)} at position ${tok.pos}`)
  }

  private parseCall(name: string, pos: number): AstNode {
    if (!hasOwn(FUNCTIONS, name)) {
      throw new Error(`unknown function "${name}" at position ${pos}`)
    }
    const spec = FUNCTIONS[name] as FunctionSpec
    const args: AstNode[] = []
    if (!this.acceptPunct(')')) {
      do {
        args.push(this.parseTernary())
      } while (this.acceptPunct(','))
      this.expectPunct(')')
    }
    if (args.length < spec.minArgs || args.length > spec.maxArgs) {
      const expected =
        spec.maxArgs === Infinity
          ? `at least ${spec.minArgs}`
          : spec.minArgs === spec.maxArgs
            ? `${spec.minArgs}`
            : `${spec.minArgs}-${spec.maxArgs}`
      throw new Error(`function "${name}" expects ${expected} argument(s), got ${args.length}`)
    }
    return { kind: 'call', name, args }
  }
}

function describeToken(tok: Token): string {
  switch (tok.type) {
    case 'eof':
      return 'end of formula'
    case 'number':
      return `number ${tok.value}`
    case 'string':
      return 'string literal'
    case 'ident':
      return `"${tok.name}"`
    case 'punct':
      return `"${tok.value}"`
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function evaluateNode(node: AstNode, scope: EvaluationScope): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'variable': {
      // Own-property lookup ONLY — `__proto__`, `constructor`, `toString`, …
      // never resolve through the prototype chain (the scope is also built
      // with Object.create(null) upstream; this check is defense in depth).
      if (hasOwn(scope, node.name)) {
        return scope[node.name]
      }
      throw new Error(`undefined variable: ${node.name}`)
    }
    case 'unary':
      return UNARY_OPS[node.op](evaluateNode(node.arg, scope))
    case 'binary':
      return BINARY_OPS[node.op](evaluateNode(node.left, scope), evaluateNode(node.right, scope))
    case 'ternary':
      return evaluateNode(node.cond, scope) ? evaluateNode(node.truthy, scope) : evaluateNode(node.falsy, scope)
    case 'call': {
      const spec = FUNCTIONS[node.name]
      if (spec === undefined) throw new Error(`unknown function "${node.name}"`)
      const args = node.args.map((arg) => evaluateNode(arg, scope))
      return spec.apply(args)
    }
  }
}

function collectVariables(node: AstNode, out: string[], seen: Set<string>): void {
  switch (node.kind) {
    case 'literal':
      return
    case 'variable':
      if (!seen.has(node.name)) {
        seen.add(node.name)
        out.push(node.name)
      }
      return
    case 'unary':
      collectVariables(node.arg, out, seen)
      return
    case 'binary':
      collectVariables(node.left, out, seen)
      collectVariables(node.right, out, seen)
      return
    case 'ternary':
      collectVariables(node.cond, out, seen)
      collectVariables(node.truthy, out, seen)
      collectVariables(node.falsy, out, seen)
      return
    case 'call':
      for (const arg of node.args) collectVariables(arg, out, seen)
      return
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * A parsed, immutable formula handle. Structurally compatible with the
 * `ParsedFormula.expression` slot in `types.ts`.
 */
export class SafeExpression {
  private readonly ast: AstNode
  /** Distinct referenced variable names, in order of first appearance. */
  readonly variableNames: readonly string[]

  constructor(ast: AstNode) {
    this.ast = ast
    const out: string[] = []
    collectVariables(ast, out, new Set())
    this.variableNames = out
  }

  /** Tree-walk evaluation. May return number | string | boolean. */
  evaluate(scope: EvaluationScope): unknown {
    return evaluateNode(this.ast, scope)
  }
}

/**
 * Parse a formula into a {@link SafeExpression}.
 *
 * @throws Error on any syntax violation: malformed input, characters outside
 * the whitelist (`.` `[` `=` `!` `&` `|` …), unknown function names, or
 * function arity mismatches.
 */
export function parseSafeExpression(source: string): SafeExpression {
  return new SafeExpression(new FormulaParser(tokenize(source)).parse())
}
