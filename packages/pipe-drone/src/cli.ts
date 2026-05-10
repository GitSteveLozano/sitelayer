#!/usr/bin/env node
// pipe-drone CLI.
//
//   tsx src/cli.ts sidecar <sidecar.json>      [--altitude N] [--out file.json] [--project-id ID]
//   tsx src/cli.ts ransac  <pointcloud.json>   [--altitude N] [--out file.json] [--project-id ID]
//   tsx src/cli.ts run     <images-dir>        [--altitude N] [--out file.json] [--project-id ID]
//
// `run` requires NODEODM_URL in the environment. It will fail at the
// extraction step with a documented error.

import { writeFile, stat } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'

import { buildDroneTakeoff } from './index.js'

/**
 * Resolve a CLI path against cwd first; if it doesn't exist, also try the
 * package root (one above this file). This lets the documented acceptance
 * gate `packages/pipe-drone/fixtures/...` work both from the repo root and
 * from inside the package (npm workspaces chdirs into the workspace).
 */
async function resolveInputPath(p: string): Promise<string> {
  const candidates = isAbsolute(p)
    ? [p]
    : [
        resolve(process.cwd(), p),
        // Strip leading `packages/pipe-drone/` if present and resolve from
        // package root.
        resolve(fileURLToPath(new URL('../', import.meta.url)), p.replace(/^packages\/pipe-drone\//, '')),
        resolve(fileURLToPath(new URL('../', import.meta.url)), p),
      ]
  for (const c of candidates) {
    try {
      const s = await stat(c)
      if (s.isFile() || s.isDirectory()) return c
    } catch {
      // try next
    }
  }
  throw new Error(`Could not resolve input path '${p}'. Tried:\n  ${candidates.join('\n  ')}`)
}

const program = new Command()
program.name('pipe-drone').description('Drone imagery → TakeoffResult.').version('0.1.0')

interface SharedOptions {
  altitude?: string
  out?: string
  projectId?: string
}

function parseAltitude(opts: SharedOptions): number | undefined {
  if (opts.altitude == null) return undefined
  const n = Number(opts.altitude)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--altitude must be a positive number, got ${opts.altitude}`)
  }
  return n
}

async function emit(result: unknown, outPath: string | undefined): Promise<void> {
  const json = JSON.stringify(result, null, 2)
  if (outPath) {
    await writeFile(outPath, json, 'utf8')
    console.error(`Wrote ${outPath}`)
  } else {
    process.stdout.write(json + '\n')
  }
}

program
  .command('sidecar <sidecarPath>')
  .description('Build TakeoffResult from a precomputed sidecar JSON (Path B).')
  .option('--altitude <m>', 'Flight altitude in metres (provenance metadata).')
  .option('--out <file>', 'Write TakeoffResult JSON to file (default stdout).')
  .option('--project-id <id>', 'Sitelayer project id.', 'spike-001')
  .action(async (sidecarPath: string, opts: SharedOptions) => {
    const altitudeM = parseAltitude(opts)
    const resolved = await resolveInputPath(sidecarPath)
    const result = await buildDroneTakeoff({
      projectId: opts.projectId ?? 'spike-001',
      sidecarPath: resolved,
      ...(altitudeM != null ? { altitudeM } : {}),
    })
    await emit(result, opts.out)
  })

program
  .command('ransac <pointcloudPath>')
  .description('Run RANSAC on a hand-authored point cloud (Path C smoke test).')
  .option('--altitude <m>', 'Flight altitude in metres (provenance metadata).')
  .option('--out <file>', 'Write TakeoffResult JSON to file (default stdout).')
  .option('--project-id <id>', 'Sitelayer project id.', 'spike-001')
  .action(async (pointcloudPath: string, opts: SharedOptions) => {
    const altitudeM = parseAltitude(opts)
    const resolved = await resolveInputPath(pointcloudPath)
    const result = await buildDroneTakeoff({
      projectId: opts.projectId ?? 'spike-001',
      pointCloudFixturePath: resolved,
      ...(altitudeM != null ? { altitudeM } : {}),
    })
    await emit(result, opts.out)
  })

program
  .command('run <imagesDir>')
  .description('Live NodeODM reconstruction (Path A). Requires NODEODM_URL.')
  .option('--altitude <m>', 'Flight altitude in metres (provenance metadata).')
  .option('--out <file>', 'Write TakeoffResult JSON to file (default stdout).')
  .option('--project-id <id>', 'Sitelayer project id.', 'spike-001')
  .action(async (imagesDir: string, opts: SharedOptions) => {
    const nodeOdmUrl = process.env.NODEODM_URL
    if (!nodeOdmUrl) {
      console.error('Path A requires NODEODM_URL=http://host:3000 in the environment.')
      process.exit(2)
    }
    const altitudeM = parseAltitude(opts)
    const resolved = await resolveInputPath(imagesDir)
    const result = await buildDroneTakeoff({
      projectId: opts.projectId ?? 'spike-001',
      imagesDir: resolved,
      nodeOdmUrl,
      ...(altitudeM != null ? { altitudeM } : {}),
    })
    await emit(result, opts.out)
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error((err as Error).message)
  process.exit(1)
})
