import { useCallback } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import {
  fetchOperatorContextChatResponse,
  stageOperatorContextChatMessage,
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

const initialContext: ChatWidgetContext = {
  packet: null,
  packetMissing: true,
  draft: '',
  messages: [],
  pendingMessageId: null,
  awaitingResponseFor: null,
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

export function createChatWidgetMachine(
  submitter: (input: StageInput) => Promise<StageOperatorContextChatResponse> = stageOperatorContextChatMessage,
  poller: (auditEventId: string) => Promise<ChatWidgetResponse> = pollChatResponse,
) {
  return setup({
    types: {
      context: {} as ChatWidgetContext,
      events: {} as ChatWidgetEvent,
    },
    actors: {
      stageMessage: fromPromise<StageOperatorContextChatResponse, StageInput>(({ input }) => submitter(input)),
      pollResponse: fromPromise<ChatWidgetResponse, PollInput>(({ input }) => poller(input.auditEventId)),
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
        awaitingResponseFor: ({ event }) =>
          event.type === 'RETRY' ? event.auditEventId : null,
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
                  error: ({ event }) =>
                    event.error instanceof Error ? event.error.message : 'Could not stage chat message.',
                }),
              },
            },
          },
          awaitingResponse: {
            invoke: {
              id: 'pollResponse',
              src: 'pollResponse',
              input: ({ context }) => ({
                auditEventId: context.awaitingResponseFor ?? '',
              }),
              onDone: {
                target: 'idle',
                actions: assign({
                  // Attach response to the matching staged message (by
                  // audit_event_id), append a separate agent-role
                  // message so the chat history reads as a turn.
                  messages: ({ context, event }) => {
                    const responseMsg: ChatWidgetMessage = {
                      id: `r-${event.output.response_audit_event_id}`,
                      role: 'agent',
                      body: event.output.body,
                      audit_event_id: event.output.response_audit_event_id,
                    }
                    return [
                      ...context.messages.map((m) =>
                        m.audit_event_id === event.output.audit_event_id
                          ? {
                              ...m,
                              status: 'responded' as const,
                              response_body: event.output.body,
                              response_audit_event_id: event.output.response_audit_event_id,
                            }
                          : m,
                      ),
                      responseMsg,
                    ]
                  },
                  awaitingResponseFor: () => null,
                  error: () => null,
                }),
              },
              onError: {
                target: 'idle',
                actions: assign({
                  awaitingResponseFor: () => null,
                  error: ({ event }) =>
                    event.error instanceof Error
                      ? event.error.message
                      : 'Chat response did not arrive in time.',
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
  /** True while the machine is polling /api/ai/chat/:id/response for the
   * subscription-CLI runner's reply. UIs render a "responding…" indicator
   * on the staged message during this state. */
  isAwaitingResponse: boolean
  /** Audit_event_id we're polling for, or null when idle. UIs can mark
   * the corresponding staged message with a thinking indicator. */
  awaitingResponseFor: string | null
  open: () => void
  close: () => void
  toggle: () => void
  setDraft: (value: string) => void
  send: () => void
  /** Re-arm the polling actor for an existing staged audit_event_id.
   * Used when a previous poll timed out but the operator wants another
   * attempt. The chat-widget machine does not re-dispatch the mesh task;
   * the operator can re-dispatch via mcp__mesh__create_task if needed. */
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
  const retry = useCallback(
    (auditEventId: string) => send({ type: 'RETRY', auditEventId }),
    [send],
  )
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
    open,
    close,
    toggle,
    setDraft,
    send: submit,
    retry,
    syncContext,
  }
}
