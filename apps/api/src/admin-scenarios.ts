import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { listWorkflows } from '@sitelayer/workflows'
import { applyScenario, parseScenario, planScenario, type ApplyOp, type ScenarioDoc } from '@sitelayer/scenario'

/**
 * Read-only data sources for the Site Admin scenario console (P3).
 *
 * The workflow list comes straight from the @sitelayer/workflows registry; the
 * scenario list + plan preview reuse the @sitelayer/scenario engine (the same
 * planScenario production seeds run through), so the preview an admin sees is
 * exactly what would be applied.
 */

export interface RegistryWorkflowDto {
  name: string
  schema_version: number
  states: string[]
  initial_state: string
  terminal_states: string[]
}

export interface ScenarioSummaryDto {
  slug: string
  name: string
  file: string
}

export interface PlanPreviewOpDto {
  index: number
  kind: string
  label: string
  detail?: string
}

export interface PlanPreviewDto {
  slug: string
  company_slug: string
  op_count: number
  ops: PlanPreviewOpDto[]
}

// A fixed placeholder company id for previews — the plan is never applied; this
// just resolves the (companyId-parameterised) op values for display.
const PREVIEW_COMPANY_ID = '00000000-0000-4000-8000-000000000000'
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

function firstExistingScenarioDir(candidates: string[]): string {
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!
}

/** Where the scenario YAML fixtures live. Override with SCENARIO_DIR (e.g. in a
 *  container where the repo's scenarios/ isn't at the process cwd). */
export function scenarioDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SCENARIO_DIR?.trim()
  if (configured) return configured

  return firstExistingScenarioDir([
    path.join(process.cwd(), 'scenarios'),
    path.join(process.cwd(), '..', '..', 'scenarios'),
    path.join(MODULE_DIR, '..', '..', '..', 'scenarios'),
  ])
}

export function listRegistryWorkflows(): RegistryWorkflowDto[] {
  return listWorkflows()
    .map((w) => ({
      name: w.name,
      schema_version: w.schemaVersion,
      states: [...w.allStates],
      initial_state: w.initialState,
      terminal_states: [...w.terminalStates],
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function listScenarioFiles(dir: string = scenarioDir()): ScenarioSummaryDto[] {
  if (!existsSync(dir)) return []
  const out: ScenarioSummaryDto[] = []
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    try {
      const doc = parseScenario(readFileSync(path.join(dir, file), 'utf-8'))
      out.push({ slug: doc.company.slug, name: doc.company.name, file })
    } catch {
      // Skip a malformed fixture rather than failing the whole listing.
    }
  }
  return out
}

function toOpDto(op: ApplyOp, index: number): PlanPreviewOpDto {
  if (op.kind === 'event_log') {
    const detail = op.args.events.map((e) => String((e as { type?: unknown }).type)).join(' → ')
    return { index, kind: op.kind, label: op.label, detail }
  }
  return { index, kind: op.kind, label: op.label }
}

/** Resolve a scenario by its company slug and return a display-friendly preview
 *  of the apply plan (no DB, never applied). Null if no fixture matches. */
export function previewScenarioPlan(
  slug: string,
  dir: string = scenarioDir(),
  now: Date = new Date(),
): PlanPreviewDto | null {
  if (!existsSync(dir)) return null
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    let doc
    try {
      doc = parseScenario(readFileSync(path.join(dir, file), 'utf-8'))
    } catch {
      continue
    }
    if (doc.company.slug !== slug) continue
    const plan = planScenario(doc, { companyId: PREVIEW_COMPANY_ID, now })
    return {
      slug,
      company_slug: doc.company.slug,
      op_count: plan.ops.length,
      ops: plan.ops.map((op, index) => toOpDto(op, index)),
    }
  }
  return null
}

// ---------- Apply (seed a fixture into the dev/demo DB) ----------

export interface ScenarioApplyResultDto {
  slug: string
  company_slug: string
  company_id: string
  applied: boolean
}

function findScenarioDoc(slug: string, dir: string): ScenarioDoc | null {
  if (!existsSync(dir)) return null
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    let doc: ScenarioDoc
    try {
      doc = parseScenario(readFileSync(path.join(dir, file), 'utf-8'))
    } catch {
      continue
    }
    if (doc.company.slug === slug) return doc
  }
  return null
}

/**
 * Apply a fixture by slug through the @sitelayer/scenario engine (the SAME path
 * scripts/seed-scenario.ts uses). `target` retargets the company slug so an
 * admin can "spin up a fresh demo company" from a curated fixture. The caller
 * owns the transaction (see makeScenarioApplyRunner). Null if no fixture matches.
 */
export async function applyScenarioFixture(
  client: PoolClient,
  slug: string,
  opts: {
    dir?: string
    target?: string
    now?: Date
    seedCompanyDefaults: (c: PoolClient, companyId: string) => Promise<void>
  },
): Promise<ScenarioApplyResultDto | null> {
  const dir = opts.dir ?? scenarioDir()
  const doc = findScenarioDoc(slug, dir)
  if (!doc) return null
  const target = opts.target?.trim()
  const effective: ScenarioDoc = target ? { ...doc, company: { slug: target, name: doc.company.name } } : doc
  const summary = await applyScenario(
    client,
    effective,
    opts.now
      ? { seedCompanyDefaults: opts.seedCompanyDefaults, now: opts.now }
      : { seedCompanyDefaults: opts.seedCompanyDefaults },
  )
  return { slug, company_slug: effective.company.slug, company_id: summary.company_id, applied: true }
}

export type ScenarioApplyRunner = (args: { slug: string; target?: string }) => Promise<ScenarioApplyResultDto | null>

/**
 * Build a runner that applies a fixture in a fresh transaction WITHOUT the
 * per-request company GUC — scenario seeding is cross-tenant (it CREATES the
 * company), exactly like scripts/seed-scenario.ts.
 */
export function makeScenarioApplyRunner(
  pool: Pool,
  seedCompanyDefaults: (c: PoolClient, companyId: string) => Promise<void>,
): ScenarioApplyRunner {
  return async ({ slug, target }) => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const result = await applyScenarioFixture(
        client,
        slug,
        target !== undefined ? { target, seedCompanyDefaults } : { seedCompanyDefaults },
      )
      await client.query('commit')
      return result
    } catch (err) {
      await client.query('rollback').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }
}
