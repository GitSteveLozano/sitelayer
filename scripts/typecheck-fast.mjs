#!/usr/bin/env node
// Fast, typecheck-only pass using tsgo (@typescript/native-preview) — the
// native Go port of the TypeScript compiler. Mirrors the stock `typecheck`
// script: it runs `tsgo --noEmit -p tsconfig.json` against every workspace
// that has a `typecheck` script, plus the e2e tsconfig.
//
// IMPORTANT: this is a developer convenience for fast feedback only. tsgo is
// typecheck-only (no emit) and still preview-quality, so the stock `tsc`-based
// `npm run typecheck` remains the release gate (verify-local.sh). Do NOT use
// tsgo for build/emit.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const tsgoBin = resolve(repoRoot, 'node_modules', '.bin', 'tsgo')

if (!existsSync(tsgoBin)) {
  console.error('[typecheck:fast] tsgo not found — run `npm install` (devDependency @typescript/native-preview).')
  process.exit(1)
}

// Discover workspace dirs from package.json workspaces globs (apps/*, packages/*).
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : []
const dirs = []
for (const g of globs) {
  if (!g.endsWith('/*')) continue
  const base = join(repoRoot, g.slice(0, -2))
  if (!existsSync(base)) continue
  for (const name of readdirSync(base)) {
    dirs.push(join(base, name))
  }
}

// A workspace participates if it has a tsconfig.json AND a `typecheck` script
// (matches what the stock `npm run typecheck --workspaces` covers).
const targets = []
for (const dir of dirs) {
  const pkgPath = join(dir, 'package.json')
  const tsconfigPath = join(dir, 'tsconfig.json')
  if (!existsSync(pkgPath) || !existsSync(tsconfigPath)) continue
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (!pkg.scripts || !pkg.scripts.typecheck) continue
  targets.push({ name: pkg.name ?? dir, tsconfig: tsconfigPath })
}

// Include the e2e project, mirroring `typecheck:e2e`.
const e2eTsconfig = join(repoRoot, 'e2e', 'tsconfig.json')
if (existsSync(e2eTsconfig)) {
  targets.push({ name: 'e2e', tsconfig: e2eTsconfig })
}

let failed = 0
for (const { name, tsconfig } of targets) {
  process.stdout.write(`[typecheck:fast] ${name} ... `)
  try {
    execFileSync(tsgoBin, ['--noEmit', '-p', tsconfig], { stdio: ['ignore', 'inherit', 'inherit'] })
    process.stdout.write('ok\n')
  } catch {
    failed += 1
    process.stdout.write('FAILED\n')
  }
}

if (failed > 0) {
  console.error(`\n[typecheck:fast] ${failed} workspace(s) failed.`)
  process.exit(1)
}
console.log(`\n[typecheck:fast] ${targets.length} workspace(s) clean.`)
