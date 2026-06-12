import { describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ request }))

import {
  appIssueTriageActionAllowed,
  readAppIssueCaptureAnalysis,
  readAppIssueCaptureAnalysisReadiness,
  triageAppIssue,
} from './app-issues'

describe('appIssueTriageActionAllowed', () => {
  it('mirrors the server gate: accept only from fresh/bounced states', () => {
    expect(appIssueTriageActionAllowed('accept', 'new')).toBe(true)
    expect(appIssueTriageActionAllowed('accept', 'reopened')).toBe(true)
    expect(appIssueTriageActionAllowed('accept', 'review_stale')).toBe(true)
    expect(appIssueTriageActionAllowed('accept', 'proposal_expired')).toBe(true)
    expect(appIssueTriageActionAllowed('accept', 'triaged')).toBe(false)
    expect(appIssueTriageActionAllowed('accept', 'review_ready')).toBe(false)
    expect(appIssueTriageActionAllowed('accept', 'resolved')).toBe(false)
  })

  it('mirrors the server gate: resolve/wont_do from any non-terminal state only', () => {
    for (const action of ['resolve', 'wont_do'] as const) {
      expect(appIssueTriageActionAllowed(action, 'new')).toBe(true)
      expect(appIssueTriageActionAllowed(action, 'agent_running')).toBe(true)
      expect(appIssueTriageActionAllowed(action, 'review_ready')).toBe(true)
      // Terminal human decisions are never overwritten.
      expect(appIssueTriageActionAllowed(action, 'resolved')).toBe(false)
      expect(appIssueTriageActionAllowed(action, 'wont_do')).toBe(false)
      expect(appIssueTriageActionAllowed(action, 'reversed')).toBe(false)
    }
  })
})

describe('triageAppIssue', () => {
  it('POSTs the action to the issue events surface', async () => {
    request.mockResolvedValueOnce({ issue: { id: 'wi-1' }, event: null })

    await triageAppIssue('wi-1', { action: 'resolve', message: 'verified the fix' })

    expect(request).toHaveBeenCalledWith('/api/issues/wi-1/events', {
      method: 'POST',
      json: { action: 'resolve', message: 'verified the fix' },
    })
  })
})

describe('readAppIssueCaptureAnalysis', () => {
  it('reads the analyzer write-back shape (agent-feed applyTerminalCallbackEffects)', () => {
    const analysis = readAppIssueCaptureAnalysis({
      capture_analysis: {
        markdown: '## Transcript\nUser narrated the bug.',
        completed_at: '2026-06-12T00:00:00.000Z',
        artifacts: [{ kind: 'analysis', ref: 'artifact-1' }],
      },
    })
    expect(analysis).toEqual({
      markdown: '## Transcript\nUser narrated the bug.',
      completed_at: '2026-06-12T00:00:00.000Z',
      artifacts: [{ kind: 'analysis', ref: 'artifact-1' }],
    })
  })

  it('returns null for missing/empty/malformed metadata', () => {
    expect(readAppIssueCaptureAnalysis(undefined)).toBeNull()
    expect(readAppIssueCaptureAnalysis({})).toBeNull()
    expect(readAppIssueCaptureAnalysis({ capture_analysis: { markdown: '   ' } })).toBeNull()
    expect(readAppIssueCaptureAnalysis({ capture_analysis: 'not-an-object' })).toBeNull()
    // Missing optional fields degrade, never throw.
    expect(readAppIssueCaptureAnalysis({ capture_analysis: { markdown: 'x' } })).toEqual({
      markdown: 'x',
      completed_at: null,
      artifacts: [],
    })
  })
})

describe('readAppIssueCaptureAnalysisReadiness', () => {
  it('reads the worker readiness strip (capture-artifact-analysis.ts)', () => {
    const readiness = readAppIssueCaptureAnalysisReadiness({
      capture_artifact_analysis: {
        status: 'pending',
        eligible_artifact_count: 3,
        processed_artifact_count: 1,
        pending_artifact_count: 2,
        audio_mode: 'transcribe',
        video_mode: 'off',
        updated_at: '2026-06-12T00:00:00.000Z',
      },
    })
    expect(readiness).toEqual({
      status: 'pending',
      eligible_artifact_count: 3,
      processed_artifact_count: 1,
      pending_artifact_count: 2,
      updated_at: '2026-06-12T00:00:00.000Z',
    })
  })

  it('returns null without a status and tolerates missing counts', () => {
    expect(readAppIssueCaptureAnalysisReadiness({})).toBeNull()
    expect(readAppIssueCaptureAnalysisReadiness({ capture_artifact_analysis: {} })).toBeNull()
    expect(readAppIssueCaptureAnalysisReadiness({ capture_artifact_analysis: { status: 'ready' } })).toEqual({
      status: 'ready',
      eligible_artifact_count: null,
      processed_artifact_count: null,
      pending_artifact_count: null,
      updated_at: null,
    })
  })
})
