#!/usr/bin/env -S npx tsx
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'

type CommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

type HttpCheck = {
  ok: boolean
  status?: number
  body?: unknown
  error?: string
}

const SERVICES = [
  'voice-tools-whisper.service',
  'llama-swap.service',
  'gpu-backlog-drainer.service',
  'sitelayer-capture-media-worker.service',
] as const

const REQUIRED_ENV = ['DATABASE_URL', 'DO_SPACES_BUCKET', 'DO_SPACES_KEY', 'DO_SPACES_SECRET'] as const

function envFilePath(): string {
  return (
    process.env.CAPTURE_MEDIA_WORKER_ENV_FILE?.trim() ||
    `${os.userInfo().homedir}/.config/sitelayer/capture-media-worker.env`
  )
}

async function run(command: string, args: string[], timeoutMs = 10_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      const maybeCode =
        error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
      resolve({
        ok: !error,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: maybeCode,
      })
    })
  })
}

async function httpJson(url: string, timeoutMs = 5_000): Promise<HttpCheck> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // Keep raw text.
    }
    return { ok: response.ok, status: response.status, body }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function readEnvPresence(path: string): Promise<Record<(typeof REQUIRED_ENV)[number], boolean>> {
  const result = Object.fromEntries(REQUIRED_ENV.map((key) => [key, Boolean(process.env[key]?.trim())])) as Record<
    (typeof REQUIRED_ENV)[number],
    boolean
  >
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return result
  }
  for (const key of REQUIRED_ENV) {
    if (result[key]) continue
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*.+$`, 'm')
    result[key] = re.test(text)
  }
  return result
}

function llamaModels(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray((body as { data?: unknown }).data)) {
    return []
  }
  return (body as { data: Array<{ id?: unknown }> }).data
    .map((entry) => (typeof entry.id === 'string' ? entry.id : null))
    .filter((id): id is string => Boolean(id))
}

async function main() {
  const serviceEntries = await Promise.all(
    SERVICES.map(async (service) => {
      const active = await run('systemctl', ['--user', 'is-active', service], 5_000)
      return [service, active.stdout || (active.ok ? 'active' : 'unknown')] as const
    }),
  )
  const whisper = await httpJson(process.env.CAPTURE_ARTIFACT_WHISPER_URL?.trim() || 'http://127.0.0.1:5678/health')
  const llama = await httpJson(
    `${(process.env.MEDIA_UNDERSTANDING_LLAMASWAP_URL?.trim() || 'http://127.0.0.1:8081/v1').replace(/\/$/, '')}/models`,
  )
  const gpuYield = await run(
    process.env.CAPTURE_MEDIA_WORKER_GPU_YIELD_BIN?.trim() ||
      `${os.userInfo().homedir}/projects/screen-capture/scripts/gpu-yield`,
    ['status'],
    5_000,
  )
  const envFile = envFilePath()
  const envPresence = await readEnvPresence(envFile)
  const requiredEnvReady = Object.values(envPresence).every(Boolean)
  const services = Object.fromEntries(serviceEntries)
  const healthy =
    whisper.ok &&
    llama.ok &&
    requiredEnvReady &&
    services['voice-tools-whisper.service'] === 'active' &&
    services['llama-swap.service'] === 'active'

  console.log(
    JSON.stringify(
      {
        ok: healthy,
        env_file: envFile,
        required_env_present: envPresence,
        services,
        whisper,
        llama_swap: {
          ok: llama.ok,
          status: llama.status,
          models: llamaModels(llama.body),
          error: llama.error,
        },
        gpu_yield: {
          ok: gpuYield.ok,
          status: gpuYield.stdout || null,
          error: gpuYield.ok ? null : gpuYield.stderr || 'gpu-yield failed',
        },
      },
      null,
      2,
    ),
  )
  if (!healthy) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
