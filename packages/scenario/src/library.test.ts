import { describe, expect, it } from 'vitest'
import { applyScenario, planScenario, runFragments, type ApplyContext, type ScenarioDoc } from './index.js'
import {
  aiCaptureDraftPendingReview,
  blueprintWithCalibratedPage,
  bomApproved,
  composeScenario,
  damageChargeOpen,
  estimatePushPendingReview,
  inventoryItem,
  projectInProgress,
  qboSyncRunFailed,
  rentalBillingFailed,
  rentalPostedInvoice,
  rentalStuckPosting,
  starterFixtures,
  takeoffDraftWithGeometry,
} from './library.js'

const COMPANY_ID = '00000000-0000-4000-8000-000000000def'
const NOW = new Date('2026-05-31T12:00:00.000Z')

interface Call {
  text: string
  values: unknown[]
}
class FakeClient {
  calls: Call[] = []
  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.calls.push({ text, values: values ?? [] })
    if (/select id from companies where slug/i.test(text)) return { rows: [{ id: COMPANY_ID }] }
    return { rows: [] }
  }
  count(re: RegExp): number {
    return this.calls.filter((c) => re.test(c.text)).length
  }
}

function docFrom(...parts: Parameters<typeof composeScenario>): ScenarioDoc {
  return { company: { slug: 'lib-co', name: 'Lib Co' }, ...composeScenario(...parts) }
}

describe('composeScenario', () => {
  it('concatenates array sections across fragments', () => {
    const merged = composeScenario(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      projectInProgress('beta', { customerRef: 'cust-1' }),
      rentalStuckPosting('r1', { projectRef: 'alpha', inventoryRef: 'scaffold' }),
    )
    expect(merged.projects).toHaveLength(2)
    expect(merged.rentals).toHaveLength(1)
    expect(merged.customers).toHaveLength(1)
    expect(merged.workers).toHaveLength(1)
    expect(merged.inventory).toHaveLength(1)
  })
})

describe('library fragments fold through the real reducers', () => {
  it('rentalStuckPosting → posting (+ backdated outbox)', () => {
    const doc = docFrom(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      rentalStuckPosting('r1', { projectRef: 'alpha', inventoryRef: 'scaffold', outboxOffsetMinutes: -15 }),
    )
    const plan = planScenario(doc, { companyId: COMPANY_ID, now: NOW })
    const stamp = plan.ops.find((o) => o.label === 'rental_billing_run:stamp:r1')
    expect(stamp?.kind === 'query' && stamp.values[0]).toBe('posting')
    const outbox = plan.ops.find((o) => o.label === 'rental_billing_run:outbox:r1')
    expect(outbox?.kind === 'query' && outbox.values[4]).toBe('-15')
  })

  it('rentalPostedInvoice → posted with QBO id, rentalBillingFailed → failed', () => {
    const doc = docFrom(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      rentalPostedInvoice('paid', { projectRef: 'alpha', inventoryRef: 'scaffold', qboInvoiceId: 'INV-9' }),
      rentalBillingFailed('bad', { projectRef: 'alpha', inventoryRef: 'scaffold' }),
    )
    const plan = planScenario(doc, { companyId: COMPANY_ID, now: NOW })
    const paid = plan.ops.find((o) => o.label === 'rental_billing_run:stamp:paid')
    expect(paid?.kind === 'query' && paid.values[0]).toBe('posted')
    expect(paid?.kind === 'query' && paid.values[7]).toBe('INV-9')
    const bad = plan.ops.find((o) => o.label === 'rental_billing_run:stamp:bad')
    expect(bad?.kind === 'query' && bad.values[0]).toBe('failed')
  })

  it('estimatePushPendingReview → reviewed; qboSyncRunFailed → failed; bomApproved → approved', () => {
    const doc = docFrom(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      estimatePushPendingReview('e1', { projectRef: 'alpha' }),
      qboSyncRunFailed('s1'),
      bomApproved('b1', { projectRef: 'alpha' }),
    )
    const plan = planScenario(doc, { companyId: COMPANY_ID, now: NOW })
    const est = plan.ops.find((o) => o.label === 'estimate_push:stamp:e1')
    expect(est?.kind === 'query' && est.values[0]).toBe('reviewed')
    const sync = plan.ops.find((o) => o.label === 'qbo_sync_run:stamp:s1')
    expect(sync?.kind === 'query' && sync.values[0]).toBe('failed')
    const bom = plan.ops.find((o) => o.label === 'bom:stamp:b1')
    expect(bom?.kind === 'query' && bom.values[0]).toBe('approved')
  })

  it('plans deterministically (re-plan is identical)', () => {
    const doc = docFrom(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      damageChargeOpen('d1', { projectRef: 'alpha', customerRef: 'cust-1' }),
    )
    const a = planScenario(doc, { companyId: COMPANY_ID, now: NOW })
    const b = planScenario(doc, { companyId: COMPANY_ID, now: NOW })
    expect(b).toEqual(a)
  })
})

describe('renderable-takeoff fragments seed a non-blank canvas', () => {
  it('composes blueprint + geometry draft into one idempotent doc', () => {
    const merged = composeScenario(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      blueprintWithCalibratedPage('bp', { projectRef: 'alpha' }),
      takeoffDraftWithGeometry('manual-1', { projectRef: 'alpha', blueprintRef: 'bp', pageRef: 'bp-p1' }),
    )
    expect(merged.blueprints).toHaveLength(1)
    expect(merged.blueprints![0]!.pages).toHaveLength(1)
    expect(merged.takeoff_drafts).toHaveLength(1)
    expect(merged.takeoff_drafts![0]!.measurements).toHaveLength(3)
  })

  it('applies blueprint pages + geometry measurements end-to-end (fake client)', async () => {
    const client = new FakeClient()
    const ctx: ApplyContext<FakeClient> = { now: NOW, seedCompanyDefaults: async () => undefined }
    const doc = docFrom(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      blueprintWithCalibratedPage('bp', { projectRef: 'alpha' }),
      takeoffDraftWithGeometry('manual-1', { projectRef: 'alpha', blueprintRef: 'bp', pageRef: 'bp-p1' }),
      aiCaptureDraftPendingReview('ai-1', { projectRef: 'alpha', blueprintRef: 'bp', pageRef: 'bp-p1' }),
    )
    await applyScenario(client, doc, ctx)

    expect(client.count(/insert into blueprint_documents/i)).toBe(1)
    expect(client.count(/insert into blueprint_pages/i)).toBe(1)
    // 3 manual geometry rows + 2 AI-capture geometry rows.
    expect(client.count(/insert into takeoff_measurements/i)).toBe(5)
    // Every seeded geometry measurement persists real geometry jsonb (not '{}').
    const geomCalls = client.calls.filter((c) => /insert into takeoff_measurements/i.test(c.text))
    for (const call of geomCalls) {
      const geometryJson = call.values[7] as string | null
      expect(geometryJson).toBeTruthy()
      const geometry = JSON.parse(geometryJson as string) as { kind: string }
      expect(['polygon', 'lineal', 'count', 'volume']).toContain(geometry.kind)
    }
  })
})

describe('library applies end-to-end (fake client)', () => {
  it('composed scenario inserts rows, writes event logs, injects defaults', async () => {
    const client = new FakeClient()
    let defaults = 0
    const ctx: ApplyContext<FakeClient> = {
      now: NOW,
      seedCompanyDefaults: async () => {
        defaults += 1
      },
    }
    const doc = docFrom(
      starterFixtures(),
      projectInProgress('alpha', { customerRef: 'cust-1' }),
      rentalPostedInvoice('paid', { projectRef: 'alpha', inventoryRef: 'scaffold' }),
      estimatePushPendingReview('e1', { projectRef: 'alpha' }),
    )
    const summary = await applyScenario(client, doc, ctx)

    expect(summary.projects).toHaveLength(1)
    expect(defaults).toBe(1)
    // 3 rental events (APPROVE, POST_REQUESTED, POST_SUCCEEDED) + 1 estimate (REVIEW).
    expect(client.count(/insert into workflow_event_log/i)).toBe(4)
  })
})

describe('library chains via runFragments', () => {
  it('shares one company and resolves cross-fragment fixtures (self-contained)', async () => {
    const client = new FakeClient()
    const result = await runFragments(
      [
        composeScenario(starterFixtures(), projectInProgress('alpha', { customerRef: 'cust-1' })),
        // Self-contained: re-declare the project + inventory it references
        // (idempotent — same ref-hashed ids, ON CONFLICT DO NOTHING). Fragments
        // are planned independently, so each must resolve its own refs.
        composeScenario(
          projectInProgress('alpha', { customerRef: 'cust-1' }),
          inventoryItem('scaffold', { code: 'SCAF-001' }),
          rentalStuckPosting('r1', { projectRef: 'alpha', inventoryRef: 'scaffold', outboxOffsetMinutes: -15 }),
        ),
      ],
      { slug: 'chain-co', client, now: NOW, seedCompanyDefaults: async () => undefined },
    )
    expect(result.summaries).toHaveLength(2)
    expect(result.refs.projects.get('alpha')).toBeDefined()
    expect(result.refs.rentals.get('r1')?.billing_run_id).toBeDefined()
    expect(client.count(/insert into companies/i)).toBe(1)
  })
})
