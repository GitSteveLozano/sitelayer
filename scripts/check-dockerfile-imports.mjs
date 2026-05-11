#!/usr/bin/env node
// Guards against the Dockerfile copy-list drift that took prod down on
// 2026-05-10 (hotfix #278). The runtime stage of `Dockerfile` only ships
// the packages it explicitly COPYs out of the builder stage, but new
// `@sitelayer/*` workspace packages get added to apps/{api,worker} all
// the time. If a package is imported by api or worker but missing from
// the runtime image, the container boots and crashes on first
// `require('@sitelayer/<name>')`.
//
// This guard parses `apps/api/src` + `apps/worker/src` for top-level
// `@sitelayer/*` imports, scans the Dockerfile's runtime stage for
// `COPY --from=builder /app/packages/<name>/dist` lines, and fails CI
// when an import has no matching copy line.
//
// Read-only; no fixes attempted. The fix is always a one-line Dockerfile
// edit — the script's job is to surface the gap before the deploy does.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())

// Apps whose runtime image is the one Dockerfile builds. apps/web is
// not a runtime consumer of workspace packages (it gets bundled by
// Vite into apps/web/dist and served as static assets), so we skip it.
const RUNTIME_APPS = ['apps/api', 'apps/worker']

// Packages allowlisted because they're not workspace deps (false
// positives from regex). Empty for now — every `@sitelayer/*` we
// import is a workspace dep.
const ALLOWLIST = new Set([])

function walk(dir, out = []) {
  if (!safeIsDir(dir)) return out
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    let s
    try {
      s = statSync(p)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
      walk(p, out)
    } else if (s.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !/\.(test|spec)\.[^.]+$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

function safeIsDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const IMPORT_REGEX = /(?:from|require\(|import\(?)\s*['"](@sitelayer\/[a-z][a-z0-9-]*)['"]/g

function collectImports(appDir) {
  const imports = new Set()
  const files = walk(resolve(ROOT, appDir, 'src'))
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const match of src.matchAll(IMPORT_REGEX)) {
      imports.add(match[1])
    }
  }
  return imports
}

function parseDockerfileCopies(path) {
  const src = readFileSync(path, 'utf8')
  // Match COPY --from=builder /app/packages/<NAME>/dist /app/packages/<NAME>/dist
  const re = /COPY\s+--from=builder\s+\/app\/packages\/([a-z][a-z0-9-]*)\/dist\s/g
  const copied = new Set()
  for (const match of src.matchAll(re)) {
    copied.add(`@sitelayer/${match[1]}`)
  }
  return copied
}

const importsByApp = {}
for (const app of RUNTIME_APPS) {
  importsByApp[app] = collectImports(app)
}
const unionImports = new Set()
for (const set of Object.values(importsByApp)) {
  for (const x of set) unionImports.add(x)
}
const copied = parseDockerfileCopies(resolve(ROOT, 'Dockerfile'))

const missing = []
for (const name of unionImports) {
  if (ALLOWLIST.has(name)) continue
  if (!copied.has(name)) missing.push(name)
}

// Symmetric report: copies that no app imports. Not a failure (the
// Dockerfile can stage a package the apps will need later), but log
// it so the copy list doesn't accumulate dead entries forever.
const unused = []
for (const name of copied) {
  let used = false
  for (const set of Object.values(importsByApp)) {
    if (set.has(name)) {
      used = true
      break
    }
  }
  if (!used) unused.push(name)
}

if (missing.length === 0) {
  console.log(
    `dockerfile-imports: ok (${unionImports.size} @sitelayer/* imports across ${RUNTIME_APPS.join(', ')}, all present in Dockerfile)`,
  )
  if (unused.length > 0) {
    console.warn(
      `dockerfile-imports: note — Dockerfile stages ${unused.length} unused package(s): ${unused.join(', ')}`,
    )
  }
  process.exit(0)
}

console.error('dockerfile-imports: FAIL')
console.error('')
console.error('The following @sitelayer/* packages are imported by apps/{api,worker}/src')
console.error('but are not COPYed into the Dockerfile runtime stage. The container will')
console.error('start, then crash at module load with "Cannot find module" on production.')
console.error('')
for (const name of missing) {
  const whichApps = RUNTIME_APPS.filter((app) => importsByApp[app].has(name))
  console.error(`  - ${name}    (imported by ${whichApps.join(', ')})`)
}
console.error('')
console.error('Fix: add corresponding COPY directives to the runtime stage of Dockerfile,')
console.error('mirroring the existing pattern, e.g. for @sitelayer/example:')
console.error('  COPY --from=builder /app/packages/example/package.json /app/packages/example/package.json')
console.error('  COPY --from=builder /app/packages/example/dist /app/packages/example/dist')
process.exit(1)
