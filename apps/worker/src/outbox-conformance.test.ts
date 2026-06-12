// Outbox contract conformance ratchet.
//
// Three guarantees, enforced against the REAL registries and the REAL source
// tree (no DB needed):
//
//   1. The queue package's DEDICATED_HANDLER_MUTATION_TYPES and the worker's
//      DEDICATED_RUNNER_REGISTRY are identical sets, and every registered
//      handler module exists and contains its mutation_type literal.
//   2. The generic allowlist and the dedicated registry are disjoint.
//   3. EVERY mutation_type literal enqueued anywhere in the repo (via
//      recordMutationOutbox, recordMutationLedger, recordLedger, or a raw
//      `insert into mutation_outbox`) is either (a) in the generic
//      apply-with-no-work allowlist or (b) claimed by a dedicated runner.
//
// (3) is the ratchet: add an enqueue with a brand-new mutation_type and no
// handler and this test fails — which is exactly the silent-drop class that
// let send_estimate_share rows be stamped 'applied' while the customer email
// never sent.
//
// Extraction is source-text based (the enqueue sites are spread across two
// apps and three packages, and several use defaulted `action` values), so it
// is deliberately conservative: any call whose mutation type cannot be
// resolved to literals fails the test rather than passing silently.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  DEDICATED_HANDLER_MUTATION_TYPES,
  GENERIC_APPLY_MUTATION_TYPES,
  isGenericApplyMutationType,
} from '@sitelayer/queue'
import { DEDICATED_RUNNER_REGISTRY, WORKER_DEDICATED_MUTATION_TYPES } from './outbox-contract.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')

// Directories that can contain enqueue sites. node_modules/dist excluded.
const SCAN_ROOTS = ['apps/api/src', 'apps/worker/src', 'packages']

// Helper modules whose `insert into mutation_outbox` takes the mutation type
// as a bound parameter from THEIR caller — the callers are scanned instead.
const PARAMETERIZED_HELPER_FILES = new Set([
  'apps/api/src/mutation-tx.ts', // recordMutationOutbox / recordMutationLedger
  'packages/queue/src/ledger.ts', // recordLedger
])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) yield full
  }
}

/** Split a call-argument segment at top-level commas (depth-aware, quote-aware). */
function splitTopLevelArgs(segment: string): string[] {
  const args: string[] = []
  let depth = 0
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote) {
      current += ch
      if (ch === quote && segment[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        args.push(current)
        return args
      }
      depth--
    }
    if (ch === ',' && depth === 0) {
      args.push(current)
      current = ''
      continue
    }
    current += ch
  }
  args.push(current)
  return args
}

/** Extract the call segment starting right after `callName(` at index. */
function callSegment(src: string, openParenIdx: number): string {
  // Generous fixed window — enqueue calls are short; splitTopLevelArgs stops
  // at the balanced close anyway.
  return src.slice(openParenIdx + 1, openParenIdx + 4000)
}

type ExtractedType = { type: string; file: string; via: string }
type Unresolved = { file: string; via: string; raw: string }

/** Pull string literals out of an expression: 'x', "x", ternaries with two literal arms. */
function literalsFromExpression(expr: string): string[] | null {
  const trimmed = expr.trim()
  const single = trimmed.match(/^'([^']*)'$/) ?? trimmed.match(/^"([^"]*)"$/)
  if (single) return [single[1]!]
  // Template literal with a static prefix, e.g. `event:${eventType.toLowerCase()}`
  const template = trimmed.match(/^`([a-z0-9_:-]*)\$\{[^}]+\}`$/)
  if (template) return [`${template[1]}*`] // prefix wildcard marker
  // Ternary with two literal result arms, e.g. `wasInsert ? 'create' : 'restore'`.
  // Only the arms count — a literal inside the CONDITION (=== 'CLOSEOUT') is
  // not an enqueued type.
  const ternary = trimmed.match(/\?\s*'([^']+)'\s*:\s*'([^']+)'\s*$/)
  if (ternary) return [ternary[1]!, ternary[2]!]
  return null
}

/** Strip // line comments and block comments so prose mentioning enqueue
 * helpers (e.g. "recordMutationOutbox(..., 'welcome_email', ...)") is not
 * parsed as a call site. Conservative: only full-line // comments and
 * whitespace-preceded trailing // comments are removed, so `https://...`
 * inside string literals survives. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(\s)\/\/ .*$/gm, '$1')
}

function collectEnqueuedTypes(): { types: ExtractedType[]; unresolved: Unresolved[] } {
  const types: ExtractedType[] = []
  const unresolved: Unresolved[] = []

  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root)
    if (!existsSync(abs)) continue
    for (const file of walk(abs)) {
      const rel = relative(REPO_ROOT, file)
      if (PARAMETERIZED_HELPER_FILES.has(rel)) continue
      const src = stripComments(readFileSync(file, 'utf8'))

      // --- recordMutationOutbox(companyId, entityType, entityId, MUTATION_TYPE, ...)
      for (const m of src.matchAll(/recordMutationOutbox\(/g)) {
        const args = splitTopLevelArgs(callSegment(src, m.index! + m[0].length - 1))
        const arg = args[3]
        const lits = arg ? literalsFromExpression(arg) : null
        if (lits) for (const t of lits) types.push({ type: t, file: rel, via: 'recordMutationOutbox' })
        else unresolved.push({ file: rel, via: 'recordMutationOutbox', raw: (arg ?? '').trim().slice(0, 120) })
      }

      // --- recordMutationLedger / recordLedger({ ... mutationType | action ... })
      for (const m of src.matchAll(/record(?:Mutation)?Ledger\(/g)) {
        const seg = callSegment(src, m.index! + m[0].length - 1)
        const obj = seg.slice(0, 3500)
        const mt = obj.match(/mutationType:\s*([^\n,]+)/)
        const action = obj.match(/action:\s*([^\n,]+)/)
        const expr = (mt?.[1] ?? action?.[1] ?? '').trim()
        const lits = expr ? literalsFromExpression(expr) : null
        if (lits) for (const t of lits) types.push({ type: t, file: rel, via: 'recordMutationLedger' })
        else unresolved.push({ file: rel, via: 'recordMutationLedger', raw: expr.slice(0, 120) })
      }

      // File-level `const NAME = 'literal'` map, for resolving identifiers
      // passed through query parameter arrays (e.g. DISPATCH_MUTATION_TYPE).
      const fileConsts = new Map<string, string>()
      for (const cm of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) {
        fileConsts.set(cm[1]!, cm[2]!)
      }

      // --- raw `insert into mutation_outbox (...) values (...)` with either a
      // quoted literal in the mutation_type column position or a $n bound
      // param resolvable through the call's values array.
      for (const m of src.matchAll(/insert into mutation_outbox\s*\(([^)]+)\)/gi)) {
        const cols = m[1]!.split(',').map((c) => c.trim())
        const mtIdx = cols.indexOf('mutation_type')
        if (mtIdx === -1) continue
        const after = src.slice(m.index! + m[0].length)
        const valuesMatch = after.match(/values\s*\(/i)
        if (!valuesMatch) {
          unresolved.push({ file: rel, via: 'raw-insert', raw: 'no values() clause found' })
          continue
        }
        const valuesStart = valuesMatch.index! + valuesMatch[0].length
        const valueArgs = splitTopLevelArgs(after.slice(valuesStart, valuesStart + 3000))
        const valueExpr = (valueArgs[mtIdx] ?? '').trim()
        const lit = valueExpr.match(/^'([^']+)'$/)
        if (lit) {
          types.push({ type: lit[1]!, file: rel, via: 'raw-insert' })
          continue
        }
        const param = valueExpr.match(/^\$(\d+)/)
        if (param) {
          // Resolve through the query call's bound-values array: `after`
          // starts inside the SQL template literal, so its FIRST backtick is
          // the template's close; the next top-level `[ ... ]` is the
          // parameter array; take element n-1.
          const paramIdx = Number(param[1]) - 1
          const backtickEnd = after.indexOf('`')
          const arrayOpen = after.indexOf('[', backtickEnd)
          if (arrayOpen !== -1 && arrayOpen - backtickEnd < 200) {
            const elements = splitTopLevelArgs(after.slice(arrayOpen + 1, arrayOpen + 3000))
            const element = (elements[paramIdx] ?? '').trim()
            const elLits = literalsFromExpression(element)
            if (elLits) {
              for (const t of elLits) types.push({ type: t, file: rel, via: 'raw-insert' })
              continue
            }
            const ident = element.match(/^([A-Z][A-Z0-9_]*)$/)
            const resolved = ident ? fileConsts.get(ident[1]!) : undefined
            if (resolved) {
              types.push({ type: resolved, file: rel, via: 'raw-insert' })
              continue
            }
            unresolved.push({ file: rel, via: 'raw-insert', raw: `${valueExpr} ← ${element.slice(0, 100)}` })
            continue
          }
          unresolved.push({ file: rel, via: 'raw-insert', raw: valueExpr.slice(0, 120) })
          continue
        }
        unresolved.push({ file: rel, via: 'raw-insert', raw: valueExpr.slice(0, 120) })
      }
    }
  }
  return { types, unresolved }
}

function isRoutable(mutationType: string): boolean {
  if (mutationType.endsWith('*')) {
    // Prefix wildcard from a template literal — routable iff the static
    // prefix matches a generic prefix rule (e.g. `event:*`).
    const prefix = mutationType.slice(0, -1)
    return prefix.length > 0 && isGenericApplyMutationType(`${prefix}x`)
  }
  if (isGenericApplyMutationType(mutationType)) return true
  return (DEDICATED_HANDLER_MUTATION_TYPES as readonly string[]).includes(mutationType)
}

describe('outbox contract conformance', () => {
  it('queue DEDICATED_HANDLER_MUTATION_TYPES === worker DEDICATED_RUNNER_REGISTRY keys', () => {
    expect([...DEDICATED_HANDLER_MUTATION_TYPES].sort()).toEqual([...WORKER_DEDICATED_MUTATION_TYPES].sort())
  })

  it('every registered dedicated handler module exists and references its mutation_type literal', () => {
    for (const [mutationType, modulePath] of Object.entries(DEDICATED_RUNNER_REGISTRY)) {
      const abs = join(REPO_ROOT, modulePath)
      expect(existsSync(abs), `registry module missing: ${modulePath} (for ${mutationType})`).toBe(true)
      const src = readFileSync(abs, 'utf8')
      expect(
        src.includes(`'${mutationType}'`),
        `${modulePath} does not reference '${mutationType}' — wrong module in DEDICATED_RUNNER_REGISTRY?`,
      ).toBe(true)
    }
  })

  it('generic allowlist and dedicated registry are disjoint', () => {
    for (const t of DEDICATED_HANDLER_MUTATION_TYPES) {
      expect(isGenericApplyMutationType(t), `${t} is in BOTH registries`).toBe(false)
    }
    for (const t of GENERIC_APPLY_MUTATION_TYPES) {
      expect([...WORKER_DEDICATED_MUTATION_TYPES]).not.toContain(t)
    }
  })

  it('RATCHET: every mutation_type enqueued anywhere is generic-allowlisted or dedicated-claimed', () => {
    const { types, unresolved } = collectEnqueuedTypes()

    // The scan must actually find the known seams; if it finds nothing the
    // extractor regressed, not the codebase.
    expect(types.length).toBeGreaterThan(30)
    const found = new Set(types.map((t) => t.type))
    for (const sentinel of ['send_estimate_share', 'welcome_email', 'damage_charge_invoice_push', 'create']) {
      expect(found.has(sentinel), `extractor regression: expected to find enqueue of '${sentinel}'`).toBe(true)
    }

    const unroutable = types.filter((t) => !isRoutable(t.type))
    expect(
      unroutable,
      `unroutable mutation_type enqueues (no generic allowlist entry, no dedicated runner):\n` +
        unroutable.map((t) => `  '${t.type}' enqueued via ${t.via} in ${t.file}`).join('\n') +
        `\nFix: register a runner (apps/worker/src/outbox-contract.ts + packages/queue DEDICATED_HANDLER_MUTATION_TYPES)` +
        ` or, ONLY if the row is a pure audit anchor, add it to GENERIC_APPLY_MUTATION_TYPES.`,
    ).toEqual([])

    expect(
      unresolved,
      `enqueue sites whose mutation_type could not be resolved to literals:\n` +
        unresolved.map((u) => `  via ${u.via} in ${u.file}: ${u.raw}`).join('\n') +
        `\nUse a string literal (or a ternary of literals) at the enqueue site, or teach the extractor.`,
    ).toEqual([])
  })
})
