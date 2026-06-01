import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseScenario, planScenario, type ApplyOp, type ScenarioPlan } from './index.js'

const scenariosDir = fileURLToPath(new URL('../../../scenarios', import.meta.url))
const scenarioFiles = readdirSync(scenariosDir)
  .filter((f) => f.endsWith('.yaml'))
  .sort()

// Fixed inputs so plans are byte-deterministic in tests.
const COMPANY_ID = '00000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-05-31T12:00:00.000Z')

function read(file: string): string {
  return readFileSync(`${scenariosDir}/${file}`, 'utf-8')
}

function planFor(file: string): ScenarioPlan {
  return planScenario(parseScenario(read(file)), { companyId: COMPANY_ID, now: NOW })
}

function opByLabel(plan: ScenarioPlan, label: string): ApplyOp | undefined {
  return plan.ops.find((o) => o.label === label)
}

describe('parseScenario', () => {
  it('finds the checked-in scenario fixtures', () => {
    expect(scenarioFiles.length).toBeGreaterThan(0)
    expect(scenarioFiles).toContain('steve-demo.yaml')
    expect(scenarioFiles).toContain('mid-flight-rental.yaml')
  })

  // Every existing scenario must validate unchanged under the Zod schema —
  // this is the "don't break the live seeds" guard.
  it.each(scenarioFiles)('validates %s against the schema', (file) => {
    expect(() => parseScenario(read(file))).not.toThrow()
  })

  it('rejects a malformed company slug', () => {
    expect(() => parseScenario('company:\n  slug: "Not A Slug"\n  name: x\n')).toThrow()
  })

  it('rejects a doc missing the company block', () => {
    expect(() => parseScenario('members: []\n')).toThrow()
  })
})

describe('planScenario — determinism', () => {
  it.each(scenarioFiles)('produces an identical plan on re-plan: %s', (file) => {
    const a = planFor(file)
    const b = planFor(file)
    expect(b).toEqual(a)
  })

  it('keeps the canonical op order: memberships → company_defaults → customers', () => {
    const plan = planFor('steve-demo.yaml')
    const defaultsIdx = plan.ops.findIndex((o) => o.kind === 'company_defaults')
    const firstMembershipIdx = plan.ops.findIndex((o) => o.label.startsWith('membership:'))
    const firstCustomerIdx = plan.ops.findIndex((o) => o.label.startsWith('customer:'))
    expect(firstMembershipIdx).toBeGreaterThanOrEqual(0)
    expect(defaultsIdx).toBeGreaterThan(firstMembershipIdx)
    expect(firstCustomerIdx).toBeGreaterThan(defaultsIdx)
  })
})

describe('planScenario — workflow timelines fold through the real reducers', () => {
  it('mid-flight-rental: rental ends `posting` and enqueues a backdated outbox row', () => {
    const plan = planFor('mid-flight-rental.yaml')

    const events = opByLabel(plan, 'rental_billing_run:events:rental-stuck')
    expect(events?.kind).toBe('event_log')
    if (events?.kind === 'event_log') {
      expect(events.args.workflowName).toBe('rental_billing_run')
      expect(events.args.events.map((e) => e.type)).toEqual(['APPROVE', 'POST_REQUESTED'])
    }

    const stamp = opByLabel(plan, 'rental_billing_run:stamp:rental-stuck')
    expect(stamp?.kind).toBe('query')
    // values: [state, state_version, approved_at, approved_by, posted_at, ...]
    if (stamp?.kind === 'query') {
      expect(stamp.values[0]).toBe('posting')
      expect(stamp.values[1]).toBe(3) // generated(1) → approved(2) → posting(3)
    }

    const outbox = opByLabel(plan, 'rental_billing_run:outbox:rental-stuck')
    expect(outbox?.kind).toBe('query')
    if (outbox?.kind === 'query') {
      // values: [companyId, billingRunId, payload, idempotencyKey, offsetMinutes]
      expect(outbox.values[4]).toBe('-15')
    }
  })

  it('steve-demo maple-invoice: rental ends `posted` with the seeded QBO id, no outbox', () => {
    const plan = planFor('steve-demo.yaml')

    const stamp = opByLabel(plan, 'rental_billing_run:stamp:maple-invoice')
    expect(stamp?.kind).toBe('query')
    if (stamp?.kind === 'query') {
      expect(stamp.values[0]).toBe('posted')
      // values[7] is qbo_invoice_id in the rental stamp
      expect(stamp.values[7]).toBe('DEMO-INV-1041')
    }

    // posted (terminal) → no mutation_outbox row should be enqueued.
    expect(opByLabel(plan, 'rental_billing_run:outbox:maple-invoice')).toBeUndefined()
  })

  it('steve-demo oakwood estimate: REVIEW lands the push in `reviewed`', () => {
    const plan = planFor('steve-demo.yaml')
    const stamp = opByLabel(plan, 'estimate_push:stamp:oakwood-est')
    expect(stamp?.kind).toBe('query')
    if (stamp?.kind === 'query') {
      expect(stamp.values[0]).toBe('reviewed')
    }
  })

  it('steve-demo riverside-pending: a `generated` run with no event log + no stamp', () => {
    const plan = planFor('steve-demo.yaml')
    expect(opByLabel(plan, 'rental_billing_run:riverside-pending')?.kind).toBe('query')
    expect(opByLabel(plan, 'rental_billing_run:events:riverside-pending')).toBeUndefined()
    expect(opByLabel(plan, 'rental_billing_run:stamp:riverside-pending')).toBeUndefined()
  })
})

describe('planScenario — summary', () => {
  it('resolves steve-demo refs deterministically', () => {
    const plan = planFor('steve-demo.yaml')
    expect(plan.companyId).toBe(COMPANY_ID)
    expect(plan.summary.company_slug).toBe('steve-demo')
    expect(plan.summary.projects.map((p) => p.ref).sort()).toEqual([
      'hillcrest',
      'maple',
      'oakwood',
      'riverside',
      'sunset',
    ])
    expect(plan.summary.customers).toHaveLength(5)
    // Every resolved id is a v4-shaped UUID.
    for (const { id } of plan.summary.projects) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })
})
