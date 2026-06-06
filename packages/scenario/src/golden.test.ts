import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseScenario, planScenario, type ScenarioDoc, type ScenarioEvent } from './index.js'
import {
  aiCaptureDraftPendingReview,
  blueprintWithCalibratedPage,
  composeScenario,
  projectInProgress,
  starterFixtures,
  takeoffDraftWithGeometry,
} from './library.js'

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

// NEW renderable-takeoff fixtures (blueprints + calibrated pages + geometry).
// These add their OWN snapshots; they must never alter the per-file snapshots
// above (those prove the existing scenarios still plan byte-identically).
function planShapeDoc(doc: ScenarioDoc) {
  const plan = planScenario(doc, { companyId: COMPANY_ID, now: NOW })
  return plan.ops.map((op) => `${op.kind} ${op.label}`)
}

describe('plan golden snapshots — renderable takeoff fixtures', () => {
  it('blueprint + calibrated page + manual geometry draft', () => {
    const doc: ScenarioDoc = {
      company: { slug: 'render-co', name: 'Render Co' },
      ...composeScenario(
        starterFixtures(),
        projectInProgress('alpha', { customerRef: 'cust-1' }),
        blueprintWithCalibratedPage('bp', { projectRef: 'alpha' }),
        takeoffDraftWithGeometry('manual-1', { projectRef: 'alpha', blueprintRef: 'bp', pageRef: 'bp-p1' }),
      ),
    }
    expect(planShapeDoc(doc)).toMatchSnapshot()
  })

  it('AI-capture draft pending review with geometry', () => {
    const doc: ScenarioDoc = {
      company: { slug: 'render-co', name: 'Render Co' },
      ...composeScenario(
        starterFixtures(),
        projectInProgress('alpha', { customerRef: 'cust-1' }),
        blueprintWithCalibratedPage('bp', { projectRef: 'alpha' }),
        aiCaptureDraftPendingReview('ai-1', { projectRef: 'alpha', blueprintRef: 'bp', pageRef: 'bp-p1' }),
      ),
    }
    expect(planShapeDoc(doc)).toMatchSnapshot()
  })
})
