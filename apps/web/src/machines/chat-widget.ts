import { useCallback } from 'react'
import { useMachine } from '@xstate/react'
import { assign, setup } from 'xstate'
import type { OperatorContextPacket } from '@/lib/operator-context'

/**
 * Chat-widget UI machine — sitelayer side of the operator-context handshake.
 *
 * v0 scope: the widget opens/closes, shows the latest operator-context
 * packet, and lets the operator stage a draft message. We DO NOT yet
 * wire send→backend; that lands once /api/ai/chat exists on sitelayer.
 * The state shape is forward-looking so we can extend without rewiring.
 *
 * Sitelayer CLAUDE.md (xstate-discipline rule): non-trivial UI state
 * must be a real statechart, not raw useState lifecycles. Even the
 * "open vs closed" lifecycle here is modelled this way so the planned
 * sending/streaming/error transitions slot in cleanly.
 */

export type ChatWidgetMessage = {
  id: string
  role: 'operator' | 'agent'
  body: string
  /** Optional reference back to the operator-context packet the
   * operator saw when sending this message. Helps audit grounding. */
  packet_generated_at?: string
}

type ChatWidgetContext = {
  packet: OperatorContextPacket | null
  /** True when the widget never saw a packet (non-operator visitor or
   * content-script failure). Affects what we render in the empty state. */
  packetMissing: boolean
  draft: string
  messages: ChatWidgetMessage[]
  error: string | null
}

type ChatWidgetEvent =
  | { type: 'OPEN' }
  | { type: 'CLOSE' }
  | { type: 'TOGGLE' }
  | { type: 'CONTEXT_UPDATED'; packet: OperatorContextPacket | null }
  | { type: 'SET_DRAFT'; value: string }
  | { type: 'SEND' }
  | { type: 'DISMISS_ERROR' }

const initialContext: ChatWidgetContext = {
  packet: null,
  packetMissing: true,
  draft: '',
  messages: [],
  error: null,
}

export const chatWidgetMachine = setup({
  types: {
    context: {} as ChatWidgetContext,
    events: {} as ChatWidgetEvent,
  },
  actions: {
    syncPacket: assign({
      packet: ({ event }) => (event.type === 'CONTEXT_UPDATED' ? event.packet : null),
      packetMissing: ({ event }) => (event.type === 'CONTEXT_UPDATED' ? !event.packet : true),
    }),
    setDraft: assign({
      draft: ({ event }) => (event.type === 'SET_DRAFT' ? event.value : ''),
    }),
    enqueueDraft: assign({
      messages: ({ context }) => {
        const trimmed = context.draft.trim()
        if (!trimmed) return context.messages
        const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const message: ChatWidgetMessage = {
          id,
          role: 'operator',
          body: trimmed,
        }
        if (context.packet?.generated_at) {
          message.packet_generated_at = context.packet.generated_at
        }
        return [...context.messages, message]
      },
      draft: () => '',
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
            SEND: {
              guard: 'hasDraft',
              actions: 'enqueueDraft',
              // v0 stub: enqueue locally; do NOT transition to a
              // 'sending' state because /api/ai/chat isn't wired yet.
              // When it lands, change this to `target: 'sending'`
              // and let an actor POST + stream.
              target: 'idle',
              reenter: true,
            },
          },
        },
      },
    },
  },
})

export type ChatWidgetHookResult = {
  isOpen: boolean
  packet: OperatorContextPacket | null
  packetMissing: boolean
  draft: string
  messages: ChatWidgetMessage[]
  error: string | null
  open: () => void
  close: () => void
  toggle: () => void
  setDraft: (value: string) => void
  send: () => void
  syncContext: (packet: OperatorContextPacket | null) => void
}

export function useChatWidget(): ChatWidgetHookResult {
  const [state, send] = useMachine(chatWidgetMachine)
  const open = useCallback(() => send({ type: 'OPEN' }), [send])
  const close = useCallback(() => send({ type: 'CLOSE' }), [send])
  const toggle = useCallback(() => send({ type: 'TOGGLE' }), [send])
  const setDraft = useCallback((value: string) => send({ type: 'SET_DRAFT', value }), [send])
  const submit = useCallback(() => send({ type: 'SEND' }), [send])
  const syncContext = useCallback(
    (packet: OperatorContextPacket | null) => send({ type: 'CONTEXT_UPDATED', packet }),
    [send],
  )
  return {
    isOpen: state.matches('open'),
    packet: state.context.packet,
    packetMissing: state.context.packetMissing,
    draft: state.context.draft,
    messages: state.context.messages,
    error: state.context.error,
    open,
    close,
    toggle,
    setDraft,
    send: submit,
    syncContext,
  }
}
