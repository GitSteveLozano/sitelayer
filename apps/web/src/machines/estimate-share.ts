import { useCallback, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import {
  createEstimateShare,
  type CreateEstimateShareInput,
  type EstimateShareCreateResponse,
} from '@/lib/api/estimate-shares'

/**
 * UI state machine for the estimator's "send estimate" sheet.
 *
 * Mirrors `submit-form.ts` (the simpler one-shot submit pattern) since
 * the create-share request is a single POST with no follow-up. We do
 * NOT mirror project-lifecycle here — that's the canonical workflow,
 * and this machine intentionally only owns UI state for the send sheet:
 *
 *   idle ─SUBMIT▶ sending ─onDone▶ success
 *                       └─onError▶ error
 *   success/error ─RESET▶ idle
 *
 * On success the result (share_token + share_url) is held on the
 * machine context so the sheet can render the copy-to-clipboard /
 * mailto rows without a second fetch.
 */

type Context = {
  projectId: string
  result: EstimateShareCreateResponse | null
  error: string | null
}

type Event =
  | { type: 'SUBMIT'; payload: CreateEstimateShareInput }
  | { type: 'RESET' }

export function createEstimateShareMachine(projectId: string) {
  return setup({
    types: {
      context: {} as Context,
      input: {} as { projectId: string },
      events: {} as Event,
    },
    actors: {
      send: fromPromise<EstimateShareCreateResponse, { projectId: string; payload: CreateEstimateShareInput }>(
        async ({ input }) => createEstimateShare(input.projectId, input.payload),
      ),
    },
  }).createMachine({
    id: `estimateShare:${projectId}`,
    initial: 'idle',
    context: ({ input }) => ({
      projectId: input.projectId,
      result: null,
      error: null,
    }),
    states: {
      idle: {
        on: {
          SUBMIT: 'sending',
        },
      },
      sending: {
        invoke: {
          src: 'send',
          input: ({ context, event }) => {
            if (event.type !== 'SUBMIT') {
              throw new Error('sending entered without SUBMIT event')
            }
            return { projectId: context.projectId, payload: event.payload }
          },
          onDone: {
            target: 'success',
            actions: assign({
              result: ({ event }) => event.output,
              error: () => null,
            }),
          },
          onError: {
            target: 'error',
            actions: assign({
              error: ({ event }) =>
                event.error instanceof Error ? event.error.message : 'Could not send estimate.',
              result: () => null,
            }),
          },
        },
      },
      success: {
        on: {
          RESET: { target: 'idle', actions: assign({ result: () => null, error: () => null }) },
          SUBMIT: 'sending',
        },
      },
      error: {
        on: {
          RESET: { target: 'idle', actions: assign({ result: () => null, error: () => null }) },
          SUBMIT: 'sending',
        },
      },
    },
  })
}

/**
 * Convenience hook. The shape mirrors `useSubmitForm()` but exposes the
 * typed result so callers can render the share_url without a second
 * data fetch.
 */
export function useEstimateShareMachine(projectId: string) {
  const machine = useMemo(() => createEstimateShareMachine(projectId), [projectId])
  const [state, send] = useMachine(machine, { input: { projectId } })

  const submit = useCallback(
    (payload: CreateEstimateShareInput) => send({ type: 'SUBMIT', payload }),
    [send],
  )
  const reset = useCallback(() => send({ type: 'RESET' }), [send])

  return {
    submit,
    reset,
    isSending: state.matches('sending'),
    isSuccess: state.matches('success'),
    isError: state.matches('error'),
    error: state.context.error,
    result: state.context.result,
  }
}
