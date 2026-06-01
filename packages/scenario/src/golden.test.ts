import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseScenario, planScenario, type ScenarioEvent } from './index.js'

/**
 * Plan golden snapshots (P1).
 *
 * For every checked-in `scenarios/*.yaml`, snapshot a compact, deterministic
 * "shape" of the plan: the ordered op list (with each timeline's event-type
 * sequence inline) plus per-section ref counts. Because `planScenario` is pure
 * for a fixed `(doc, companyId, now)`, any drift in a reducer, the schema, the
 * seeder SQL surface, or op ordering shows up as a reviewable snapshot diff.
 *
 * Row-level correctness (the SQL actually materialising) is covered separately
 * by the ephemeral-PG golden tests in apps/api/src/scenario-replay.golden.test.ts.
 */

const scenariosDir = fileURLToPath(new URL('../../../scenarios', import.meta.url))
const scenarioFiles = readdirSync(scenariosDir)
  .filter((f) => f.endsWith('.yaml'))
  .sort()

const COMPANY_ID = '00000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-05-31T12:00:00.000Z')

function read(file: string): string {
  return readFileSync(`${scenariosDir}/${file}`, 'utf-8')
}

function planShape(file: string) {
  const plan = planScenario(parseScenario(read(file)), { companyId: COMPANY_ID, now: NOW })
  const ops = plan.ops.map((op) => {
    if (op.kind === 'event_log') {
      const types = (op.args.events as readonly ScenarioEvent[]).map((e) => e.type).join('→')
      return `event_log ${op.label} [${types}]`
    }
    return `${op.kind} ${op.label}`
  })
  const counts = Object.fromEntries(
    Object.entries(plan.summary)
      .filter(([k]) => k !== 'company_id' && k !== 'company_slug')
      .map(([k, v]) => [k, Array.isArray(v) ? v.length : v]),
  )
  return { ops, counts }
}

describe('plan golden snapshots', () => {
  it.each(scenarioFiles)('%s plans to a stable shape', (file) => {
    expect(planShape(file)).toMatchSnapshot()
  })
})
