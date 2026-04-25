#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const distDir = 'apps/web/dist'
const assetDir = join(distDir, 'assets')
const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8')

const INITIAL_JS_GZIP_BUDGET = 160 * 1024
const EAGER_CHUNK_GZIP_BUDGET = 110 * 1024
const LAZY_APP_CHUNK_GZIP_BUDGET = 40 * 1024

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

if (initialGzip > INITIAL_JS_GZIP_BUDGET) {
  failures.push(`initial eager JS is ${initialGzip} bytes gzip, budget is ${INITIAL_JS_GZIP_BUDGET} bytes gzip`)
}

for (const asset of eager) {
  if (asset.gzip > EAGER_CHUNK_GZIP_BUDGET) {
    failures.push(`${asset.file} is eager and ${asset.gzip} bytes gzip, budget is ${EAGER_CHUNK_GZIP_BUDGET}`)
  }
}

for (const asset of assets) {
  const isLazyAppChunk =
    !asset.eager &&
    !asset.file.startsWith('vendor-') &&
    !asset.file.startsWith('web-vitals-') &&
    !asset.file.startsWith('rolldown-runtime-')
  if (isLazyAppChunk && asset.gzip > LAZY_APP_CHUNK_GZIP_BUDGET) {
    failures.push(`${asset.file} is ${asset.gzip} bytes gzip, lazy app chunk budget is ${LAZY_APP_CHUNK_GZIP_BUDGET}`)
  }
}

if (eager.some((asset) => asset.file.startsWith('vendor-sentry-'))) {
  failures.push('vendor-sentry is eagerly loaded; Sentry must stay idle-loaded')
}

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
