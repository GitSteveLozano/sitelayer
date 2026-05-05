import { useCallback, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

/**
 * Generic form-submission UI state machine.
 *
 * idle ─SUBMIT▶ submitting ─onDone▶ idle (success=true)
 *                              ─onError▶ idle (error=…)
 *
 * Owns ONLY UI state — no business state. Use this for any one-shot
 * POST/PATCH where the caller wants:
 *   - a `submit` callback that returns a promise
 *   - `isSubmitting` for button-disable
 *   - `error` (string) for inline display
 *   - `success` boolean (resets on the next submit)
 *
 * The machine's actor receives the payload as input and returns the
 * server response. The hook narrows the types so callers stay
 * type-safe without rewriting the machine for each form.
 */

type Context<TPayload, TResult> = {
  submitter: (payload: TPayload) => Promise<TResult>
  result: TResult | null
  error: string | null
  success: boolean
}

type Event<TPayload> = { type: 'SUBMIT'; payload: TPayload } | { type: 'RESET' }

export function createSubmitFormMachine<TPayload, TResult>() {
  return setup({
    types: {
      context: {} as Context<TPayload, TResult>,
      input: {} as { submitter: (payload: TPayload) => Promise<TResult> },
      events: {} as Event<TPayload>,
    },
    actors: {
      run: fromPromise<TResult, { payload: TPayload; submitter: (payload: TPayload) => Promise<TResult> }>(
        async ({ input }) => input.submitter(input.payload),
      ),
    },
  }).createMachine({
    id: 'submitForm',
    initial: 'idle',
    context: ({ input }) => ({
      submitter: input.submitter,
      result: null,
      error: null,
      success: false,
    }),
    states: {
      idle: {
        on: {
          SUBMIT: 'submitting',
          RESET: { actions: assign({ error: () => null, success: () => false, result: () => null }) },
        },
      },
      submitting: {
        invoke: {
          src: 'run',
          input: ({ context, event }) => {
            if (event.type !== 'SUBMIT') throw new Error('submitting entered without SUBMIT event')
            return { payload: event.payload, submitter: context.submitter }
          },
          onDone: {
            target: 'idle',
            actions: assign({
              result: ({ event }) => event.output,
              error: () => null,
              success: () => true,
            }),
          },
          onError: {
            target: 'idle',
            actions: assign({
              error: ({ event }) => (event.error instanceof Error ? event.error.message : 'submit failed'),
              success: () => false,
            }),
          },
        },
      },
    },
  })
}

export function useSubmitForm<TPayload, TResult>(submitter: (payload: TPayload) => Promise<TResult>) {
  const machine = useMemo(() => createSubmitFormMachine<TPayload, TResult>(), [])
  const [state, send] = useMachine(machine, { input: { submitter } })

  const submit = useCallback((payload: TPayload) => send({ type: 'SUBMIT', payload }), [send])
  const reset = useCallback(() => send({ type: 'RESET' }), [send])

  return {
    submit,
    reset,
    isSubmitting: state.matches('submitting'),
    error: state.context.error,
    success: state.context.success,
    result: state.context.result,
  }
}
