// Gemini CLI media-understanding adapter. Rides the operator's Gemini
// subscription via the `gemini` CLI ($0 cash) — the launch environment unsets
// GEMINI_API_KEY/GOOGLE_API_KEY so the CLI uses OAuth, and we pass NO `-m` flag
// so the subscription Auto-picker selects the model (`~/CLAUDE.md` rule 4: a
// bare `-m gemini-3-pro` 404s on the cash API; subscription needs no `-m`).
//
// Realistically available on the fleet/local, not in the prod worker container,
// which is why the multimodal mode is opt-in and defaults to off.

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildMediaUnderstandingPrompt,
  parseMediaUnderstanding,
  type MediaProcessor,
  type MediaUnderstandInput,
  type MediaUnderstanding,
} from './media-processor.js'

export type GeminiCliRunner = (args: string[], opts: { timeoutMs: number }) => Promise<string>

const ANALYZER = 'gemini-cli-v1'

const defaultRunner: GeminiCliRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.GEMINI_CLI_BIN ?? 'gemini',
      args,
      { timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`gemini cli failed: ${error.message}${stderr ? ` (${stderr.slice(0, 240)})` : ''}`))
          return
        }
        resolve(stdout)
      },
    )
  })

export function createGeminiCliUnderstandingProcessor(deps?: { runner?: GeminiCliRunner }): MediaProcessor {
  const runner = deps?.runner ?? defaultRunner
  const timeoutMs = readPositiveInt('MEDIA_UNDERSTANDING_CLI_TIMEOUT_MS', 120_000)
  const maxFrames = Math.min(readPositiveInt('MEDIA_UNDERSTANDING_CLI_MAX_FRAMES', 8), 24)

  return {
    analyzer: ANALYZER,
    async understand(input: MediaUnderstandInput): Promise<MediaUnderstanding> {
      const frames = (input.frames ?? []).slice(0, maxFrames)
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sitelayer-media-understand-'))
      try {
        const refs: string[] = []
        for (const frame of frames) {
          const framePath = path.join(tmpDir, `frame-${String(frame.index).padStart(2, '0')}.jpg`)
          await writeFile(framePath, frame.bytes)
          refs.push(`@${framePath}`)
        }
        // The @file references are embedded in the -p prompt string, per the
        // gemini-video skill contract (`gemini -p "<prompt> @<file>"`).
        const prompt = refs.length
          ? `${buildMediaUnderstandingPrompt(input)}\n\n${refs.join(' ')}`
          : buildMediaUnderstandingPrompt(input)
        const stdout = await runner(['-p', prompt], { timeoutMs })
        return parseMediaUnderstanding(stdout, ANALYZER)
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
