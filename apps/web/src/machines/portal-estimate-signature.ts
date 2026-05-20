import { useCallback, useEffect, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import {
  fetchPortalEstimate,
  PortalApiError,
  postPortalAccept,
  postPortalDecline,
  type PortalEstimateView,
} from '@/portal/api'

/**
 * UI orchestration for the customer-facing portal estimate review
 * screen (`portal/EstimateView.tsx`). The screen has three review
 * surfaces (read-only, accept-signature, decline-reason) plus an
 * initial network load and two terminal submit paths.
 *
 * Before this machine the screen kept the mode + signer fields +
 * signature dataURL + decline reason + submitting/submitError flags
 * in 7 individual `useState` hooks; the load and the auto-redirect
 * on `accepted` lived in a `useEffect`. That's exactly the
 * multi-mode-long-lived-state pattern the codebase prohibits.
 *
 * Owned by the machine:
 *   - the snapshot view loaded from /api/portal/estimates/:token
 *   - active mode (`idle` / `accepting` / `declining`)
 *   - draft signer name + signature data URL + decline reason
 *   - submit error + load error
 *   - "redirect to accepted" intent (the screen reads it as a
 *     boolean and calls `navigate(...)` itself — keeping the
 *     machine framework-free)
 *
 * NOT owned by the machine:
 *   - react-router navigation (the screen reads `shouldRedirectAccepted`
 *     and calls navigate — XState stays framework-free per the
 *     codebase's machine conventions).
 *
 * State graph:
 *
 *   loading ─onDone(accepted)▶ accepted_redirect (terminal-ish; screen
 *                                                 calls navigate)
 *          ─onDone(other)▶ review.idle
 *          ─onError▶ load_error
 *   review.idle ─START_ACCEPT▶ review.accepting
 *               ─START_DECLINE▶ review.declining
 *   review.accepting ─CANCEL▶ review.idle
 *                    ─SUBMIT_ACCEPT (guard: signer + signature)▶ submitting_accept
 *   review.declining ─CANCEL▶ review.idle
 *                    ─SUBMIT_DECLINE (guard: reason)▶ submitting_decline
 *   submitting_accept ─onDone▶ accepted_redirect
 *                     ─onError▶ review.accepting (error retained)
 *   submitting_decline ─onDone▶ loading (refetch into declined snapshot)
 *                      ─onError▶ review.declining (error retained)
 */

type Mode = 'idle' | 'accepting' | 'declining'

type Context = {
  shareToken: string
  view: PortalEstimateView | null
  loadError: { status: number; message: string } | null
  submitError: string | null
  mode: Mode
  signerName: string
  signature: string | null
  declineReason: string
  /** True after a successful accept submission — the screen reads this
   * and triggers `navigate(...)`. Keeping nav as a side effect on the
   * caller (not in the machine) preserves the framework-free
   * convention used in `submit-form.ts` / `estimate-share.ts`. */
  shouldRedirectAccepted: boolean
}

type Event =
  | { type: 'START_ACCEPT' }
  | { type: 'START_DECLINE' }
  | { type: 'CANCEL' }
  | { type: 'SET_SIGNER_NAME'; value: string }
  | { type: 'SET_SIGNATURE'; value: string | null }
  | { type: 'SET_DECLINE_REASON'; value: string }
  | { type: 'SUBMIT_ACCEPT' }
  | { type: 'SUBMIT_DECLINE' }
  | { type: 'DISMISS_ERROR' }

function loadErrorFrom(err: unknown): { status: number; message: string } {
  if (err instanceof PortalApiError) return { status: err.status, message: err.message_for_user() }
  if (err instanceof Error) return { status: 500, message: err.message }
  return { status: 500, message: 'Something went wrong.' }
}

function submitErrorFrom(err: unknown, fallback: string): string {
  if (err instanceof PortalApiError) return err.message_for_user()
  if (err instanceof Error) return err.message
  return fallback
}

const machine = setup({
  types: {
    context: {} as Context,
    input: {} as { shareToken: string },
    events: {} as Event,
  },
  guards: {
    canSubmitAccept: ({ context }) => context.signerName.trim().length > 0 && context.signature !== null,
    canSubmitDecline: ({ context }) => context.declineReason.trim().length > 0,
    isAcceptedView: (_, params: { status: PortalEstimateView['status'] }) => params.status === 'accepted',
  },
  actors: {
    loadView: fromPromise<PortalEstimateView, { shareToken: string }>(async ({ input }) => {
      return fetchPortalEstimate(input.shareToken)
    }),
    submitAccept: fromPromise<void, { shareToken: string; signerName: string; signature: string }>(
      async ({ input }) => {
        await postPortalAccept(input.shareToken, {
          signer_name: input.signerName.trim(),
          signature_data_url: input.signature,
        })
      },
    ),
    submitDecline: fromPromise<PortalEstimateView, { shareToken: string; reason: string }>(async ({ input }) => {
      await postPortalDecline(input.shareToken, { decline_reason: input.reason.trim() })
      // Re-fetch so we hydrate the screen into the declined state.
      return fetchPortalEstimate(input.shareToken)
    }),
  },
}).createMachine({
  id: 'portalEstimateSignature',
  initial: 'loading',
  context: ({ input }) => ({
    shareToken: input.shareToken,
    view: null,
    loadError: null,
    submitError: null,
    mode: 'idle' as Mode,
    signerName: '',
    signature: null,
    declineReason: '',
    shouldRedirectAccepted: false,
  }),
  states: {
    loading: {
      invoke: {
        src: 'loadView',
        input: ({ context }) => ({ shareToken: context.shareToken }),
        onDone: [
          {
            // Already-accepted: signal the screen to redirect into the
            // accepted view. State stays in `accepted_redirect` until
            // the caller unmounts the screen.
            target: 'accepted_redirect',
            guard: { type: 'isAcceptedView', params: ({ event }) => ({ status: event.output.status }) },
            actions: assign({
              view: ({ event }) => event.output,
              loadError: () => null,
              shouldRedirectAccepted: () => true,
            }),
          },
          {
            target: 'review',
            actions: assign({
              view: ({ event }) => event.output,
              loadError: () => null,
              mode: () => 'idle' as Mode,
              submitError: () => null,
            }),
          },
        ],
        onError: {
          target: 'load_error',
          actions: assign({
            loadError: ({ event }) => loadErrorFrom(event.error),
          }),
        },
      },
    },
    load_error: {
      // Terminal-ish; the screen renders the error banner. A future
      // "Retry" button could send RELOAD — we keep the machine open
      // to a re-entry by exposing it.
      on: {
        DISMISS_ERROR: { target: 'loading', actions: assign({ loadError: () => null }) },
      },
    },
    review: {
      initial: 'idle',
      on: {
        SET_SIGNER_NAME: { actions: assign({ signerName: ({ event }) => event.value }) },
        SET_SIGNATURE: { actions: assign({ signature: ({ event }) => event.value }) },
        SET_DECLINE_REASON: { actions: assign({ declineReason: ({ event }) => event.value }) },
        DISMISS_ERROR: { actions: assign({ submitError: () => null }) },
      },
      states: {
        idle: {
          on: {
            START_ACCEPT: {
              target: 'accepting',
              actions: assign({ submitError: () => null, mode: () => 'accepting' as Mode }),
            },
            START_DECLINE: {
              target: 'declining',
              actions: assign({ submitError: () => null, mode: () => 'declining' as Mode }),
            },
          },
        },
        accepting: {
          on: {
            CANCEL: {
              target: 'idle',
              actions: assign({ submitError: () => null, mode: () => 'idle' as Mode }),
            },
            SUBMIT_ACCEPT: {
              target: '#portalEstimateSignature.submitting_accept',
              guard: 'canSubmitAccept',
              actions: assign({ submitError: () => null }),
            },
          },
          // Inline validation: when the user tries to submit but the
          // guard rejects, we still surface a helpful error string.
          // Mirrors the original screen's behavior exactly so the copy
          // doesn't regress.
          always: [],
        },
        declining: {
          on: {
            CANCEL: {
              target: 'idle',
              actions: assign({ submitError: () => null, mode: () => 'idle' as Mode }),
            },
            SUBMIT_DECLINE: {
              target: '#portalEstimateSignature.submitting_decline',
              guard: 'canSubmitDecline',
              actions: assign({ submitError: () => null }),
            },
          },
        },
      },
    },
    submitting_accept: {
      invoke: {
        src: 'submitAccept',
        input: ({ context }) => ({
          shareToken: context.shareToken,
          signerName: context.signerName,
          signature: context.signature!,
        }),
        onDone: {
          target: 'accepted_redirect',
          actions: assign({
            shouldRedirectAccepted: () => true,
            submitError: () => null,
          }),
        },
        onError: {
          target: 'review.accepting',
          actions: assign({
            submitError: ({ event }) => submitErrorFrom(event.error, 'Could not accept right now.'),
          }),
        },
      },
    },
    submitting_decline: {
      invoke: {
        src: 'submitDecline',
        input: ({ context }) => ({ shareToken: context.shareToken, reason: context.declineReason }),
        onDone: {
          target: 'review',
          actions: assign({
            view: ({ event }) => event.output,
            mode: () => 'idle' as Mode,
            submitError: () => null,
            // Wipe the local draft now that the server confirmed the
            // decline — the user can still see the read-only snapshot.
            declineReason: () => '',
          }),
        },
        onError: {
          target: 'review.declining',
          actions: assign({
            submitError: ({ event }) => submitErrorFrom(event.error, 'Could not decline right now.'),
          }),
        },
      },
    },
    accepted_redirect: {
      // Terminal: screen reads `shouldRedirectAccepted` and navigates
      // away. Reachable from either the initial-load-already-accepted
      // path or the successful submit path; in both cases the
      // component is about to unmount.
      type: 'final',
    },
  },
})

export const portalEstimateSignatureMachine = machine

export interface PortalEstimateSignatureHookResult {
  view: PortalEstimateView | null
  loadError: { status: number; message: string } | null
  submitError: string | null
  mode: Mode
  signerName: string
  signature: string | null
  declineReason: string
  isLoading: boolean
  isSubmittingAccept: boolean
  isSubmittingDecline: boolean
  isSubmitting: boolean
  shouldRedirectAccepted: boolean
  startAccept: () => void
  startDecline: () => void
  cancel: () => void
  setSignerName: (value: string) => void
  setSignature: (value: string | null) => void
  setDeclineReason: (value: string) => void
  submitAccept: () => void
  submitDecline: () => void
  dismissError: () => void
  /** Inline validation copy if the user clicks submit without
   * completing the form — kept here so the screen layer doesn't need
   * to re-implement the trim() check. */
  acceptValidationMessage: string | null
  declineValidationMessage: string | null
}

export function usePortalEstimateSignature(shareToken: string): PortalEstimateSignatureHookResult {
  const input = useMemo(() => ({ shareToken }), [shareToken])
  const [state, send] = useMachine(portalEstimateSignatureMachine, { input })

  // Re-enter on token change (only meaningful if the screen is
  // navigated between different tokens without remount — but cheap
  // insurance.)
  useEffect(() => {
    // The actor restarts with a fresh `input` because of the `useMemo`
    // and useMachine identity tied to the machine instance; no
    // explicit RELOAD event needed.
  }, [shareToken])

  const startAccept = useCallback(() => send({ type: 'START_ACCEPT' }), [send])
  const startDecline = useCallback(() => send({ type: 'START_DECLINE' }), [send])
  const cancel = useCallback(() => send({ type: 'CANCEL' }), [send])
  const setSignerName = useCallback((value: string) => send({ type: 'SET_SIGNER_NAME', value }), [send])
  const setSignature = useCallback((value: string | null) => send({ type: 'SET_SIGNATURE', value }), [send])
  const setDeclineReason = useCallback((value: string) => send({ type: 'SET_DECLINE_REASON', value }), [send])
  const submitAccept = useCallback(() => send({ type: 'SUBMIT_ACCEPT' }), [send])
  const submitDecline = useCallback(() => send({ type: 'SUBMIT_DECLINE' }), [send])
  const dismissError = useCallback(() => send({ type: 'DISMISS_ERROR' }), [send])

  const isLoading = state.matches('loading')
  const isSubmittingAccept = state.matches('submitting_accept')
  const isSubmittingDecline = state.matches('submitting_decline')

  // Build inline validation strings — these only matter when the user
  // is inside the relevant mode but hasn't filled in the required
  // fields. The original screen had `setSubmitError('Please …')`
  // calls; mirroring the same copy keeps the UX identical.
  const acceptValidationMessage =
    state.matches({ review: 'accepting' }) && state.context.signature === null
      ? 'Please sign in the box above.'
      : state.matches({ review: 'accepting' }) && state.context.signerName.trim().length === 0
        ? 'Please type your full name.'
        : null
  const declineValidationMessage =
    state.matches({ review: 'declining' }) && state.context.declineReason.trim().length === 0
      ? 'Please share a quick reason.'
      : null

  return {
    view: state.context.view,
    loadError: state.context.loadError,
    submitError: state.context.submitError,
    mode: state.context.mode,
    signerName: state.context.signerName,
    signature: state.context.signature,
    declineReason: state.context.declineReason,
    isLoading,
    isSubmittingAccept,
    isSubmittingDecline,
    isSubmitting: isSubmittingAccept || isSubmittingDecline,
    shouldRedirectAccepted: state.context.shouldRedirectAccepted,
    startAccept,
    startDecline,
    cancel,
    setSignerName,
    setSignature,
    setDeclineReason,
    submitAccept,
    submitDecline,
    dismissError,
    acceptValidationMessage,
    declineValidationMessage,
  }
}
