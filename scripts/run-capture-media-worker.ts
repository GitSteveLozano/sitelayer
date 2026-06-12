#!/usr/bin/env -S npx tsx
import { execFile } from 'node:child_process'
import os from 'node:os'
import { Pool } from 'pg'
import { listActiveCompanies } from '../apps/worker/src/companies.js'
import { createBlueprintStorageGcClient } from '../apps/worker/src/runners/blueprint-storage-gc.js'
import { createCaptureArtifactAnalysisRunner } from '../apps/worker/src/runners/capture-artifact-analysis.js'

type Logger = {
  info: (payload: Record<string, unknown>, msg: string) => void
  warn: (payload: Record<string, unknown>, msg: string) => void
  error: (payload: Record<string, unknown>, msg: string) => void
}

function usage() {
  console.log(`Usage:
  DATABASE_URL=postgres://... \\
  DO_SPACES_BUCKET=... DO_SPACES_KEY=... DO_SPACES_SECRET=... \\
  npm run capture:media-worker

Runs only the capture artifact analyzer. This is intended for Taylor's GPU
workstation, not the Sitelayer droplets: audio transcription defaults to the
local voice-tools Whisper server at http://127.0.0.1:5678.

Useful env:
  CAPTURE_MEDIA_WORKER_ONCE=1              run one pass and exit
  CAPTURE_MEDIA_WORKER_INTERVAL_MS=30000   loop interval
  CAPTURE_MEDIA_WORKER_COMPANY_SLUG=slug   optional single-tenant override
  CAPTURE_MEDIA_WORKER_GPU_YIELD=1         pause idle GPU backlog while analyzing
  CAPTURE_MEDIA_WORKER_GPU_YIELD_BIN=...   default ~/projects/screen-capture/scripts/gpu-yield
  CAPTURE_ARTIFACT_WHISPER_URL=...         default http://127.0.0.1:5678
  MEDIA_UNDERSTANDING_ENGINE=llama-swap    default local OpenAI-compatible enrichment
`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env: ${name}`)
  return value
}

function positiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function setDefaultEnv(name: string, value: string) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function envFlagEnabled(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function gpuYieldBin(): string {
  return (
    process.env.CAPTURE_MEDIA_WORKER_GPU_YIELD_BIN?.trim() ||
    `${os.userInfo().homedir}/projects/screen-capture/scripts/gpu-yield`
  )
}

async function runGpuYield(mode: 'on' | 'off', logger: Logger): Promise<void> {
  if (!envFlagEnabled('CAPTURE_MEDIA_WORKER_GPU_YIELD', true)) return
  const bin = gpuYieldBin()
  await new Promise<void>((resolve) => {
    execFile(bin, [mode], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        logger.warn(
          {
            err: error,
            gpu_yield_bin: bin,
            gpu_yield_mode: mode,
            stderr: stderr?.slice(0, 500),
            stdout: stdout?.slice(0, 500),
          },
          '[capture-media-worker] gpu-yield command failed',
        )
      }
      resolve()
    })
  })
}

function jsonLogger(): Logger {
  const write = (level: 'info' | 'warn' | 'error', payload: Record<string, unknown>, msg: string) => {
    const err = payload.err instanceof Error ? { message: payload.err.message, stack: payload.err.stack } : payload.err
    console[level](JSON.stringify({ ts: new Date().toISOString(), level, msg, ...payload, err }))
  }
  return {
    info: (payload, msg) => write('info', payload, msg),
    warn: (payload, msg) => write('warn', payload, msg),
    error: (payload, msg) => write('error', payload, msg),
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage()
    return
  }

  setDefaultEnv('CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE', 'local-whisper')
  setDefaultEnv('CAPTURE_ARTIFACT_WHISPER_URL', 'http://127.0.0.1:5678')
  setDefaultEnv('CAPTURE_ARTIFACT_WHISPER_PAYLOAD_MODE', 'base64')
  setDefaultEnv('CAPTURE_ARTIFACT_WHISPER_TIMEOUT_MS', '120000')
  setDefaultEnv('CAPTURE_ARTIFACT_WHISPER_UNAVAILABLE_POLICY', 'retry')
  setDefaultEnv('CAPTURE_ARTIFACT_ANALYSIS_MAX_BYTES', '52428800')
  setDefaultEnv('CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE', 'frames-only')
  setDefaultEnv('MEDIA_UNDERSTANDING_ENGINE', 'llama-swap')
  setDefaultEnv('MEDIA_UNDERSTANDING_LLAMASWAP_URL', 'http://127.0.0.1:8081/v1')

  const logger = jsonLogger()
  const databaseUrl = requiredEnv('DATABASE_URL')
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
  const pool = new Pool({
    connectionString: databaseUrl,
    max: positiveInt('WORKER_PG_POOL_MAX', 2),
    idleTimeoutMillis: positiveInt('PG_IDLE_TIMEOUT_MS', 30_000),
    ...(rejectUnauthorized ? {} : { ssl: { rejectUnauthorized: false } }),
  })
  const storage = await createBlueprintStorageGcClient()
  if (!storage) throw new Error('Object storage is not configured for capture media worker')

  const runner = createCaptureArtifactAnalysisRunner({ pool, storage, logger })
  const once = process.env.CAPTURE_MEDIA_WORKER_ONCE === '1'
  const intervalMs = positiveInt('CAPTURE_MEDIA_WORKER_INTERVAL_MS', 30_000)
  const companyOverride =
    process.env.CAPTURE_MEDIA_WORKER_COMPANY_SLUG?.trim() || process.env.ACTIVE_COMPANY_SLUG?.trim() || null
  let stopping = false
  const stop = () => {
    stopping = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    do {
      const companies = await listActiveCompanies(pool, companyOverride)
      if (companies.length === 0) {
        logger.warn({ company_slug: companyOverride }, '[capture-media-worker] no companies matched')
      }
      // Lazy GPU yield: only unload the llama-swap models when this pass has
      // artifacts to analyze. The unconditional per-pass yield evicted every
      // resident model ~2x/min around the clock for empty passes (audit
      // 2026-06-12: 476 model loads in 99 min), starving the reducer and
      // research lanes AND the worker's own llama-swap understanding engine.
      const pending: typeof companies = []
      for (const company of companies) {
        try {
          if ((await runner.countAnalyzable(company.id)) > 0) pending.push(company)
        } catch (err) {
          logger.error({ err, company_id: company.id }, '[capture-media-worker] pending peek failed')
          pending.push(company) // fail open: analyze path decides
        }
      }
      if (pending.length > 0) {
        await runGpuYield('on', logger)
        try {
          for (const company of pending) {
            try {
              const summary = await runner.forceAnalyze(company.id)
              logger.info(
                { company_id: company.id, company_slug: company.slug, summary },
                '[capture-media-worker] analyzed',
              )
            } catch (err) {
              logger.error(
                { err, company_id: company.id, company_slug: company.slug },
                '[capture-media-worker] analyze failed',
              )
            }
          }
        } finally {
          await runGpuYield('off', logger)
        }
      }
      if (!once && !stopping) await sleep(intervalMs)
    } while (!once && !stopping)
  } finally {
    await runGpuYield('off', logger)
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
