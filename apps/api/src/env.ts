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

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
  const separatorIndex = normalized.indexOf('=')
  if (separatorIndex <= 0) return null

  const key = normalized.slice(0, separatorIndex).trim()
  let value = normalized.slice(separatorIndex + 1).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null

  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1)
  }

  return [key, value]
}

export function loadLocalEnv(startDir = process.cwd()) {
  const originalKeys = new Set(Object.keys(process.env))
  const loadedFiles = new Set<string>()

  for (const dir of candidateDirs(startDir)) {
    for (const fileName of LOCAL_ENV_FILES) {
      const filePath = join(dir, fileName)
      if (loadedFiles.has(filePath) || !existsSync(filePath)) continue
      loadedFiles.add(filePath)

      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
      for (const line of lines) {
        const parsed = parseEnvLine(line)
        if (!parsed) continue
        const [key, value] = parsed
        if (originalKeys.has(key)) continue
        process.env[key] = value
      }
    }
  }
}
