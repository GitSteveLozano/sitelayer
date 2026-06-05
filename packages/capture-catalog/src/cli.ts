#!/usr/bin/env tsx
/**
 * Catalog demo CLI.
 *
 * Usage:
 *   tsx src/cli.ts <takeoff.json> [--labor-rate 65] [--out estimate.html]
 *                                 [--company-id demo-co] [--project-id ...]
 *
 * Reads a TakeoffResult JSON, validates it, prices it, prints the
 * PricedEstimate JSON to stdout, and writes an HTML estimate to disk.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { Command } from 'commander'

import { validateTakeoffResult, type TakeoffResult } from '@sitelayer/capture-schema'

import { priceEstimateWithDetails, renderEstimateHtml } from './index.js'

interface CliOptions {
  laborRate: string
  out: string
  companyId: string
  projectId?: string
}

function main(): void {
  const program = new Command()
    .name('catalog')
    .description('Price a TakeoffResult JSON into a PricedEstimate + HTML.')
    .argument('<takeoff>', 'path to TakeoffResult JSON')
    .option('--labor-rate <usd>', 'labor rate in USD/hour', '65')
    .option('--out <path>', 'output HTML path', './estimate.html')
    .option('--company-id <id>', 'sitelayer company id', 'demo-co')
    .option('--project-id <id>', 'sitelayer project id (defaults to takeoff.projectId)')
    .parse(process.argv)

  const [takeoffPath] = program.args
  if (!takeoffPath) {
    console.error('Missing required <takeoff> arg')
    process.exit(1)
  }
  const opts = program.opts() as CliOptions
  const laborRate = Number.parseFloat(opts.laborRate)
  if (!Number.isFinite(laborRate) || laborRate < 0) {
    console.error(`Invalid --labor-rate ${opts.laborRate}`)
    process.exit(1)
  }
  // Resolve paths from cwd; if missing, fall back to npm's INIT_CWD (set when
  // the script is invoked via `npm --workspace ... run demo -- <path>` with a
  // path relative to the workspace root).
  const resolveFlexible = (p: string): string => {
    if (isAbsolute(p)) return p
    const direct = resolve(process.cwd(), p)
    if (existsSync(direct)) return direct
    const initCwd = process.env.INIT_CWD
    if (initCwd) {
      const fromInit = resolve(initCwd, p)
      if (existsSync(fromInit)) return fromInit
    }
    return direct // let the readFile error speak
  }

  const outPath = isAbsolute(opts.out) ? opts.out : resolve(process.env.INIT_CWD ?? process.cwd(), opts.out)

  const raw = readFileSync(resolveFlexible(takeoffPath), 'utf8')
  let takeoff: TakeoffResult
  try {
    takeoff = validateTakeoffResult(JSON.parse(raw))
  } catch (err) {
    console.error(`Failed to parse/validate ${takeoffPath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }

  const projectId = opts.projectId ?? takeoff.projectId
  const result = priceEstimateWithDetails(takeoff, {
    laborRate,
    companyId: opts.companyId,
    projectId,
  })

  // Print PricedEstimate JSON to stdout.
  process.stdout.write(JSON.stringify(result.estimate, null, 2) + '\n')

  // Write HTML to disk.
  const html = renderEstimateHtml(result.estimate)
  writeFileSync(outPath, html, 'utf8')

  // Surface unmatched quantities to stderr so JSON stdout stays clean.
  if (result.unmatched.length > 0) {
    process.stderr.write(`\nWARNING: ${result.unmatched.length} quantity(ies) had no catalog match and were skipped:\n`)
    for (const u of result.unmatched) {
      process.stderr.write(
        `  - ${u.takeoffQuantityId} "${u.description}" (mf=${u.masterformatCode ?? '—'}, uf=${u.uniformatCode ?? '—'}, unit=${u.unit}) reason=${u.reason}\n`,
      )
    }
  }
  process.stderr.write(`\nWrote ${outPath} (${html.length} bytes)\n`)
}

main()
