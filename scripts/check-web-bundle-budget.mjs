#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// Per-app budget config. Thresholds are picked to be tight enough to catch
// regressions but not so tight that an honest dependency bump trips them.
//
// `requireSentryLazy` is a v1-only rule: v1's instrument loaded Sentry on
// idle so it didn't ship in the initial preload. v2's `apps/web-v2/src/
// instrument.ts` deliberately ships Sentry eagerly during Phase 0 (the
// substrate phase); ADR 0002 defers replay/web-vitals/offline-replay span
// integration to Phase 5. Re-enable the rule for v2 once that phase
// converts the import to a lazy chunk.
const APPS = {
  web: {
    distDir: 'apps/web/dist',
    initialJsGzipBudget: 160 * 1024,
    eagerChunkGzipBudget: 110 * 1024,
    lazyAppChunkGzipBudget: 40 * 1024,
    nonAppPrefixes: ['vendor-', 'web-vitals-', 'rolldown-runtime-'],
    requireSentryLazy: true,
  },
  'web-v2': {
    distDir: 'apps/web-v2/dist',
    initialJsGzipBudget: 160 * 1024,
    eagerChunkGzipBudget: 110 * 1024,
    lazyAppChunkGzipBudget: 40 * 1024,
    nonAppPrefixes: ['vendor-', 'web-vitals-', 'rolldown-runtime-', 'workbox-'],
    requireSentryLazy: false,
  },
}

const appName = process.argv[2] || 'web'
const config = APPS[appName]
if (!config) {
  console.error(`Unknown app: ${appName}. Known: ${Object.keys(APPS).join(', ')}`)
  process.exit(2)
}

const {
  distDir,
  initialJsGzipBudget,
  eagerChunkGzipBudget,
  lazyAppChunkGzipBudget,
  nonAppPrefixes,
  requireSentryLazy,
} = config
const assetDir = join(distDir, 'assets')
const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8')

function gzipSize(path) {
  return gzipSync(readFileSync(path)).length
}

function assetPath(href) {
  return href.replace(/^\//, '')
}

const eagerJs = new Set()
for (const match of indexHtml.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/g)) {
  eagerJs.add(assetPath(match[1]))
}
for (const match of indexHtml.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g)) {
  eagerJs.add(assetPath(match[1]))
}

const assets = readdirSync(assetDir)
  .filter((file) => file.endsWith('.js'))
  .map((file) => {
    const path = join(assetDir, file)
    return {
      file,
      path,
      raw: statSync(path).size,
      gzip: gzipSize(path),
      eager: eagerJs.has(`assets/${file}`),
    }
  })
  .sort((left, right) => right.gzip - left.gzip)

const eager = assets.filter((asset) => asset.eager)
const initialGzip = eager.reduce((sum, asset) => sum + asset.gzip, 0)
const failures = []

if (initialGzip > initialJsGzipBudget) {
  failures.push(`initial eager JS is ${initialGzip} bytes gzip, budget is ${initialJsGzipBudget} bytes gzip`)
}

for (const asset of eager) {
  if (asset.gzip > eagerChunkGzipBudget) {
    failures.push(`${asset.file} is eager and ${asset.gzip} bytes gzip, budget is ${eagerChunkGzipBudget}`)
  }
}

for (const asset of assets) {
  const isLazyAppChunk = !asset.eager && !nonAppPrefixes.some((prefix) => asset.file.startsWith(prefix))
  if (isLazyAppChunk && asset.gzip > lazyAppChunkGzipBudget) {
    failures.push(`${asset.file} is ${asset.gzip} bytes gzip, lazy app chunk budget is ${lazyAppChunkGzipBudget}`)
  }
}

if (requireSentryLazy && eager.some((asset) => asset.file.startsWith('vendor-sentry-'))) {
  failures.push('vendor-sentry is eagerly loaded; Sentry must stay idle-loaded')
}

console.log(`app=${appName}`)
console.log(`initial_eager_js_gzip=${initialGzip}`)
for (const asset of assets) {
  const marker = asset.eager ? 'eager' : 'lazy '
  console.log(`${marker} ${String(asset.gzip).padStart(7)} gzip ${String(asset.raw).padStart(8)} raw ${asset.file}`)
}

if (failures.length > 0) {
  console.error('\nBundle budget failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}
