/**
 * Pluggable takeoff vision provider (gap G1/G3).
 *
 * One prompt + JSON contract, a swappable backend so we can prove the takeoff on
 * a FREE path (gemini-cli / agy subscription, or a local GPU) and route to the
 * paid Gemini/Anthropic API only when scale demands it. Every run carries a
 * cost estimate (see ./cost.ts) — including the SHADOW metered price on the free
 * path, so the budget impact of flipping to paid is known up front.
 *
 * Mirrors the worker media engine's create-media-understanding-processor seam
 * (apps/worker/src/media): an injectable CLI runner keeps it unit-testable, and
 * the gemini/agy CLIs pass NO `-m` flag so the subscription auto-picks the model
 * (a bare `-m` 404s on the cash API — ~/CLAUDE.md rule 4).
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { estimateTakeoffCost, type TakeoffCostEstimate, type TakeoffProvider } from './cost.js'

export interface TakeoffVisionRequest {
  prompt: string
  /** One plan page: base64 bytes + mime + pixel dims (dims feed the cost model). */
  page: { base64: string; mimeType: string; widthPx: number; heightPx: number; fileExt?: string }
  maxOutputTokens?: number
}

export interface TakeoffVisionResult {
  /** Raw model text — the caller validates it against the zod ExtractResponse. */
  text: string
  cost: TakeoffCostEstimate
}

export interface TakeoffVisionProvider {
  readonly id: TakeoffProvider
  run(req: TakeoffVisionRequest): Promise<TakeoffVisionResult>
}

export type CliRunner = (args: string[], opts: { timeoutMs: number }) => Promise<string>

const defaultCliRunner =
  (bin: string): CliRunner =>
  (args, opts) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${bin} failed: ${error.message}${stderr ? ` (${stderr.slice(0, 240)})` : ''}`))
          return
        }
        resolve(stdout)
      })
    })

const approxTokens = (s: string): number => Math.ceil(s.length / 4)

/**
 * gemini-cli / agy-cli provider ($0 subscription). Writes the page to a temp
 * file, embeds `@file` in the `-p` prompt (the CLI contract), passes NO `-m`.
 * billedUsd is 0; cost.shadowApiUsd is what the same run would cost on the API.
 */
export function createCliProvider(opts: {
  id: 'gemini-cli' | 'agy-cli'
  bin?: string
  runner?: CliRunner
  timeoutMs?: number
}): TakeoffVisionProvider {
  const bin = opts.bin ?? (opts.id === 'agy-cli' ? 'agy' : (process.env.GEMINI_CLI_BIN ?? 'gemini'))
  const runner = opts.runner ?? defaultCliRunner(bin)
  const timeoutMs = opts.timeoutMs ?? 180_000
  return {
    id: opts.id,
    async run(req: TakeoffVisionRequest): Promise<TakeoffVisionResult> {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sitelayer-takeoff-vision-'))
      try {
        const ext = req.page.fileExt ?? (req.page.mimeType.includes('pdf') ? 'pdf' : 'png')
        const file = path.join(tmpDir, `plan.${ext}`)
        await writeFile(file, Buffer.from(req.page.base64, 'base64'))
        const stdout = await runner(['-p', `${req.prompt}\n\n@${file}`], { timeoutMs })
        return {
          text: stdout,
          cost: estimateTakeoffCost({
            provider: opts.id,
            pages: [{ widthPx: req.page.widthPx, heightPx: req.page.heightPx }],
            promptTokens: approxTokens(req.prompt),
            outputTokens: approxTokens(stdout),
          }),
        }
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

const STUB_EXTRACT =
  '{"imageSize":{"width":0,"height":0},"rooms":[],"walls":[],"openings":[],"dimensionStrings":[],"notes":["stub"]}'

/** Deterministic stub — never calls a model; returns canned text + a real cost
 *  estimate. For dry-run + tests. */
export function createStubProvider(cannedText: string = STUB_EXTRACT): TakeoffVisionProvider {
  return {
    id: 'stub',
    async run(req: TakeoffVisionRequest): Promise<TakeoffVisionResult> {
      return {
        text: cannedText,
        cost: estimateTakeoffCost({
          provider: 'stub',
          pages: [{ widthPx: req.page.widthPx, heightPx: req.page.heightPx }],
          promptTokens: approxTokens(req.prompt),
          outputTokens: approxTokens(cannedText),
        }),
      }
    },
  }
}

export type TakeoffVisionMode = 'gemini-cli' | 'agy-cli' | 'stub'

/** Factory mirroring the worker media engine's create-*-processor seam. The
 *  paid gemini-api / anthropic-api providers are a follow-up (cost.ts already
 *  prices them); CLI + stub prove the free path + the seam. */
export function createTakeoffVisionProvider(
  mode: TakeoffVisionMode,
  deps?: { runner?: CliRunner },
): TakeoffVisionProvider {
  switch (mode) {
    case 'gemini-cli':
      return createCliProvider({ id: 'gemini-cli', ...(deps?.runner ? { runner: deps.runner } : {}) })
    case 'agy-cli':
      return createCliProvider({ id: 'agy-cli', ...(deps?.runner ? { runner: deps.runner } : {}) })
    case 'stub':
    default:
      return createStubProvider()
  }
}
