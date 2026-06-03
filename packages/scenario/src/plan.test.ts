import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseScenario, planScenario, type ApplyOp, type ScenarioDoc, type ScenarioPlan } from './index.js'
import {
  aiCaptureDraftPendingReview,
  blueprintWithCalibratedPage,
  composeScenario,
  projectInProgress,
  starterFixtures,
  takeoffDraftWithGeometry,
} from './library.js'

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

describe('planScenario — renderable takeoff (blueprints + geometry)', () => {
  function renderableDoc(...parts: Parameters<typeof composeScenario>): ScenarioDoc {
    return { company: { slug: 'render-co', name: 'Render Co' }, ...composeScenario(...parts) }
  }

  it('seeds a blueprint document + a calibrated, scale-verified page', () => {
    const doc = renderableDoc(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      blueprintWithCalibratedPage('bp', { projectRef: 'alpha' }),
    )
    const plan = planScenario(doc, { companyId: COMPANY_ID, now: NOW })

    const docOp = opByLabel(plan, 'blueprint_document:bp')
    expect(docOp?.kind).toBe('query')
    if (docOp?.kind === 'query') {
      expect(docOp.text).toMatch(/insert into blueprint_documents/i)
      // storage_path is the opaque <companyId>/<docId>/<file> placeholder.
      expect(docOp.values[4]).toMatch(new RegExp(`^${COMPANY_ID}/[0-9a-f-]+/bp\\.pdf$`))
    }

    const pageOp = opByLabel(plan, 'blueprint_page:bp-p1')
    expect(pageOp?.kind).toBe('query')
    if (pageOp?.kind === 'query') {
      expect(pageOp.text).toMatch(/insert into blueprint_pages/i)
      // calibration columns: distance, unit, x1,y1,x2,y2 (params 6..11)
      expect(pageOp.values[5]).toBe(60) // calibration_world_distance
      expect(pageOp.values[6]).toBe('ft') // calibration_world_unit
      expect(pageOp.values[7]).toBe(18) // x1
      // verified ⇒ both calibration_set_at and scale_verified_at stamped to NOW
      expect(pageOp.values[11]).toBe(NOW.toISOString()) // calibration_set_at
      expect(pageOp.values[13]).toBe(NOW.toISOString()) // scale_verified_at
    }
  })

  it('a geometry-carrying measurement emits geometry_kind + valid board-space points + page_id', () => {
    const doc = renderableDoc(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      blueprintWithCalibratedPage('bp', { projectRef: 'alpha' }),
      takeoffDraftWithGeometry('manual-1', { projectRef: 'alpha', blueprintRef: 'bp', pageRef: 'bp-p1' }),
    )
    const plan = planScenario(doc, { companyId: COMPANY_ID, now: NOW })

    const pageId = (() => {
      const p = opByLabel(plan, 'blueprint_page:bp-p1')
      return p?.kind === 'query' ? p.values[0] : undefined
    })()
    const blueprintId = (() => {
      const d = opByLabel(plan, 'blueprint_document:bp')
      return d?.kind === 'query' ? d.values[0] : undefined
    })()

    // First measurement (polygon, wall area).
    const m0 = opByLabel(plan, 'takeoff_draft:measurement:manual-1:0')
    expect(m0?.kind).toBe('query')
    if (m0?.kind === 'query') {
      expect(m0.text).toMatch(/geometry_kind/)
      expect(m0.text).toMatch(/page_id/)
      // values: id, company, project, draft, code, qty, unit, geometryJson, geometryKind, pageId, blueprintId, ...
      expect(m0.values[8]).toBe('polygon') // geometry_kind
      expect(m0.values[9]).toBe(pageId) // page_id resolved from page_ref
      expect(m0.values[10]).toBe(blueprintId) // blueprint_document_id resolved from blueprint_ref

      const geometry = JSON.parse(m0.values[7] as string) as { kind: string; points: Array<{ x: number; y: number }> }
      expect(geometry.kind).toBe('polygon')
      expect(geometry.points.length).toBeGreaterThanOrEqual(3) // valid polygon
      for (const pt of geometry.points) {
        expect(pt.x).toBeGreaterThanOrEqual(0)
        expect(pt.x).toBeLessThanOrEqual(100)
        expect(pt.y).toBeGreaterThanOrEqual(0)
        expect(pt.y).toBeLessThanOrEqual(100)
      }
    }

    // Second measurement is a lineal run (≥2 points).
    const m1 = opByLabel(plan, 'takeoff_draft:measurement:manual-1:1')
    if (m1?.kind === 'query') {
      expect(m1.values[8]).toBe('lineal')
      const geometry = JSON.parse(m1.values[7] as string) as { points: unknown[] }
      expect(geometry.points.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('an AI-capture-pending-review draft seeds review_required + result_json', () => {
    const doc = renderableDoc(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      blueprintWithCalibratedPage('bp', { projectRef: 'alpha' }),
      aiCaptureDraftPendingReview('ai-1', { projectRef: 'alpha', blueprintRef: 'bp', pageRef: 'bp-p1' }),
    )
    const plan = planScenario(doc, { companyId: COMPANY_ID, now: NOW })

    const draftOp = opByLabel(plan, 'takeoff_draft:ai-1')
    expect(draftOp?.kind).toBe('query')
    if (draftOp?.kind === 'query') {
      // insert into takeoff_drafts (..., source, kind, review_required, takeoff_result_json)
      expect(draftOp.values[6]).toBe('blueprint_vision') // source
      expect(draftOp.values[8]).toBe(true) // review_required
      const resultJson = JSON.parse(draftOp.values[9] as string) as {
        quantities: Array<{ confidence: number }>
      }
      expect(resultJson.quantities.length).toBeGreaterThan(0)
      // mixed confidence — at least one high and one low.
      const confidences = resultJson.quantities.map((q) => q.confidence)
      expect(Math.max(...confidences)).toBeGreaterThan(0.8)
      expect(Math.min(...confidences)).toBeLessThan(0.5)
    }
  })

  it('plans blueprints + conditions before the measurements that reference them', () => {
    const doc = renderableDoc(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      blueprintWithCalibratedPage('bp', { projectRef: 'alpha' }),
      takeoffDraftWithGeometry('manual-1', { projectRef: 'alpha', blueprintRef: 'bp', pageRef: 'bp-p1' }),
    )
    const plan = planScenario(doc, { companyId: COMPANY_ID, now: NOW })
    const pageIdx = plan.ops.findIndex((o) => o.label === 'blueprint_page:bp-p1')
    const measIdx = plan.ops.findIndex((o) => o.label === 'takeoff_draft:measurement:manual-1:0')
    expect(pageIdx).toBeGreaterThanOrEqual(0)
    expect(measIdx).toBeGreaterThan(pageIdx)
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
