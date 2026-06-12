import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyScenario, parseScenario, runFragments, type ApplyContext } from './index.js'

/**
 * DB-free wiring tests: a fake `QueryExecutor` records every SQL call so we can
 * assert the engine applies ops in order, drives `applyEventSequence` (real
 * reducers → workflow_event_log inserts), invokes the injected
 * `seedCompanyDefaults`, and threads refs across `runFragments`. The full
 * row-level parity check against a real Postgres lives in
 * `apps/api/src/scenario-replay.golden.test.ts` (gated on RUN_API_INTEGRATION).
 */

const scenariosDir = fileURLToPath(new URL('../../../scenarios', import.meta.url))
const COMPANY_ID = '00000000-0000-4000-8000-000000000abc'
const NOW = new Date('2026-05-31T12:00:00.000Z')

interface Call {
  text: string
  values: unknown[]
}

class FakeClient {
  calls: Call[] = []
  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.calls.push({ text, values: values ?? [] })
    if (/select id from companies where slug/i.test(text)) {
      return { rows: [{ id: COMPANY_ID }] }
    }
    return { rows: [] }
  }
  count(re: RegExp): number {
    return this.calls.filter((c) => re.test(c.text)).length
  }
}

function read(file: string): string {
  return readFileSync(`${scenariosDir}/${file}`, 'utf-8')
}

describe('applyScenario (fake client)', () => {
  it('applies mid-flight-rental: defaults injected, event log written, outbox enqueued', async () => {
    const client = new FakeClient()
    const defaultsCalls: string[] = []
    const ctx: ApplyContext<FakeClient> = {
      now: NOW,
      seedCompanyDefaults: async (_c, companyId) => {
        defaultsCalls.push(companyId)
      },
    }

    const summary = await applyScenario(client, parseScenario(read('mid-flight-rental.yaml')), ctx)

    expect(summary.company_id).toBe(COMPANY_ID)
    expect(summary.company_slug).toBe('acme-midflight')
    // seedCompanyDefaults injected exactly once with the resolved company id.
    expect(defaultsCalls).toEqual([COMPANY_ID])
    // Company upsert ran before anything else.
    expect(client.calls[0]?.text).toMatch(/insert into companies/i)
    // Two human events → two workflow_event_log rows via applyEventSequence.
    expect(client.count(/insert into workflow_event_log/i)).toBe(2)
    // posting → exactly one mutation_outbox row.
    expect(client.count(/insert into mutation_outbox/i)).toBe(1)
    // 3 memberships from the fixture.
    expect(client.count(/insert into company_memberships/i)).toBe(3)
  })

  it('steve-demo applies end-to-end against the fake client', async () => {
    const client = new FakeClient()
    const ctx: ApplyContext<FakeClient> = {
      now: NOW,
      seedCompanyDefaults: async () => undefined,
    }
    const summary = await applyScenario(client, parseScenario(read('steve-demo.yaml')), ctx)
    expect(summary.company_slug).toBe('steve-demo')
    expect(summary.projects).toHaveLength(5)
    // maple-invoice walks APPROVE→POST_REQUESTED→POST_SUCCEEDED (3 rows).
    expect(client.count(/insert into workflow_event_log/i)).toBeGreaterThanOrEqual(3)
    // a context work item + handoff events were produced from the capture session.
    expect(client.count(/insert into context_work_items/i)).toBe(1)
    expect(client.count(/insert into context_handoff_events/i)).toBeGreaterThanOrEqual(2)
    // capture-born work items are app feedback: the insert must stamp the
    // app_issue domain (migration 009 defaults to field_request, which would
    // put the seeded fixture on the wrong board).
    const workItemInsert = client.calls.find((c) => /insert into context_work_items/i.test(c.text))
    expect(workItemInsert?.text).toMatch(/\bdomain\b/)
    expect(workItemInsert?.values).toContain('app_issue')
  })
})

describe('runFragments (fake client)', () => {
  it('shares one company and threads resolved refs forward', async () => {
    const client = new FakeClient()
    let sawProjectInFragment2: string | undefined

    const result = await runFragments(
      [
        // Fragment 1: establish a project.
        { projects: [{ ref: 'p1', name: 'Tower One' }] },
        // Fragment 2: a function of the prior refs — re-declares its fixtures
        // (idempotent) and reads the id fragment 1 produced.
        (frag) => {
          sawProjectInFragment2 = frag.refs.projects.get('p1')
          return {
            projects: [{ ref: 'p1', name: 'Tower One' }],
            inventory: [{ ref: 'inv1', code: 'SCAF' }],
            rentals: [{ ref: 'r1', project_ref: 'p1', inventory_ref: 'inv1', quantity: 5 }],
          }
        },
      ],
      { slug: 'frag-co', client, now: NOW, seedCompanyDefaults: async () => undefined },
    )

    expect(result.companyId).toBe(COMPANY_ID)
    expect(result.summaries).toHaveLength(2)
    // Fragment 2 saw fragment 1's project id, and it's stable across fragments.
    expect(sawProjectInFragment2).toBe(result.refs.projects.get('p1'))
    expect(result.refs.projects.get('p1')).toBeDefined()
    expect(result.refs.rentals.get('r1')?.contract_id).toBeDefined()
    // Company upserted exactly once (shared across fragments).
    expect(client.count(/insert into companies/i)).toBe(1)
  })
})
