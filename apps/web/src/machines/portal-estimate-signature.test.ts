import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Unit tests for the `portalEstimateSignature` machine. Covers:
 *
 *   - initial load → review.idle when status is pending
 *   - initial load → accepted_redirect when status is accepted
 *   - load_error path with PortalApiError translation
 *   - accept happy path: form → guard pass → submit → accepted_redirect
 *   - accept guard: blocks SUBMIT_ACCEPT with no signer / signature
 *   - accept failure: lands back in review.accepting with submitError
 *   - decline happy path: re-loads snapshot to reveal the declined state
 *   - decline guard: blocks SUBMIT_DECLINE with empty reason
 *   - inline validation strings computed by the machine
 */

const fetchPortalEstimateMock = vi.fn()
const postPortalAcceptMock = vi.fn()
const postPortalDeclineMock = vi.fn()

vi.mock('@/portal/api', async () => {
  const actual = await vi.importActual<typeof import('@/portal/api')>('@/portal/api')
  return {
    ...actual,
    fetchPortalEstimate: (...args: unknown[]) => fetchPortalEstimateMock(...args),
    postPortalAccept: (...args: unknown[]) => postPortalAcceptMock(...args),
    postPortalDecline: (...args: unknown[]) => postPortalDeclineMock(...args),
  }
})

import { portalEstimateSignatureMachine } from './portal-estimate-signature.js'
import { PortalApiError, type PortalEstimateView } from '@/portal/api'

const pendingView: PortalEstimateView = {
  id: 'share-1',
  project_name: 'Acme HQ',
  company_name: 'ACME Builders',
  recipient_email: 'jane@example.com',
  recipient_name: 'Jane Doe',
  sent_at: '2026-05-01T00:00:00Z',
  expires_at: '2026-06-01T00:00:00Z',
  status: 'pending',
  estimate: { bid_total: 1000, scope_total: 1000, lines: [], captured_at: '2026-05-01T00:00:00Z' },
  accepted_at: null,
  declined_at: null,
  decline_reason: null,
  signer_name: null,
}

const acceptedView: PortalEstimateView = {
  ...pendingView,
  status: 'accepted',
  accepted_at: '2026-05-02T00:00:00Z',
  signer_name: 'Jane Doe',
}

const declinedView: PortalEstimateView = {
  ...pendingView,
  status: 'declined',
  declined_at: '2026-05-02T00:00:00Z',
  decline_reason: 'Too expensive',
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

function startActor(shareToken = 'tok-1') {
  const actor = createActor(portalEstimateSignatureMachine, { input: { shareToken } })
  actor.start()
  return actor
}

describe('portalEstimateSignatureMachine', () => {
  beforeEach(() => {
    fetchPortalEstimateMock.mockReset()
    postPortalAcceptMock.mockReset()
    postPortalDeclineMock.mockReset()
  })

  describe('initial load', () => {
    it('starts in loading state', () => {
      fetchPortalEstimateMock.mockImplementation(() => new Promise(() => {}))
      const actor = startActor()
      expect(actor.getSnapshot().value).toBe('loading')
    })

    it('pending view lands in review.idle', async () => {
      fetchPortalEstimateMock.mockResolvedValue(pendingView)
      const actor = startActor()
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toEqual({ review: 'idle' })
      expect(snap.context.view).toEqual(pendingView)
      expect(snap.context.loadError).toBeNull()
    })

    it('accepted view short-circuits to accepted_redirect with redirect flag', async () => {
      fetchPortalEstimateMock.mockResolvedValue(acceptedView)
      const actor = startActor()
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('accepted_redirect')
      expect(snap.context.shouldRedirectAccepted).toBe(true)
    })

    it('load failure lands in load_error with user-facing copy', async () => {
      fetchPortalEstimateMock.mockRejectedValue(
        new PortalApiError({ status: 401, path: '/api/portal/estimates/tok-1', body: null }),
      )
      const actor = startActor()
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('load_error')
      expect(snap.context.loadError).toEqual({ status: 401, message: "This link isn't valid." })
    })
  })

  describe('accept flow', () => {
    async function reachReviewIdle() {
      fetchPortalEstimateMock.mockResolvedValue(pendingView)
      const actor = startActor()
      await settle()
      return actor
    }

    it('START_ACCEPT moves to review.accepting and sets mode', async () => {
      const actor = await reachReviewIdle()
      actor.send({ type: 'START_ACCEPT' })
      const snap = actor.getSnapshot()
      expect(snap.value).toEqual({ review: 'accepting' })
      expect(snap.context.mode).toBe('accepting')
    })

    it('SUBMIT_ACCEPT is rejected when signer name is empty', async () => {
      const actor = await reachReviewIdle()
      actor.send({ type: 'START_ACCEPT' })
      actor.send({ type: 'SET_SIGNATURE', value: 'data:image/png;base64,...' })
      actor.send({ type: 'SUBMIT_ACCEPT' })
      // Guard rejects → still in review.accepting
      expect(actor.getSnapshot().value).toEqual({ review: 'accepting' })
      expect(postPortalAcceptMock).not.toHaveBeenCalled()
    })

    it('SUBMIT_ACCEPT is rejected when signature is null', async () => {
      const actor = await reachReviewIdle()
      actor.send({ type: 'START_ACCEPT' })
      actor.send({ type: 'SET_SIGNER_NAME', value: 'Jane Doe' })
      actor.send({ type: 'SUBMIT_ACCEPT' })
      expect(actor.getSnapshot().value).toEqual({ review: 'accepting' })
      expect(postPortalAcceptMock).not.toHaveBeenCalled()
    })

    it('SUBMIT_ACCEPT with valid form → submitting_accept → accepted_redirect', async () => {
      postPortalAcceptMock.mockResolvedValue({
        ok: true,
        accepted_at: '2026-05-02T00:00:00Z',
        signer_name: 'Jane Doe',
        idempotent: false,
      })
      const actor = await reachReviewIdle()
      actor.send({ type: 'START_ACCEPT' })
      actor.send({ type: 'SET_SIGNER_NAME', value: 'Jane Doe' })
      actor.send({ type: 'SET_SIGNATURE', value: 'data:image/png;base64,xyz' })
      actor.send({ type: 'SUBMIT_ACCEPT' })
      expect(actor.getSnapshot().value).toBe('submitting_accept')
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('accepted_redirect')
      expect(snap.context.shouldRedirectAccepted).toBe(true)
      expect(postPortalAcceptMock).toHaveBeenCalledWith('tok-1', {
        signer_name: 'Jane Doe',
        signature_data_url: 'data:image/png;base64,xyz',
      })
    })

    it('SUBMIT_ACCEPT failure → back in review.accepting with submitError', async () => {
      postPortalAcceptMock.mockRejectedValue(
        new PortalApiError({ status: 500, path: '/api/portal/estimates/tok-1/accept', body: null }),
      )
      const actor = await reachReviewIdle()
      actor.send({ type: 'START_ACCEPT' })
      actor.send({ type: 'SET_SIGNER_NAME', value: 'Jane' })
      actor.send({ type: 'SET_SIGNATURE', value: 'sig' })
      actor.send({ type: 'SUBMIT_ACCEPT' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toEqual({ review: 'accepting' })
      expect(snap.context.submitError).toBe('Something went wrong. Please try again.')
    })

    it('CANCEL from review.accepting returns to review.idle', async () => {
      const actor = await reachReviewIdle()
      actor.send({ type: 'START_ACCEPT' })
      actor.send({ type: 'CANCEL' })
      const snap = actor.getSnapshot()
      expect(snap.value).toEqual({ review: 'idle' })
      expect(snap.context.mode).toBe('idle')
    })
  })

  describe('decline flow', () => {
    async function reachReviewIdle() {
      fetchPortalEstimateMock.mockResolvedValue(pendingView)
      const actor = startActor()
      await settle()
      return actor
    }

    it('SUBMIT_DECLINE is rejected with empty reason', async () => {
      const actor = await reachReviewIdle()
      actor.send({ type: 'START_DECLINE' })
      actor.send({ type: 'SUBMIT_DECLINE' })
      expect(actor.getSnapshot().value).toEqual({ review: 'declining' })
      expect(postPortalDeclineMock).not.toHaveBeenCalled()
    })

    it('SUBMIT_DECLINE happy path re-fetches and lands in review.idle', async () => {
      postPortalDeclineMock.mockResolvedValue({
        ok: true,
        declined_at: '2026-05-02T00:00:00Z',
        decline_reason: 'Too expensive',
        idempotent: false,
      })
      fetchPortalEstimateMock.mockResolvedValueOnce(pendingView).mockResolvedValueOnce(declinedView)
      const actor = startActor()
      await settle()
      actor.send({ type: 'START_DECLINE' })
      actor.send({ type: 'SET_DECLINE_REASON', value: 'Too expensive' })
      actor.send({ type: 'SUBMIT_DECLINE' })
      expect(actor.getSnapshot().value).toBe('submitting_decline')
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toEqual({ review: 'idle' })
      expect(snap.context.view).toEqual(declinedView)
      expect(snap.context.mode).toBe('idle')
      expect(snap.context.declineReason).toBe('')
      expect(postPortalDeclineMock).toHaveBeenCalledWith('tok-1', { decline_reason: 'Too expensive' })
    })

    it('SUBMIT_DECLINE failure → back in review.declining with submitError', async () => {
      postPortalDeclineMock.mockRejectedValue(new Error('network down'))
      const actor = await reachReviewIdle()
      actor.send({ type: 'START_DECLINE' })
      actor.send({ type: 'SET_DECLINE_REASON', value: 'Nope' })
      actor.send({ type: 'SUBMIT_DECLINE' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toEqual({ review: 'declining' })
      expect(snap.context.submitError).toBe('network down')
    })
  })

  describe('field setters', () => {
    it('SET_SIGNER_NAME / SET_SIGNATURE / SET_DECLINE_REASON update context anywhere in review', async () => {
      fetchPortalEstimateMock.mockResolvedValue(pendingView)
      const actor = startActor()
      await settle()
      actor.send({ type: 'SET_SIGNER_NAME', value: 'Jane' })
      actor.send({ type: 'SET_SIGNATURE', value: 'sig' })
      actor.send({ type: 'SET_DECLINE_REASON', value: 'Reason' })
      const ctx = actor.getSnapshot().context
      expect(ctx.signerName).toBe('Jane')
      expect(ctx.signature).toBe('sig')
      expect(ctx.declineReason).toBe('Reason')
    })

    it('DISMISS_ERROR clears submitError in review', async () => {
      postPortalAcceptMock.mockRejectedValue(new Error('boom'))
      fetchPortalEstimateMock.mockResolvedValue(pendingView)
      const actor = startActor()
      await settle()
      actor.send({ type: 'START_ACCEPT' })
      actor.send({ type: 'SET_SIGNER_NAME', value: 'Jane' })
      actor.send({ type: 'SET_SIGNATURE', value: 'sig' })
      actor.send({ type: 'SUBMIT_ACCEPT' })
      await settle()
      expect(actor.getSnapshot().context.submitError).toBe('boom')
      actor.send({ type: 'DISMISS_ERROR' })
      expect(actor.getSnapshot().context.submitError).toBeNull()
    })
  })
})
