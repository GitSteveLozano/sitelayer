/**
 * Build-SHA resolution shared by the `/api/version` endpoint and the
 * `x-sitelayer-build-sha` response header.
 *
 * The Probe (`apps/web/src/lib/probe/estimate-push.ts`) used to hit
 * `/api/version` once per page load to read the build sha. Surfacing the
 * sha on every response saves that round-trip — the SPA's API client
 * latches the value off the first response it sees and caches it for the
 * page lifetime.
 *
 * Resolution order:
 *   1. `SITELAYER_BUILD_SHA` env var (preferred — the task contract).
 *   2. `APP_BUILD_SHA` env var (legacy convention used by
 *      `docker-compose.prod.yml` and the existing `buildSha` constant in
 *      `server.ts`; kept so existing deploys keep working unchanged).
 *   3. `SENTRY_RELEASE` env var (third fallback, matches the
 *      pre-existing `buildSha` chain in `server.ts`).
 *   4. The contents of a `BUILD_SHA` file at the repo root. Read
 *      synchronously at boot — this module is imported by `server.ts`
 *      during init, before any request is handled, so the FS hit is
 *      paid once.
 *   5. Literal `'dev'`.
 *
 * Returning `'dev'` rather than `'unknown'` matches the task contract;
 * downstream consumers (Sentry, support packets, the SPA Probe) treat
 * any non-empty string as opaque.
 */
import fs from 'node:fs'
import path from 'node:path'

const BUILD_SHA_FILE_NAME = 'BUILD_SHA'
const DEFAULT_BUILD_SHA = 'dev'

/**
 * Walk up from `startDir` looking for a `BUILD_SHA` file. Caps at 8
 * levels so a misconfigured CWD can't pin us in an infinite traversal.
 * Returns `null` when no file is found.
 */
function findBuildShaFile(startDir: string): string | null {
  let dir = path.resolve(startDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, BUILD_SHA_FILE_NAME)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // missing or unreadable — keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

function readBuildShaFile(startDir: string): string | null {
  const file = findBuildShaFile(startDir)
  if (!file) return null
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    return raw || null
  } catch {
    return null
  }
}

export interface ResolveBuildShaOptions {
  /** Environment to read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Directory to start the BUILD_SHA file search from. Defaults to `process.cwd()`. */
  startDir?: string
  /** Override the literal returned when every other source is empty. */
  fallback?: string
}

/**
 * Pure resolver. Exported so the unit test can pin both inputs without
 * touching process state.
 */
export function resolveBuildSha(opts: ResolveBuildShaOptions = {}): string {
  const env = opts.env ?? process.env
  const fallback = opts.fallback ?? DEFAULT_BUILD_SHA
  const startDir = opts.startDir ?? process.cwd()

  const fromEnv =
    env.SITELAYER_BUILD_SHA?.trim() || env.APP_BUILD_SHA?.trim() || env.SENTRY_RELEASE?.trim() || ''
  if (fromEnv) return fromEnv

  const fromFile = readBuildShaFile(startDir)
  if (fromFile) return fromFile

  return fallback
}

let cached: string | null = null

/**
 * Resolve the build sha at boot and memoize for the process lifetime.
 * `server.ts` calls this once and reuses the value on every request.
 */
export function getBuildSha(): string {
  if (cached === null) cached = resolveBuildSha()
  return cached
}

/** Test-only — reset the cache so unit tests can assert different inputs. */
export function __resetBuildShaCacheForTests(): void {
  cached = null
}
