import { useCallback, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

/**
 * UI state machine for the rental return reconciliation flow.
 *
 * Mirrors `submit-form.ts` in shape: idle → submitting → idle (with
 * optional success/error context). Owns ONLY UI state (counts, photos,
 * is-submitting, error). Business state (returned_on, status, damage
 * charges) is the API's responsibility.
 *
 *   idle ─UPDATE_COUNT▶ idle (counts edited)
 *   idle ─SUBMIT▶ submitting ─onDone▶ idle (success=true, result=row)
 *                                ─onError▶ idle (error=…)
 *
 * Components use the hook below to render the sheet — `submit(payload)`
 * returns a void; the result is read off `result` once the machine
 * settles. This is the same pattern submit-form uses, so screens that
 * wrap this can stay similarly thin.
 */

export interface RentalReturnPayload {
  qty_good: number
  qty_damaged: number
  qty_lost: number
  damage_photos: string[]
  damage_charges_cents: number
  original_qty?: number
}

export interface RentalReturnCounts {
  qty_good: number
  qty_damaged: number
  qty_lost: number
}

type Context<TResult> = {
  submitter: (payload: RentalReturnPayload) => Promise<TResult>
  counts: RentalReturnCounts
  photos: string[]
  damageChargesCents: number
  result: TResult | null
  error: string | null
  success: boolean
}

type Event =
  | { type: 'UPDATE_COUNT'; key: keyof RentalReturnCounts; value: number }
  | { type: 'UPDATE_PHOTOS'; photos: string[] }
  | { type: 'UPDATE_CHARGES'; cents: number }
  | { type: 'SUBMIT'; payload: RentalReturnPayload }
  | { type: 'RESET' }

export function createRentalReturnMachine<TResult>() {
  return setup({
    types: {
      context: {} as Context<TResult>,
      input: {} as { submitter: (payload: RentalReturnPayload) => Promise<TResult> },
      events: {} as Event,
    },
    actors: {
      run: fromPromise<
        TResult,
        { payload: RentalReturnPayload; submitter: (payload: RentalReturnPayload) => Promise<TResult> }
      >(async ({ input }) => input.submitter(input.payload)),
    },
  }).createMachine({
    id: 'rentalReturn',
    initial: 'idle',
    context: ({ input }) => ({
      submitter: input.submitter,
      counts: { qty_good: 0, qty_damaged: 0, qty_lost: 0 },
      photos: [],
      damageChargesCents: 0,
      result: null,
      error: null,
      success: false,
    }),
    states: {
      idle: {
        on: {
          UPDATE_COUNT: {
            actions: assign({
              counts: ({ context, event }) => ({
                ...context.counts,
                [event.key]: Math.max(0, Math.floor(event.value)),
              }),
            }),
          },
          UPDATE_PHOTOS: {
            actions: assign({ photos: ({ event }) => event.photos }),
          },
          UPDATE_CHARGES: {
            actions: assign({ damageChargesCents: ({ event }) => Math.max(0, Math.floor(event.cents)) }),
          },
          SUBMIT: 'submitting',
          RESET: {
            actions: assign({
              counts: () => ({ qty_good: 0, qty_damaged: 0, qty_lost: 0 }),
              photos: () => [],
              damageChargesCents: () => 0,
              error: () => null,
              success: () => false,
              result: () => null,
            }),
          },
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
              error: ({ event }) => (event.error instanceof Error ? event.error.message : 'return failed'),
              success: () => false,
            }),
          },
        },
      },
    },
  })
}

/**
 * Hook wrapper. Returns a tight object the sheet can drive without
 * carrying any direct xstate awareness — same idea as `useSubmitForm`.
 */
export function useRentalReturn<TResult>(submitter: (payload: RentalReturnPayload) => Promise<TResult>) {
  const machine = useMemo(() => createRentalReturnMachine<TResult>(), [])
  const [state, send] = useMachine(machine, { input: { submitter } })

  const setCount = useCallback(
    (key: keyof RentalReturnCounts, value: number) => send({ type: 'UPDATE_COUNT', key, value }),
    [send],
  )
  const setPhotos = useCallback((photos: string[]) => send({ type: 'UPDATE_PHOTOS', photos }), [send])
  const setCharges = useCallback((cents: number) => send({ type: 'UPDATE_CHARGES', cents }), [send])
  const submit = useCallback((payload: RentalReturnPayload) => send({ type: 'SUBMIT', payload }), [send])
  const reset = useCallback(() => send({ type: 'RESET' }), [send])

  return {
    counts: state.context.counts,
    photos: state.context.photos,
    damageChargesCents: state.context.damageChargesCents,
    setCount,
    setPhotos,
    setCharges,
    submit,
    reset,
    isSubmitting: state.matches('submitting'),
    error: state.context.error,
    success: state.context.success,
    result: state.context.result,
  }
}
