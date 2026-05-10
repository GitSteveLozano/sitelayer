#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Command } from 'commander'
import {
  buildTakeoffFromLabeledMesh,
  fetchPhotogrammetryTakeoff,
  parseLabeledMesh,
  submitPhotogrammetryJob,
} from './index.js'

/**
 * Resolve a user-supplied path relative to where they invoked the command.
 * `npm --workspace ... run demo` cd's into the package dir before exec'ing
 * the script; npm exposes the original directory via `INIT_CWD`. We prefer
 * that so paths like `packages/pipe-photogrammetry/fixtures/foo.json`
 * (relative to repo root) work as documented in the acceptance gate.
 */
function resolveUserPath(p: string): string {
  if (isAbsolute(p)) return p
  const initCwd = process.env.INIT_CWD ?? process.cwd()
  return resolve(initCwd, p)
}

const program = new Command()

program
  .name('pipe-photogrammetry')
  .description('Phone-video → TakeoffResult. Path A: Luma Capture API. Path B: labeled-mesh JSON.')

program
  .command('label')
  .description('Path B: build a TakeoffResult from a hand-authored labeled-mesh JSON file')
  .argument('<labeled-mesh.json>', 'path to labeled-mesh JSON fixture')
  .option('--project-id <id>', 'project id to embed in the result', 'spike-001')
  .option('--out <path>', 'write result JSON to this path instead of stdout')
  .action(async (jsonPath: string, opts: { projectId: string; out?: string }) => {
    const raw = await readFile(resolveUserPath(jsonPath), 'utf8')
    const parsed = parseLabeledMesh(JSON.parse(raw))
    const takeoff = buildTakeoffFromLabeledMesh({
      labeledMesh: parsed,
      projectId: opts.projectId,
    })
    const out = JSON.stringify(takeoff, null, 2)
    if (opts.out) {
      await writeFile(resolveUserPath(opts.out), out)
      // eslint-disable-next-line no-console
      console.error(`wrote ${opts.out}`)
    } else {
      // eslint-disable-next-line no-console
      console.log(out)
    }
  })

program
  .command('submit')
  .description('Path A: submit a phone video to Luma 3D Capture (needs LUMA_API_KEY)')
  .argument('<video-path>', 'path to .mp4 / .mov video file')
  .option('--project-id <id>', 'project id (recorded for follow-up fetch)', 'spike-001')
  .option('--title <title>', 'human-readable title for the capture')
  .action(async (videoPath: string, opts: { projectId: string; title?: string }) => {
    const apiKey = process.env.LUMA_API_KEY
    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error('LUMA_API_KEY not set')
      process.exit(2)
    }
    const submitOpts: Parameters<typeof submitPhotogrammetryJob>[0] = {
      videoPath: resolveUserPath(videoPath),
      projectId: opts.projectId,
      apiKey,
    }
    if (opts.title !== undefined) submitOpts.title = opts.title
    const result = await submitPhotogrammetryJob(submitOpts)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2))
  })

program
  .command('fetch')
  .description('Path A: fetch a completed Luma job → review-required TakeoffResult (needs LUMA_API_KEY)')
  .argument('<job-id>', 'Luma slug returned from `submit`')
  .option('--project-id <id>', 'project id to embed in the result', 'spike-001')
  .option('--out <path>', 'write result JSON to this path instead of stdout')
  .action(async (jobId: string, opts: { projectId: string; out?: string }) => {
    const apiKey = process.env.LUMA_API_KEY
    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error('LUMA_API_KEY not set')
      process.exit(2)
    }
    const takeoff = await fetchPhotogrammetryTakeoff(jobId, opts.projectId, {
      apiKey,
    })
    const out = JSON.stringify(takeoff, null, 2)
    if (opts.out) {
      await writeFile(resolveUserPath(opts.out), out)
      // eslint-disable-next-line no-console
      console.error(`wrote ${opts.out}`)
    } else {
      // eslint-disable-next-line no-console
      console.log(out)
    }
  })

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
