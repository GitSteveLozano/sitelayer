import { describe, expect, it } from 'vitest'
import { metricsRegistry, observeContextHandoff, observeWorkflowEvent, workflowEventOutcome } from './metrics.js'

// Tests run against the singleton registry. Because vitest module
// state persists across `it` blocks within the same file, each
// assertion reads the counter value relative to a baseline captured
// at the top of the test rather than asserting an absolute value.
async function readWorkflowEventCounter(): Promise<Array<{ workflow: string; outcome: string; value: number }>> {
  const metric = metricsRegistry().getSingleMetric('sitelayer_workflow_event_total')
  if (!metric) throw new Error('sitelayer_workflow_event_total not registered')
  const snapshot = await metric.get()
  return snapshot.values.map((v) => ({
    workflow: String(v.labels.workflow ?? ''),
    outcome: String(v.labels.outcome ?? ''),
    value: v.value,
  }))
}

function valueFor(
  rows: Array<{ workflow: string; outcome: string; value: number }>,
  workflow: string,
  outcome: string,
): number {
  return rows.find((r) => r.workflow === workflow && r.outcome === outcome)?.value ?? 0
}

async function readContextHandoffCounter(): Promise<Array<{ action: string; value: number }>> {
  const metric = metricsRegistry().getSingleMetric('sitelayer_context_handoff_total')
  if (!metric) throw new Error('sitelayer_context_handoff_total not registered')
  const snapshot = await metric.get()
  return snapshot.values.map((v) => ({
    action: String(v.labels.action ?? ''),
    value: v.value,
  }))
}

function contextValueFor(rows: Array<{ action: string; value: number }>, action: string): number {
  return rows.find((r) => r.action === action)?.value ?? 0
}

describe('workflowEventTotal counter', () => {
  it('is registered with the expected name on the singleton registry', async () => {
    const metric = metricsRegistry().getSingleMetric('sitelayer_workflow_event_total')
    expect(metric).toBeDefined()
    const snapshot = await metric!.get()
    expect(snapshot.name).toBe('sitelayer_workflow_event_total')
    expect(snapshot.type).toBe('counter')
  })

  it('increments for the (workflow, outcome) label pair', async () => {
    const before = await readWorkflowEventCounter()
    const baseline = valueFor(before, 'estimate_push', 'requested')

    observeWorkflowEvent('estimate_push', 'requested')
    observeWorkflowEvent('estimate_push', 'requested')

    const after = await readWorkflowEventCounter()
    expect(valueFor(after, 'estimate_push', 'requested')).toBe(baseline + 2)
  })

  it('keeps independent series per outcome label', async () => {
    const before = await readWorkflowEventCounter()
    const baselineSucceeded = valueFor(before, 'qbo_sync_run', 'succeeded')
    const baselineFailed = valueFor(before, 'qbo_sync_run', 'failed')

    observeWorkflowEvent('qbo_sync_run', 'succeeded')
    observeWorkflowEvent('qbo_sync_run', 'failed')
    observeWorkflowEvent('qbo_sync_run', 'failed')

    const after = await readWorkflowEventCounter()
    expect(valueFor(after, 'qbo_sync_run', 'succeeded')).toBe(baselineSucceeded + 1)
    expect(valueFor(after, 'qbo_sync_run', 'failed')).toBe(baselineFailed + 2)
  })
})

describe('contextHandoffTotal counter', () => {
  it('increments for bounded work-request action labels', async () => {
    const before = await readContextHandoffCounter()
    const baseline = contextValueFor(before, 'agent.dispatch_requested')

    observeContextHandoff('agent.dispatch_requested')
    observeContextHandoff('agent.dispatch_requested', 2)

    const after = await readContextHandoffCounter()
    expect(contextValueFor(after, 'agent.dispatch_requested')).toBe(baseline + 3)
  })
})

describe('contextDispatchOutboxCount gauge', () => {
  it('is registered for context-dispatch backpressure', async () => {
    const metric = metricsRegistry().getSingleMetric('sitelayer_context_dispatch_outbox_count')
    expect(metric).toBeDefined()
    const snapshot = await metric!.get()
    expect(snapshot.name).toBe('sitelayer_context_dispatch_outbox_count')
    expect(snapshot.type).toBe('gauge')
  })
})

describe('workflowEventOutcome', () => {
  it('maps dispatcher events to "requested"', () => {
    expect(workflowEventOutcome('START_SYNC')).toBe('requested')
    expect(workflowEventOutcome('POST_REQUESTED')).toBe('requested')
    expect(workflowEventOutcome('SUBMIT')).toBe('requested')
  })

  it('maps happy terminal events to "succeeded"', () => {
    expect(workflowEventOutcome('POST_SUCCEEDED')).toBe('succeeded')
    expect(workflowEventOutcome('SYNC_SUCCEEDED')).toBe('succeeded')
    expect(workflowEventOutcome('APPROVE')).toBe('succeeded')
    expect(workflowEventOutcome('CONFIRM')).toBe('succeeded')
  })

  it('maps failure-tagged events to "failed"', () => {
    expect(workflowEventOutcome('POST_FAILED')).toBe('failed')
    expect(workflowEventOutcome('SYNC_FAILED')).toBe('failed')
    expect(workflowEventOutcome('DECLINE')).toBe('failed')
    expect(workflowEventOutcome('REJECT')).toBe('failed')
  })

  it('maps VOID to "voided" and RETRY_POST to "retried"', () => {
    expect(workflowEventOutcome('VOID')).toBe('voided')
    expect(workflowEventOutcome('RETRY_POST')).toBe('retried')
    expect(workflowEventOutcome('RETRY')).toBe('retried')
  })

  it('returns null for unknown / intermediate events so cardinality stays bounded', () => {
    expect(workflowEventOutcome('REVIEW')).toBeNull()
    expect(workflowEventOutcome('OPEN_RETURN')).toBeNull()
    expect(workflowEventOutcome('SOMETHING_ELSE')).toBeNull()
  })
})
