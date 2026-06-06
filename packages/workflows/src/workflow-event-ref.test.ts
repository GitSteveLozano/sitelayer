import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { matchesWorkflowEventRef, parseWorkflowEventRef, workflowEventRef } from './workflow-event-ref.js'

/** The reference implementation the wire format is defined against. */
function referenceWorkflowEventRef(input: { workflow_name: string; entity_id: string; state_version: number }): string {
  const canonical = `${input.workflow_name}:${input.entity_id}:${input.state_version}`
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  return `workflow_event:${input.workflow_name}:${digest}:${input.state_version}`
}

describe('workflowEventRef', () => {
  it('pins the EXACT anchor string for a known input', () => {
    // Deterministic golden value. If this assertion changes, the frontend
    // stamp and the worker forwarder have silently desynced from mesh ingest.
    const ref = workflowEventRef({
      workflow_name: 'rental_billing_run',
      entity_id: '11111111-2222-3333-4444-555555555555',
      state_version: 3,
    })
    expect(ref).toBe('workflow_event:rental_billing_run:57310a74fe34de0d:3')
  })

  it('matches node:crypto sha256 byte-for-byte (isomorphic digest proof)', () => {
    const cases = [
      { workflow_name: 'rental_billing_run', entity_id: 'abc', state_version: 0 },
      { workflow_name: 'estimate_push', entity_id: '11111111-2222-3333-4444-555555555555', state_version: 3 },
      { workflow_name: 'project_lifecycle', entity_id: 'feed-🚧-café', state_version: 42 },
      { workflow_name: 'daily_log', entity_id: 'x'.repeat(200), state_version: 9999 },
    ]
    for (const input of cases) {
      expect(workflowEventRef(input)).toBe(referenceWorkflowEventRef(input))
    }
  })

  it('uses the canonical workflow_event:<name>:<16hex>:<version> shape', () => {
    const ref = workflowEventRef({ workflow_name: 'estimate_push', entity_id: 'e1', state_version: 7 })
    expect(ref).toMatch(/^workflow_event:estimate_push:[0-9a-f]{16}:7$/)
  })
})

describe('parseWorkflowEventRef', () => {
  it('recovers workflow_name + digest + state_version from a real ref', () => {
    const ref = workflowEventRef({
      workflow_name: 'rental_billing_run',
      entity_id: '11111111-2222-3333-4444-555555555555',
      state_version: 3,
    })
    expect(parseWorkflowEventRef(ref)).toEqual({
      workflow_name: 'rental_billing_run',
      digest: '57310a74fe34de0d',
      state_version: 3,
    })
  })

  it('parses from the right so a colon-containing workflow_name still resolves', () => {
    // Structurally constructed (the digest field need only be 16 hex chars).
    const parsed = parseWorkflowEventRef('workflow_event:weird:name:0123456789abcdef:42')
    expect(parsed).toEqual({ workflow_name: 'weird:name', digest: '0123456789abcdef', state_version: 42 })
  })

  it('rejects malformed strings', () => {
    expect(parseWorkflowEventRef('')).toBeNull()
    expect(parseWorkflowEventRef('nope:rental_billing_run:0123456789abcdef:1')).toBeNull()
    expect(parseWorkflowEventRef('workflow_event:rental_billing_run:nothex:1')).toBeNull()
    expect(parseWorkflowEventRef('workflow_event:rental_billing_run:0123456789abcdef:notnum')).toBeNull()
    expect(parseWorkflowEventRef('workflow_event:rental_billing_run:0123456789abcdef')).toBeNull()
  })
})

describe('matchesWorkflowEventRef', () => {
  const candidate = {
    workflow_name: 'estimate_push',
    entity_id: '11111111-2222-3333-4444-555555555555',
    state_version: 3,
  }

  it('confirms the ref of a candidate row', () => {
    const ref = workflowEventRef(candidate)
    expect(matchesWorkflowEventRef(ref, candidate)).toBe(true)
  })

  it('rejects a wrong entity_id (digest is one-way over entity_id)', () => {
    const ref = workflowEventRef(candidate)
    expect(matchesWorkflowEventRef(ref, { ...candidate, entity_id: 'someone-else' })).toBe(false)
  })

  it('rejects a state_version mismatch', () => {
    const ref = workflowEventRef(candidate)
    expect(matchesWorkflowEventRef(ref, { ...candidate, state_version: 4 })).toBe(false)
  })
})
