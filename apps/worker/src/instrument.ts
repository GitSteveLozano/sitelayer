import * as Sentry from '@sentry/node'
import { registerSentry } from '@sitelayer/logger'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const LOCAL_ENV_FILES = ['.env', '.env.local', '.env.sentry.local', '.env.qbo.local']

function candidateDirs(startDir: string): string[] {
  const dirs: string[] = []
  let current = resolve(startDir)
  while (!dirs.includes(current)) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

function loadLocalEnv(startDir = process.cwd()) {
  const originalKeys = new Set(Object.keys(process.env))
  const loadedFiles = new Set<string>()
  for (const dir of candidateDirs(startDir)) {
    for (const fileName of LOCAL_ENV_FILES) {
      const filePath = join(dir, fileName)
      if (loadedFiles.has(filePath) || !existsSync(filePath)) continue
      loadedFiles.add(filePath)
      for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
        const eq = normalized.indexOf('=')
        if (eq <= 0) continue
        const key = normalized.slice(0, eq).trim()
        let value = normalized.slice(eq + 1).trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        const quote = value[0]
        if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1)
        if (originalKeys.has(key)) continue
        process.env[key] = value
      }
    }
  }
}

loadLocalEnv()

const dsn = process.env.SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.APP_TIER ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 1.0),
    sendDefaultPii: false,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.nativeNodeFetchIntegration(),
      Sentry.postgresIntegration(),
      Sentry.contextLinesIntegration(),
    ],
  })
}

registerSentry({
  getActiveSpan: () => {
    const span = Sentry.getActiveSpan()
    if (!span) return undefined
    return { spanContext: () => span.spanContext() }
  },
})

export { Sentry }
