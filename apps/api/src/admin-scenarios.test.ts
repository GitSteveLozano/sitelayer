import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listRegistryWorkflows, listScenarioFiles, previewScenarioPlan, scenarioDir } from './admin-scenarios.js'

const REAL_SCENARIOS = fileURLToPath(new URL('../../../scenarios', import.meta.url))
const NOW = new Date('2026-05-31T12:00:00.000Z')

describe('listRegistryWorkflows', () => {
  it('exposes the workflow registry with the UI DTO shape', () => {
    const workflows = listRegistryWorkflows()
    expect(workflows.length).toBeGreaterThan(0)
    const rb = workflows.find((w) => w.name === 'rental_billing_run')
    expect(rb).toBeDefined()
    expect(rb).toMatchObject({ schema_version: expect.any(Number), initial_state: 'generated' })
    expect(rb!.states).toContain('posting')
    expect(rb!.terminal_states.length).toBeGreaterThan(0)
    expect([...workflows].map((w) => w.name)).toEqual([...workflows].map((w) => w.name).sort())
  })
})

describe('listScenarioFiles', () => {
  it('lists the checked-in fixtures by company slug', () => {
    const scenarios = listScenarioFiles(REAL_SCENARIOS)
    expect(scenarios.length).toBeGreaterThan(0)
    expect(scenarios.find((s) => s.file === 'steve-demo.yaml')).toMatchObject({
      slug: 'steve-demo',
      file: 'steve-demo.yaml',
    })
  })

  it('returns [] for a missing directory', () => {
    expect(listScenarioFiles('/no/such/scenarios/dir')).toEqual([])
  })

  it('defaults to <cwd>/scenarios, overridable via SCENARIO_DIR', () => {
    expect(scenarioDir({ SCENARIO_DIR: '/custom/scenarios' })).toBe('/custom/scenarios')
    expect(scenarioDir({})).toMatch(/scenarios$/)
  })
})

describe('previewScenarioPlan', () => {
  it('previews the resolved plan for a fixture (deterministic)', () => {
    const plan = previewScenarioPlan('steve-demo', REAL_SCENARIOS, NOW)
    expect(plan).not.toBeNull()
    expect(plan!.company_slug).toBe('steve-demo')
    expect(plan!.op_count).toBeGreaterThan(0)
    expect(plan!.ops.length).toBe(plan!.op_count)
    expect(plan!.ops[0]).toMatchObject({ index: 0, kind: expect.any(String), label: expect.any(String) })
    expect(plan!.ops.find((o) => o.kind === 'event_log')?.detail).toContain('→')
    expect(previewScenarioPlan('steve-demo', REAL_SCENARIOS, NOW)).toEqual(plan)
  })

  it('returns null for an unknown slug', () => {
    expect(previewScenarioPlan('does-not-exist', REAL_SCENARIOS, NOW)).toBeNull()
  })
})
