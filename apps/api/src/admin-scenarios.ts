import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { listWorkflows } from '@sitelayer/workflows'
import { parseScenario, planScenario, type ApplyOp } from '@sitelayer/scenario'

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

/** Where the scenario YAML fixtures live. Override with SCENARIO_DIR (e.g. in a
 *  container where the repo's scenarios/ isn't at the process cwd). */
export function scenarioDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCENARIO_DIR?.trim() || path.join(process.cwd(), 'scenarios')
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
