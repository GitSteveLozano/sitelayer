/**
 * pipe-roomplan demo CLI.
 *
 * Usage:
 *   tsx src/cli.ts <captured-room.json> [--device "iPhone 15 Pro"] [--out takeoff.json] [--project-id spike-001]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'

import { parseCapturedRoom } from './index.js'

/**
 * Resolve the input path. Tries (in order):
 *   1. Absolute path (if provided)
 *   2. Relative to current working directory
 *   3. Relative to nearest ancestor containing package.json with workspaces
 *      (so `npm run demo -- packages/foo/x.json` works from repo root and
 *      from the package dir)
 */
function resolveInputPath(input: string): string {
  if (input.startsWith('/')) return input
  const cwdAbs = resolve(process.cwd(), input)
  if (existsSync(cwdAbs)) return cwdAbs

  // Walk up from cwd looking for a workspace root (package.json with "workspaces")
  let dir = process.cwd()
  while (true) {
    const pkgPath = resolve(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
          workspaces?: unknown
        }
        if (pkg.workspaces) {
          const fromRoot = resolve(dir, input)
          if (existsSync(fromRoot)) return fromRoot
        }
      } catch {
        // ignore
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return cwdAbs // let the caller's readFileSync surface ENOENT
}

const program = new Command()

program
  .name('pipe-roomplan')
  .description('Apple RoomPlan CapturedRoom JSON → TakeoffResult')
  .argument('<input>', 'path to CapturedRoom JSON dump')
  .option('--device <model>', 'device model string (e.g. "iPhone 15 Pro")')
  .option('--out <path>', 'write TakeoffResult JSON to this path instead of stdout')
  .option('--project-id <id>', 'sitelayer project id', 'spike-001')
  .option('--captured-at <iso>', 'ISO timestamp of capture')
  .option('--captured-room-uri <uri>', 'URI for the original CapturedRoom JSON blob')
  .action(
    (
      inputPath: string,
      opts: {
        device?: string
        out?: string
        projectId: string
        capturedAt?: string
        capturedRoomUri?: string
      },
    ) => {
      const absInput = resolveInputPath(inputPath)
      const raw = readFileSync(absInput, 'utf-8')
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch (err) {
        console.error(`Failed to parse ${absInput} as JSON:`, err)
        process.exit(2)
      }

      const result = parseCapturedRoom({
        capturedRoomJson: json,
        projectId: opts.projectId,
        deviceModel: opts.device,
        capturedAt: opts.capturedAt,
        capturedRoomJsonUri: opts.capturedRoomUri ?? `file://${absInput}`,
      })

      const out = JSON.stringify(result, null, 2)
      if (opts.out) {
        const absOut = resolve(process.cwd(), opts.out)
        writeFileSync(absOut, out + '\n', 'utf-8')
        console.error(`Wrote ${result.quantities.length} quantities to ${absOut}`)
      } else {
        process.stdout.write(out + '\n')
      }
    },
  )

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exit(1)
})
