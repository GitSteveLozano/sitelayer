import { useCallback } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromCallback, fromPromise, setup } from 'xstate'
import {
  fetchOperatorContextChatResponse,
  stageOperatorContextChatMessage,
  subscribeChatResponse,
  type ChatResponseDelta,
  type ChatSubscriptionHandlers,
  type FetchOperatorContextChatResponseResult,
  type OperatorContextChatMessage,
  type StageOperatorContextChatResponse,
} from '@/lib/api/operator-context-chat'
import type { OperatorContextPacket } from '@/lib/operator-context'

/**
 * Chat-widget UI machine — sitelayer side of the operator-context handshake.
 *
 * v0 scope: the widget opens/closes, shows the latest operator-context
 * packet, and lets the operator persist a staged message through
 * POST /api/ai/chat. The endpoint logs the message for auditability; a
 * later LLM-response worker can consume that audit event.
 *
 * Sitelayer CLAUDE.md (xstate-discipline rule): non-trivial UI state
 * must be a real statechart, not raw useState lifecycles. Even the
 * "open vs closed" lifecycle here is modelled this way so the planned
 * sending/streaming/error transitions slot in cleanly.
 */

export type ChatWidgetMessage = OperatorContextChatMessage & {
  status?: 'pending' | 'staged' | 'responded' | 'failed'
  audit_event_id?: string
  response_body?: string
  response_audit_event_id?: string
}

/** Polled-response payload assembled when awaitingResponse resolves. */
export type ChatWidgetResponse = {
  audit_event_id: string
  response_audit_event_id: string
  body: string
  created_at: string
}

type ChatWidgetContext = {
  packet: OperatorContextPacket | null
  /** True when the widget never saw a packet (non-operator visitor or
   * content-script failure). Affects what we render in the empty state. */
  packetMissing: boolean
  draft: string
  messages: ChatWidgetMessage[]
  pendingMessageId: string | null
  /** The audit_event_id we're awaiting the CLI runner's response for.
   * Set when sending succeeds; cleared when awaitingResponse resolves
   * or aborts. */
  awaitingResponseFor: string | null
  /** Date.now() captured the moment the widget enters awaitingResponse.
   * Lets the renderer surface "responding for Xs" so the operator can
   * tell at a glance whether the subscription-CLI lane is healthy
   * (typical 5–15s) or stalling (>30s). Cleared on every exit. */
  awaitingResponseSince: number | null
  lastStage: StageOperatorContextChatResponse | null
  error: string | null
}

type ChatWidgetEvent =
  | { type: 'OPEN' }
  | { type: 'CLOSE' }
  | { type: 'TOGGLE' }
  | { type: 'CONTEXT_UPDATED'; packet: OperatorContextPacket | null }
  | { type: 'SET_DRAFT'; value: string }
  | { type: 'SEND' }
  | { type: 'RETRY'; auditEventId: string }
  | { type: 'DISMISS_ERROR' }
  // Internal events fanned out by the subscription actor. Not part of the
  // public hook surface but typed so the machine's transition table is
  // exhaustive.
  | { type: 'STREAM_DELTA'; delta: ChatResponseDelta }
  | { type: 'STREAM_ERROR'; message: string }
  | { type: 'STREAM_TIMEOUT' }

const initialContext: ChatWidgetContext = {
  packet: null,
  packetMissing: true,
  draft: '',
  messages: [],
  pendingMessageId: null,
  awaitingResponseFor: null,
  awaitingResponseSince: null,
  lastStage: null,
  error: null,
}

type PollInput = { auditEventId: string }

/**
 * Polls /api/ai/chat/:audit_event_id/response until the subscription-
 * CLI runner has written the respond_message audit row (status flips
 * to 'responded'), or until we give up after maxAttempts.
 *
 * Default: 20 attempts × 3s = 60s max wait. The subscription-CLI lane
 * typically completes a short chat response in 5–15s; 60s is the right
 * upper bound before the widget shows a "still working…" UX.
 *
 * KEPT as the polling fallback for the streaming subscriber. The widget
 * now defaults to `subscribeChatResponse` (SSE) for low-latency delta
 * push; if the stream errors (older API build, proxy stripping
 * `text/event-stream`), `pollSubscriber()` below adapts this function
 * to the same callback-shaped contract the machine expects.
 *
 * Exported for testing — the machine factory accepts an override so
 * tests can pin a faster poller.
 */
export function pollChatResponse(
  auditEventId: string,
  opts: { fetchOnce?: typeof fetchOperatorContextChatResponse; intervalMs?: number; maxAttempts?: number } = {},
): Promise<ChatWidgetResponse> {
  const fetchOnce = opts.fetchOnce ?? fetchOperatorContextChatResponse
  const intervalMs = opts.intervalMs ?? 3000
  const maxAttempts = opts.maxAttempts ?? 20
  return new Promise((resolve, reject) => {
    let attempts = 0
    const tick = async () => {
      attempts += 1
      let result: FetchOperatorContextChatResponseResult
      try {
        result = await fetchOnce(auditEventId)
      } catch (err) {
        reject(err instanceof Error ? err : new Error('chat response fetch failed'))
        return
      }
      if (result.status === 'responded') {
        resolve({
          audit_event_id: result.audit_event_id,
          response_audit_event_id: result.response_audit_event_id,
          body: result.body ?? '',
          created_at: result.created_at,
        })
        return
      }
      if (attempts >= maxAttempts) {
        reject(new Error('chat response timeout — subscription-CLI runner did not respond in time'))
        return
      }
      setTimeout(() => {
        void tick()
      }, intervalMs)
    }
    void tick()
  })
}

/**
 * Subscriber contract the chat-widget machine consumes during the
 * `awaitingResponse` state. The streaming SSE path implements this
 * natively; the polling fallback wraps `pollChatResponse` so the same
 * machine actor handles both transports without branching on flags.
 *
 * Implementations MUST call exactly one of `onDelta(status: 'responded')`
 * or `onError` per subscription, then stop emitting. Callers invoke the
 * returned `unsubscribe` to dispose early (machine state exit, retry).
 */
export type ChatResponseSubscriber = (auditEventId: string, handlers: ChatSubscriptionHandlers) => () => void

/**
 * Default subscriber = SSE stream. Re-exported under the more
 * domain-meaningful name so the chat-widget machine factory's signature
 * reads naturally (`createChatWidgetMachine(submitter, subscriber)`).
 */
export const defaultChatResponseSubscriber: ChatResponseSubscriber = subscribeChatResponse

/**
 * Polling-fallback adapter. Wraps `pollChatResponse` so it presents the
 * same callback shape as the streaming subscriber. Exposed so the
 * widget host can opt in to the polling lane via a runtime flag
 * (`VITE_CHAT_WIDGET_TRANSPORT=poll`) without having to touch the
 * machine's invoke wiring.
 */
export function makePollingSubscriber(
  opts: { intervalMs?: number; maxAttempts?: number } = {},
): ChatResponseSubscriber {
  return (auditEventId, handlers) => {
    let cancelled = false
    void pollChatResponse(auditEventId, opts).then(
      (resp) => {
        if (cancelled) return
        handlers.onDelta({
          audit_event_id: resp.audit_event_id,
          status: 'responded',
          response_audit_event_id: resp.response_audit_event_id,
          body: resp.body,
          created_at: resp.created_at,
        })
      },
      (err) => {
        if (cancelled) return
        handlers.onError(err instanceof Error ? err : new Error('chat response poll failed'))
      },
    )
    return () => {
      cancelled = true
    }
  }
}

type StageInput = {
  messages: OperatorContextChatMessage[]
  operatorContext: OperatorContextPacket
}

function stageableMessages(messages: ChatWidgetMessage[]): OperatorContextChatMessage[] {
  return messages.slice(-8).map((m) => {
    const message: OperatorContextChatMessage = {
      id: m.id,
      role: m.role,
      body: m.body,
    }
    if (m.packet_generated_at) {
      message.packet_generated_at = m.packet_generated_at
    }
    return message
  })
}

function isOpenState(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'open' in value
}

function isSendingState(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'open' in value && (value as { open?: unknown }).open === 'sending'
  )
}

function isAwaitingResponseState(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'open' in value &&
    (value as { open?: unknown }).open === 'awaitingResponse'
  )
}

/**
 * Optional knobs for the chat-widget machine factory. Most callers only
 * override the staging actor + subscriber; the safety timeout is
 * exposed so tests can fire it deterministically without waiting 60s of
 * wall-clock.
 */
export type CreateChatWidgetMachineOptions = {
  submitter?: (input: StageInput) => Promise<StageOperatorContextChatResponse>
  subscriber?: ChatResponseSubscriber
  /**
   * Client-side safety timeout for the awaitingResponse state. The
   * server's SSE handler also enforces 60s — both sides give up at the
   * same wall-clock so the operator sees a deterministic "responding
   * for Ns" ceiling. Tests pass a small value to assert the timeout
   * path without sleeping.
   */
  awaitingTimeoutMs?: number
}

export function createChatWidgetMachine(
  submitterOrOptions:
    | CreateChatWidgetMachineOptions
    | ((input: StageInput) => Promise<StageOperatorContextChatResponse>) = {},
  legacySubscriber?: ChatResponseSubscriber,
) {
  // Back-compat: older callers pass (submitter, poller-or-subscriber)
  // positionally. The first overload is the new options-object shape;
  // the second mirrors the historical 2-arg form so existing tests
  // continue to compile after the polling→streaming swap.
  const options: CreateChatWidgetMachineOptions =
    typeof submitterOrOptions === 'function'
      ? { submitter: submitterOrOptions, ...(legacySubscriber ? { subscriber: legacySubscriber } : {}) }
      : submitterOrOptions
  const submitter = options.submitter ?? stageOperatorContextChatMessage
  const subscriber = options.subscriber ?? defaultChatResponseSubscriber
  const awaitingTimeoutMs = options.awaitingTimeoutMs ?? 60_000
  return setup({
    types: {
      context: {} as ChatWidgetContext,
      events: {} as ChatWidgetEvent,
    },
    actors: {
      stageMessage: fromPromise<StageOperatorContextChatResponse, StageInput>(({ input }) => submitter(input)),
      /**
       * Subscription actor — wraps the SSE (or polling fallback)
       * transport. The actor lives for the duration of the
       * `awaitingResponse` state: opens the subscription on entry,
       * fans `onDelta`/`onError` out as STREAM_* events, and disposes
       * its handle when xstate stops it.
       *
       * This replaces the prior `pollResponse` Promise-based actor.
       * The shift from fromPromise→fromCallback is required because
       * the subscription pushes potentially multiple events per
       * connection (subscribe-confirm, intermediate partials, terminal
       * 'responded'), and only `fromCallback` lets us forward each
       * event to the machine.
       */
      subscribeResponse: fromCallback<ChatWidgetEvent, PollInput>(({ input, sendBack }) => {
        const handlers: ChatSubscriptionHandlers = {
          onDelta: (delta) => sendBack({ type: 'STREAM_DELTA', delta }),
          onError: (err) => sendBack({ type: 'STREAM_ERROR', message: err.message }),
        }
        const unsubscribe = subscriber(input.auditEventId, handlers)
        const timer = setTimeout(() => {
          sendBack({ type: 'STREAM_TIMEOUT' })
        }, awaitingTimeoutMs)
        return () => {
          clearTimeout(timer)
          try {
            unsubscribe()
          } catch {
            /* defensive cleanup; unsubscribe contract is best-effort */
          }
        }
      }),
    },
    actions: {
      syncPacket: assign({
        packet: ({ event }) => (event.type === 'CONTEXT_UPDATED' ? event.packet : null),
        packetMissing: ({ event }) => (event.type === 'CONTEXT_UPDATED' ? !event.packet : true),
      }),
      setDraft: assign({
        draft: ({ event }) => (event.type === 'SET_DRAFT' ? event.value : ''),
        error: () => null,
      }),
      prepareDraftForSend: assign(({ context }) => {
        const trimmed = context.draft.trim()
        if (!trimmed) return {}
        const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const message: ChatWidgetMessage = {
          id,
          role: 'operator',
          body: trimmed,
          status: 'pending',
        }
        if (context.packet?.generated_at) {
          message.packet_generated_at = context.packet.generated_at
        }
        return {
          messages: [...context.messages, message],
          pendingMessageId: id,
          draft: '',
          error: null,
          lastStage: null,
        }
      }),
      armRetryPolling: assign({
        // Re-arm the polling actor for an existing staged audit_event_id.
        // The staged message itself stays as-is (status='staged') — only
        // the awaitingResponseFor pointer flips back so the
        // awaitingResponse state's invoke fires fresh against the same
        // audit_event_id. Used when the polling timed out but the
        // operator wants another attempt (the underlying mesh task may
        // have completed since, or a re-dispatch happened out-of-band).
        awaitingResponseFor: ({ event }) => (event.type === 'RETRY' ? event.auditEventId : null),
        // Re-arm the elapsed counter from zero on each retry. Old
        // timestamp from the timed-out attempt would otherwise show
        // a misleading "responding for 90s+" right after the operator
        // hit the retry button.
        awaitingResponseSince: ({ event }) => (event.type === 'RETRY' ? Date.now() : null),
        error: () => null,
      }),
      missingPacketError: assign({
        error: () => 'Operator context is not available yet.',
      }),
      dismissError: assign({ error: () => null }),
    },
    guards: {
      hasDraft: ({ context }) => context.draft.trim().length > 0,
    },
  }).createMachine({
    id: 'chatWidget',
    initial: 'closed',
    context: initialContext,
    // Context updates and SET_DRAFT can land in any state.
    on: {
      CONTEXT_UPDATED: { actions: 'syncPacket' },
      SET_DRAFT: { actions: 'setDraft' },
      DISMISS_ERROR: { actions: 'dismissError' },
    },
    states: {
      closed: {
        on: {
          OPEN: { target: 'open' },
          TOGGLE: { target: 'open' },
        },
      },
      open: {
        initial: 'idle',
        on: {
          CLOSE: { target: 'closed' },
          TOGGLE: { target: 'closed' },
        },
        states: {
          idle: {
            on: {
              SEND: [
                {
                  guard: ({ context }) => context.draft.trim().length > 0 && context.packet !== null,
                  target: 'sending',
                  actions: 'prepareDraftForSend',
                },
                {
                  guard: 'hasDraft',
                  actions: 'missingPacketError',
                },
              ],
              RETRY: {
                // Re-poll for a staged message whose response timed out.
                // Pointer goes to the awaitingResponseFor field; the
                // awaitingResponse state's invoke picks it up. No new
                // mesh task is created — we're betting the operator's
                // re-dispatched it manually OR the original runner just
                // finished slowly.
                target: 'awaitingResponse',
                actions: 'armRetryPolling',
              },
            },
          },
          sending: {
            invoke: {
              id: 'stageMessage',
              src: 'stageMessage',
              input: ({ context }) => {
                if (!context.packet) {
                  throw new Error('missing operator context')
                }
                return {
                  operatorContext: context.packet,
                  messages: stageableMessages(context.messages),
                }
              },
              onDone: {
                target: 'awaitingResponse',
                actions: assign({
                  messages: ({ context, event }) =>
                    context.messages.map((m) =>
                      m.id === context.pendingMessageId
                        ? { ...m, status: 'staged', audit_event_id: event.output.audit_event_id }
                        : m,
                    ),
                  pendingMessageId: () => null,
                  awaitingResponseFor: ({ event }) => event.output.audit_event_id,
                  awaitingResponseSince: () => Date.now(),
                  lastStage: ({ event }) => event.output,
                  error: () => null,
                }),
              },
              onError: {
                target: 'idle',
                actions: assign({
                  messages: ({ context }) =>
                    context.messages.map((m) => (m.id === context.pendingMessageId ? { ...m, status: 'failed' } : m)),
                  pendingMessageId: () => null,
                  awaitingResponseFor: () => null,
                  awaitingResponseSince: () => null,
                  error: ({ event }) =>
                    event.error instanceof Error ? event.error.message : 'Could not stage chat message.',
                }),
              },
            },
          },
          awaitingResponse: {
            // Subscription actor (SSE by default, polling fallback when
            // injected). The actor sends STREAM_* events back into the
            // machine; the state transitions on the terminal ones below.
            // Compared to the prior pollResponse Promise actor, this lets
            // the server push the delta as soon as the response audit
            // row lands instead of waiting up to 3s for the next poll.
            invoke: {
              id: 'subscribeResponse',
              src: 'subscribeResponse',
              input: ({ context }) => ({
                auditEventId: context.awaitingResponseFor ?? '',
              }),
              // Source-of-truth disposal happens through xstate's normal
              // actor lifecycle: the subscription actor returns a
              // cleanup function from its setup callback, which xstate
              // invokes on every state exit. No onError needed because
              // errors arrive through the STREAM_ERROR event below.
            },
            on: {
              STREAM_DELTA: [
                {
                  // Terminal delta — `status: 'responded'` means the
                  // response audit row landed. Flip the staged message
                  // to 'responded', append the agent reply, clear the
                  // awaiting pointer, and return to idle. Intermediate
                  // `status: 'partial'` deltas (streaming-token mode,
                  // not yet emitted by the server) would land in the
                  // second branch below once the wire shape is
                  // extended.
                  guard: ({ event }) => event.type === 'STREAM_DELTA' && event.delta.status === 'responded',
                  target: 'idle',
                  actions: assign({
                    messages: ({ context, event }) => {
                      if (event.type !== 'STREAM_DELTA') return context.messages
                      const delta = event.delta
                      const body = typeof delta.body === 'string' ? delta.body : ''
                      const respId = delta.response_audit_event_id ?? `r-${Date.now()}`
                      const responseMsg: ChatWidgetMessage = {
                        id: `r-${respId}`,
                        role: 'agent',
                        body,
                        audit_event_id: respId,
                      }
                      return [
                        ...context.messages.map((m) =>
                          m.audit_event_id === delta.audit_event_id
                            ? {
                                ...m,
                                status: 'responded' as const,
                                response_body: body,
                                response_audit_event_id: respId,
                              }
                            : m,
                        ),
                        responseMsg,
                      ]
                    },
                    awaitingResponseFor: () => null,
                    awaitingResponseSince: () => null,
                    error: () => null,
                  }),
                },
                {
                  // Non-terminal delta (partial / progress). Currently
                  // unused — the SSE server only emits 'responded' as
                  // of this CL — but the branch exists so a future
                  // server-side streaming-token rollout doesn't require
                  // re-architecting the machine. Append-as-we-go would
                  // mutate the staged message body_delta.
                  guard: ({ event }) => event.type === 'STREAM_DELTA' && event.delta.status === 'partial',
                  actions: assign({
                    messages: ({ context, event }) => {
                      if (event.type !== 'STREAM_DELTA') return context.messages
                      const delta = event.delta
                      const incremental = typeof delta.body_delta === 'string' ? delta.body_delta : ''
                      if (!incremental) return context.messages
                      return context.messages.map((m) =>
                        m.audit_event_id === delta.audit_event_id
                          ? { ...m, response_body: (m.response_body ?? '') + incremental }
                          : m,
                      )
                    },
                  }),
                },
              ],
              STREAM_ERROR: {
                target: 'idle',
                actions: assign({
                  awaitingResponseFor: () => null,
                  awaitingResponseSince: () => null,
                  error: ({ event }) =>
                    event.type === 'STREAM_ERROR' && event.message
                      ? event.message
                      : 'Chat response did not arrive in time.',
                }),
              },
              STREAM_TIMEOUT: {
                target: 'idle',
                actions: assign({
                  awaitingResponseFor: () => null,
                  awaitingResponseSince: () => null,
                  error: () => 'chat response timeout — subscription-CLI runner did not respond in time',
                }),
              },
            },
          },
        },
      },
    },
  })
}

export const chatWidgetMachine = createChatWidgetMachine()

export type ChatWidgetHookResult = {
  isOpen: boolean
  packet: OperatorContextPacket | null
  packetMissing: boolean
  draft: string
  messages: ChatWidgetMessage[]
  error: string | null
  isSending: boolean
  /** True while the machine is subscribed to /api/ai/chat/:id/stream for
   * the subscription-CLI runner's reply (SSE by default; polling
   * fallback wraps the legacy /response endpoint with the same shape).
   * UIs render a "responding…" indicator on the staged message during
   * this state. */
  isAwaitingResponse: boolean
  /** Audit_event_id we're subscribed for, or null when idle. UIs can
   * mark the corresponding staged message with a thinking indicator. */
  awaitingResponseFor: string | null
  /** Date.now() value captured the moment the subscription opened for
   * the current audit_event_id, or null when idle. UIs can subtract
   * from Date.now() to render "responding for Xs" so the operator can
   * see whether the subscription-CLI lane is healthy (5–15s typical)
   * or stalling. */
  awaitingResponseSince: number | null
  open: () => void
  close: () => void
  toggle: () => void
  setDraft: (value: string) => void
  send: () => void
  /** Re-arm the subscription actor for an existing staged
   * audit_event_id. Used when a previous attempt timed out but the
   * operator wants another try. The chat-widget machine does not
   * re-dispatch the mesh task; the operator can re-dispatch via
   * mcp__mesh__create_task if needed. */
  retry: (auditEventId: string) => void
  syncContext: (packet: OperatorContextPacket | null) => void
}

export function useChatWidget(): ChatWidgetHookResult {
  const [state, send] = useMachine(chatWidgetMachine)
  const open = useCallback(() => send({ type: 'OPEN' }), [send])
  const close = useCallback(() => send({ type: 'CLOSE' }), [send])
  const toggle = useCallback(() => send({ type: 'TOGGLE' }), [send])
  const setDraft = useCallback((value: string) => send({ type: 'SET_DRAFT', value }), [send])
  const submit = useCallback(() => send({ type: 'SEND' }), [send])
  const retry = useCallback((auditEventId: string) => send({ type: 'RETRY', auditEventId }), [send])
  const syncContext = useCallback(
    (packet: OperatorContextPacket | null) => send({ type: 'CONTEXT_UPDATED', packet }),
    [send],
  )
  return {
    isOpen: isOpenState(state.value),
    packet: state.context.packet,
    packetMissing: state.context.packetMissing,
    draft: state.context.draft,
    messages: state.context.messages,
    error: state.context.error,
    isSending: isSendingState(state.value),
    isAwaitingResponse: isAwaitingResponseState(state.value),
    awaitingResponseFor: state.context.awaitingResponseFor,
    awaitingResponseSince: state.context.awaitingResponseSince,
    open,
    close,
    toggle,
    setDraft,
    send: submit,
    retry,
    syncContext,
  }
}
