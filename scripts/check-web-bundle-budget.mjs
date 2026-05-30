#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// Per-app budget config. Thresholds are picked to be tight enough to catch
// regressions but not so tight that an honest dependency bump trips them.
const APPS = {
  web: {
    distDir: 'apps/web/dist',
    initialJsGzipBudget: 160 * 1024,
    eagerChunkGzipBudget: 110 * 1024,
    // Bumped from 44KB → 48KB on 2026-05-09 (round-2 design audit fixes)
    // when the mobile shell took on rental-requests-queue, the worker
    // resolution-display banner stack, the scope_step photo picker on
    // wk-log, and the wk-issue attachment upload flow. All mobile-shell
    // screens ride the m-*.js chunk by convention; only the More tab is
    // lazy. Original 40KB → 44KB bump documented in the design-handoff
    // chore commit. 48KB → 50KB on 2026-05-11 to fit the foreman manual
    // time-entry form (#303) + PWA onboarding screens (#300). 50KB → 56KB
    // on 2026-05-16 for the audit-follow-up bundle (#316): the headless
    // workflow factory, offline-queue Blob safety, clock-event photo
    // upload helper, and the scaffold-catalog + companycam screens that
    // landed via rebase from main. 56KB → 64KB on 2026-05-29 (#431) for the
    // Desktop v2 command-center build-out: the desktop-workspace lazy chunk
    // (the entire owner/estimator/foreman desktop app, loaded only when an
    // owner hits /desktop) took on rentals asset-detail/dispatch/return, the
    // canvas AI-assist palette + AI count/takeoff review, the settings panels
    // (company/working-hours/integrations/notifications), and the owner
    // approval/invoice modals — ~58KB gzip for the whole command center.
    // 64KB → 68KB on 2026-05-30 for PlanSwift Phase 1 takeoff drawing-surface
    // additions in the desktop-workspace chunk (est-canvas): vertex/ortho
    // snapping, point-level undo/redo, on-canvas dimension labels, and
    // cutout/deduct-area mode (DEDUCT toggle + signed render). The heavy PDFium
    // engine itself is NOT here — it's split into the exempt `vendor-pdf`
    // chunk; this is just the app-side drawing logic. ~64.2KB gzip.
    // 68KB → 72KB on 2026-05-30 for the Cavy-backlog estimator build-out in the
    // desktop-workspace chunk: the scope-vs-bid card + the per-project rate
    // editor (ProjectRatesModal), with the foreman Confirm-Day + estimate-vs-
    // actuals screens still to land. ~67.2KB gzip.
    lazyAppChunkGzipBudget: 72 * 1024,
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
