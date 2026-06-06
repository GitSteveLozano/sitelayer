import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetLiveWorkflowAnchorForTests,
  readLiveWorkflowAnchor,
  recordLiveWorkflowAnchor,
} from './live-workflow-anchor'

describe('live-workflow-anchor', () => {
  afterEach(() => __resetLiveWorkflowAnchorForTests())

  it('returns the most recent anchor within the freshness window', () => {
    recordLiveWorkflowAnchor({
      eventRef: 'workflow_event:rental:a:1',
      workflowName: 'rental',
      entityId: 'r1',
      now: () => 1_000,
    })
    recordLiveWorkflowAnchor({
      eventRef: 'workflow_event:rental:a:2',
      workflowName: 'rental',
      entityId: 'r1',
      now: () => 2_000,
    })
    const anchor = readLiveWorkflowAnchor(() => 5_000)
    expect(anchor?.eventRef).toBe('workflow_event:rental:a:2')
  })

  it('forgets a stale anchor past the TTL', () => {
    recordLiveWorkflowAnchor({
      eventRef: 'workflow_event:rental:a:1',
      workflowName: 'rental',
      entityId: 'r1',
      now: () => 0,
    })
    // 2 minutes + 1s later → past the 2-minute TTL.
    expect(readLiveWorkflowAnchor(() => 121_000)).toBeNull()
  })

  it('ignores an empty event ref', () => {
    recordLiveWorkflowAnchor({ eventRef: '', workflowName: 'rental', entityId: 'r1' })
    expect(readLiveWorkflowAnchor()).toBeNull()
  })
})
