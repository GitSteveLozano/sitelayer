#!/usr/bin/env node
/**
 * pipe-blueprint demo CLI
 *
 * Usage:
 *   tsx src/cli.ts <pdf-path> [--known-dim 12.5] [--wall-height 8] [--out takeoff.json]
 *   tsx src/cli.ts <pdf-path> --dry-run
 *
 * --dry-run: skip the Anthropic API call entirely and use a built-in fixture.
 *            Useful for smoke-testing without an API key.
 */
import { writeFile } from 'node:fs/promises'
import { Command } from 'commander'
import { buildBlueprintTakeoff, NoDrawingsFoundError } from './extract.js'

/**
 * Drop keys whose value is undefined so exactOptionalPropertyTypes consumers
 * accept the object. The return type strips `undefined` from each value so the
 * resulting object is assignable to a target with `prop?: T` (which under
 * exactOptionalPropertyTypes does not accept explicit `undefined`).
 */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> }
}

interface CliOpts {
  knownDim?: string
  wallHeight?: string
  out?: string
  projectId: string
  dryRun?: boolean
  model?: string
  assumedDpi?: string
}

async function main(): Promise<void> {
  const program = new Command()
  program
    .name('pipe-blueprint')
    .description('PDF blueprint → TakeoffResult via Claude vision (sitelayer-capture).')
    .argument('<pdf-path>', 'path to a PDF file to analyze')
    .option('--known-dim <feet>', 'real-world dimension known to be on the sheet (feet); used to calibrate scale')
    .option('--wall-height <feet>', 'assumed interior wall height in feet (default 8)')
    .option('--out <file>', 'write TakeoffResult JSON to this path')
    .option('--project-id <id>', "project id stamped on the takeoff (default 'spike-001')", 'spike-001')
    .option('--model <model>', 'override model id (default claude-opus-4-7)')
    .option('--assumed-dpi <n>', 'override assumed render DPI for scale calibration (default 100)')
    .option('--dry-run', 'skip Anthropic call and emit a deterministic mock TakeoffResult')
    .action(async (pdfPath: string, opts: CliOpts) => {
      const knownDimensionFt = opts.knownDim != null ? Number(opts.knownDim) : undefined
      const wallHeightFt = opts.wallHeight != null ? Number(opts.wallHeight) : undefined
      const assumedDpi = opts.assumedDpi != null ? Number(opts.assumedDpi) : undefined

      if (knownDimensionFt != null && !isFinite(knownDimensionFt)) {
        console.error('--known-dim must be a number (feet)')
        process.exit(2)
      }
      if (wallHeightFt != null && !isFinite(wallHeightFt)) {
        console.error('--wall-height must be a number (feet)')
        process.exit(2)
      }

      if (!opts.dryRun && !process.env.ANTHROPIC_API_KEY) {
        console.error('ANTHROPIC_API_KEY is not set. Set it in your env or pass --dry-run for a smoke test.')
        process.exit(2)
      }

      try {
        const takeoff = await buildBlueprintTakeoff(
          compact({
            pdfPath,
            projectId: opts.projectId,
            knownDimensionFt,
            wallHeightFt,
            assumedDpi,
            model: opts.model,
            dryRun: opts.dryRun,
          }),
        )
        const json = JSON.stringify(takeoff, null, 2)
        if (opts.out) {
          await writeFile(opts.out, json + '\n', 'utf8')
          console.error(`wrote ${opts.out}`)
        } else {
          process.stdout.write(json + '\n')
        }
      } catch (err) {
        if (err instanceof NoDrawingsFoundError) {
          console.error(`No drawings found: ${err.message}`)
          process.exit(3)
        }
        if (err instanceof Error) {
          console.error(`pipe-blueprint failed: ${err.message}`)
        } else {
          console.error('pipe-blueprint failed (unknown error)')
        }
        process.exit(1)
      }
    })

  await program.parseAsync(process.argv)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
