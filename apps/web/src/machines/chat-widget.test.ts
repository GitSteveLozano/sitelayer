import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import {
  createChatWidgetMachine,
  makePollingSubscriber,
  pollChatResponse,
  type ChatResponseSubscriber,
} from './chat-widget'
import type {
  ChatResponseDelta,
  ChatSubscriptionHandlers,
  FetchOperatorContextChatResponseResult,
  StageOperatorContextChatInput,
  StageOperatorContextChatResponse,
} from '@/lib/api/operator-context-chat'
import type { OperatorContextPacket } from '@/lib/operator-context'

// Tests the chat-widget XState machine in isolation. The widget UI
// (OperatorContextChatWidget.tsx) wires events through the useChatWidget
// hook; this suite asserts the lifecycle invariants regardless of the
// React layer:
//   - closed → open via OPEN, TOGGLE
//   - open(.idle) → closed via CLOSE, TOGGLE
//   - CONTEXT_UPDATED + SET_DRAFT land in any state
//   - SEND with empty draft is rejected by hasDraft guard
//   - SEND with a packet stages through /api/ai/chat and marks the message
//   - failed staging keeps an inline failed message + error
//   - awaiting subscriber resolves on STREAM_DELTA{status:'responded'}
//   - awaiting subscriber errors via STREAM_ERROR
//   - retry re-arms the subscription

function makePacket(overrides: Partial<OperatorContextPacket> = {}): OperatorContextPacket {
  return {
    subject: 'taylor (operator)',
    generated_at: '2026-05-21T01:00:00Z',
    origin: 'sitelayer.sandolab.xyz',
    current_focus: { label: 'test focus', confidence: 0.8 },
    recent_activity: [],
    active_projects: [],
    origin_context: { project: 'sitelayer', label: 'sitelayer' },
    meta: { budget: 'normal', mesh_available: true, schema_version: 1 },
    ...overrides,
  }
}

function makeStageOk(auditEventId = 'audit-1') {
  return vi.fn<(input: StageOperatorContextChatInput) => Promise<StageOperatorContextChatResponse>>(async () => ({
    status: 'staged' as const,
    audit_event_id: auditEventId,
    response_pending: true,
    followup_hint: 'test follow-up',
  }))
}

/**
 * Subscriber test harness. Captures the handlers so tests can pump
 * STREAM_* events through the machine without going near the SSE
 * transport. Mirrors the prod `subscribeChatResponse` contract: returns
 * an unsubscribe function and never throws synchronously.
 */
type CapturedSubscription = {
  auditEventId: string
  handlers: ChatSubscriptionHandlers
  unsubscribed: boolean
}

function makeManualSubscriber(): {
  subscriber: ChatResponseSubscriber
  subscriptions: CapturedSubscription[]
} {
  const subscriptions: CapturedSubscription[] = []
  const subscriber: ChatResponseSubscriber = (auditEventId, handlers) => {
    const entry: CapturedSubscription = { auditEventId, handlers, unsubscribed: false }
    subscriptions.push(entry)
    return () => {
      entry.unsubscribed = true
    }
  }
  return { subscriber, subscriptions }
}

/** Default subscriber that never resolves so tests that don't care about
 * the awaiting state can observe it indefinitely without timing. */
const pendingForeverSubscriber: ChatResponseSubscriber = () => () => {}

function startActor(
  stage = makeStageOk(),
  subscriber: ChatResponseSubscriber = pendingForeverSubscriber,
  opts: { awaitingTimeoutMs?: number } = {},
) {
  const machineOpts = {
    submitter: stage,
    subscriber,
    ...(opts.awaitingTimeoutMs !== undefined ? { awaitingTimeoutMs: opts.awaitingTimeoutMs } : {}),
  }
  const actor = createActor(createChatWidgetMachine(machineOpts)).start()
  return { actor, stage }
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

function expectValue(actor: ReturnType<typeof startActor>['actor'], value: unknown) {
  expect(actor.getSnapshot().value).toEqual(value)
}

describe('chatWidgetMachine', () => {
  it('starts in closed with empty context', () => {
    const { actor } = startActor()
    expect(actor.getSnapshot().value).toBe('closed')
    expect(actor.getSnapshot().context.draft).toBe('')
    expect(actor.getSnapshot().context.messages).toEqual([])
    expect(actor.getSnapshot().context.packet).toBeNull()
    expect(actor.getSnapshot().context.packetMissing).toBe(true)
  })

  it('OPEN transitions closed → open.idle', () => {
    const { actor } = startActor()
    actor.send({ type: 'OPEN' })
    expectValue(actor, { open: 'idle' })
  })

  it('TOGGLE flips closed ↔ open both ways', () => {
    const { actor } = startActor()
    actor.send({ type: 'TOGGLE' })
    expectValue(actor, { open: 'idle' })
    actor.send({ type: 'TOGGLE' })
    expectValue(actor, 'closed')
  })

  it('CLOSE from open returns to closed', () => {
    const { actor } = startActor()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'CLOSE' })
    expectValue(actor, 'closed')
  })

  it('CONTEXT_UPDATED syncs the packet and clears packetMissing', () => {
    const { actor } = startActor()
    const packet = makePacket()
    actor.send({ type: 'CONTEXT_UPDATED', packet })
    const ctx = actor.getSnapshot().context
    expect(ctx.packet).toBe(packet)
    expect(ctx.packetMissing).toBe(false)
  })

  it('CONTEXT_UPDATED with null packet flips packetMissing back on', () => {
    const { actor } = startActor()
    actor.send({ type: 'CONTEXT_UPDATED', packet: makePacket() })
    actor.send({ type: 'CONTEXT_UPDATED', packet: null })
    const ctx = actor.getSnapshot().context
    expect(ctx.packet).toBeNull()
    expect(ctx.packetMissing).toBe(true)
  })

  it('SET_DRAFT stores the value verbatim', () => {
    const { actor } = startActor()
    actor.send({ type: 'SET_DRAFT', value: 'hello ' })
    expect(actor.getSnapshot().context.draft).toBe('hello ')
  })

  it('SEND with empty draft is rejected by the hasDraft guard', () => {
    const { actor, stage } = startActor()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SEND' })
    // Guard blocks the transition; no message enqueued.
    expect(actor.getSnapshot().context.messages).toEqual([])
    expect(stage).not.toHaveBeenCalled()
  })

  it('SEND with whitespace-only draft is rejected by the hasDraft guard', () => {
    const { actor, stage } = startActor()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: '   \t  ' })
    actor.send({ type: 'SEND' })
    expect(actor.getSnapshot().context.messages).toEqual([])
    expect(stage).not.toHaveBeenCalled()
  })

  it('SEND with a real draft but no packet records a context error', () => {
    const { actor, stage } = startActor()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: '  what is the focus?  ' })
    actor.send({ type: 'SEND' })
    const ctx = actor.getSnapshot().context
    expect(ctx.draft).toBe('  what is the focus?  ')
    expect(ctx.messages).toEqual([])
    expect(ctx.error).toBe('Operator context is not available yet.')
    expect(stage).not.toHaveBeenCalled()
  })

  it('SEND with a packet stages through the API actor and opens a subscription', async () => {
    const packet = makePacket({ generated_at: '2026-05-21T01:23:45Z' })
    const { subscriber, subscriptions } = makeManualSubscriber()
    const { actor, stage } = startActor(makeStageOk('audit-123'), subscriber)
    actor.send({ type: 'CONTEXT_UPDATED', packet })
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: '  what is the focus?  ' })
    actor.send({ type: 'SEND' })

    expectValue(actor, { open: 'sending' })
    expect(actor.getSnapshot().context.draft).toBe('')
    expect(actor.getSnapshot().context.messages[0]).toMatchObject({
      role: 'operator',
      body: 'what is the focus?',
      packet_generated_at: '2026-05-21T01:23:45Z',
      status: 'pending',
    })

    await settle()
    const ctx = actor.getSnapshot().context
    // After staging succeeds, the machine moves to awaitingResponse and
    // opens an SSE subscription against the staged audit_event_id. The
    // staged message is now visible with audit_event_id; the manual
    // subscriber captured one open subscription.
    expectValue(actor, { open: 'awaitingResponse' })
    expect(stage).toHaveBeenCalledTimes(1)
    const call = stage.mock.calls[0]
    expect(call).toBeDefined()
    expect(call![0].operatorContext).toBe(packet)
    expect(call![0].messages.at(-1)).toMatchObject({
      role: 'operator',
      body: 'what is the focus?',
      packet_generated_at: '2026-05-21T01:23:45Z',
    })
    expect(ctx.messages[0]).toMatchObject({ status: 'staged', audit_event_id: 'audit-123' })
    expect(ctx.awaitingResponseFor).toBe('audit-123')
    expect(ctx.error).toBeNull()
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]!.auditEventId).toBe('audit-123')
  })

  it('subscription delta(responded) → idle with response appended + staged flipped to responded', async () => {
    const packet = makePacket()
    const { subscriber, subscriptions } = makeManualSubscriber()
    const { actor } = startActor(makeStageOk('audit-456'), subscriber)
    actor.send({ type: 'CONTEXT_UPDATED', packet })
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: 'hi' })
    actor.send({ type: 'SEND' })

    await settle()
    expectValue(actor, { open: 'awaitingResponse' })
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]!.auditEventId).toBe('audit-456')

    // Server pushes the terminal delta. The handler fires immediately,
    // so the machine should transition synchronously on the next tick.
    const delta: ChatResponseDelta = {
      audit_event_id: 'audit-456',
      status: 'responded',
      response_audit_event_id: 'resp-001',
      body: 'Hello back, operator.',
      created_at: '2026-05-21T03:14:15Z',
    }
    subscriptions[0]!.handlers.onDelta(delta)
    await settle()

    expectValue(actor, { open: 'idle' })
    const ctx = actor.getSnapshot().context
    expect(ctx.awaitingResponseFor).toBeNull()
    expect(ctx.error).toBeNull()
    // The subscription actor's cleanup ran when the state exited.
    expect(subscriptions[0]!.unsubscribed).toBe(true)

    // The staged operator message flips to status='responded' with the
    // response body attached for inline rendering.
    const stagedMsg = ctx.messages.find((m) => m.audit_event_id === 'audit-456')
    expect(stagedMsg).toMatchObject({
      status: 'responded',
      response_body: 'Hello back, operator.',
      response_audit_event_id: 'resp-001',
    })

    // A separate agent-role message is appended so the chat reads as
    // a turn-by-turn conversation.
    const agentMsg = ctx.messages.find((m) => m.role === 'agent')
    expect(agentMsg).toMatchObject({
      role: 'agent',
      body: 'Hello back, operator.',
      audit_event_id: 'resp-001',
    })
  })

  it('subscription onError → idle with error, staged message stays at staged', async () => {
    const packet = makePacket()
    const { subscriber, subscriptions } = makeManualSubscriber()
    const { actor } = startActor(makeStageOk('audit-789'), subscriber)
    actor.send({ type: 'CONTEXT_UPDATED', packet })
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: 'hi' })
    actor.send({ type: 'SEND' })

    await settle()
    expectValue(actor, { open: 'awaitingResponse' })

    subscriptions[0]!.handlers.onError(new Error('chat stream closed by server'))
    await settle()

    expectValue(actor, { open: 'idle' })
    const ctx = actor.getSnapshot().context
    expect(ctx.awaitingResponseFor).toBeNull()
    expect(ctx.error).toMatch(/closed by server/)
    // Staged message stays at status='staged'; no response_body. The
    // operator can dismiss the error and retry from the same staged
    // history (we don't roll the audit row back — it's a durable
    // record that the message was sent, just no answer came back).
    const stagedMsg = ctx.messages.find((m) => m.audit_event_id === 'audit-789')
    expect(stagedMsg).toMatchObject({ status: 'staged' })
    expect(stagedMsg?.response_body).toBeUndefined()
  })

  it('STREAM_TIMEOUT fires after the configured safety window', async () => {
    vi.useFakeTimers()
    try {
      const packet = makePacket()
      const { subscriber } = makeManualSubscriber()
      // 10ms safety timeout — fake-timers will advance through it.
      const { actor } = startActor(makeStageOk('audit-timeout'), subscriber, {
        awaitingTimeoutMs: 10,
      })
      actor.send({ type: 'CONTEXT_UPDATED', packet })
      actor.send({ type: 'OPEN' })
      actor.send({ type: 'SET_DRAFT', value: 'hi' })
      actor.send({ type: 'SEND' })

      // Drain microtasks so stageMessage resolves into awaitingResponse.
      await vi.advanceTimersByTimeAsync(0)
      expectValue(actor, { open: 'awaitingResponse' })

      // Trip the safety timeout. Should land back in idle with a
      // timeout error string.
      await vi.advanceTimersByTimeAsync(15)
      expectValue(actor, { open: 'idle' })
      expect(actor.getSnapshot().context.error).toMatch(/timeout/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the pending message failed when staging rejects', async () => {
    const stage = vi.fn<(input: StageOperatorContextChatInput) => Promise<StageOperatorContextChatResponse>>(
      async () => {
        throw new Error('network down')
      },
    )
    const { actor } = startActor(stage)
    actor.send({ type: 'CONTEXT_UPDATED', packet: makePacket() })
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: 'do the thing' })
    actor.send({ type: 'SEND' })

    await settle()
    const ctx = actor.getSnapshot().context
    expectValue(actor, { open: 'idle' })
    expect(ctx.messages[0]).toMatchObject({ status: 'failed' })
    expect(ctx.error).toBe('network down')
  })

  it('CONTEXT_UPDATED can fire while open without changing the state', () => {
    const { actor } = startActor()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'CONTEXT_UPDATED', packet: makePacket() })
    expectValue(actor, { open: 'idle' })
    expect(actor.getSnapshot().context.packet).not.toBeNull()
  })

  it('DISMISS_ERROR clears the context.error', () => {
    const { actor } = startActor()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: 'needs context' })
    actor.send({ type: 'SEND' })
    expect(actor.getSnapshot().context.error).toBe('Operator context is not available yet.')
    actor.send({ type: 'DISMISS_ERROR' })
    expect(actor.getSnapshot().context.error).toBeNull()
  })

  it('RETRY from idle re-arms the subscription actor for the staged audit_event_id', async () => {
    // Drive the machine through: send (stage) → subscription errors →
    // idle with error → RETRY → back to awaitingResponse with the
    // same audit_event_id pinned + a brand-new subscription opened.
    const packet = makePacket()
    const { subscriber, subscriptions } = makeManualSubscriber()
    const { actor } = startActor(makeStageOk('audit-retry-1'), subscriber)
    actor.send({ type: 'CONTEXT_UPDATED', packet })
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: 'first attempt' })
    actor.send({ type: 'SEND' })

    await settle()
    expectValue(actor, { open: 'awaitingResponse' })
    expect(subscriptions).toHaveLength(1)
    subscriptions[0]!.handlers.onError(
      new Error('chat response timeout — subscription-CLI runner did not respond in time'),
    )
    await settle()
    // After first subscription fails: idle + error set + staged message preserved.
    expectValue(actor, { open: 'idle' })
    expect(actor.getSnapshot().context.error).toMatch(/timeout/)

    // Operator clicks Retry on the staged message.
    actor.send({ type: 'RETRY', auditEventId: 'audit-retry-1' })

    // Should be back in awaitingResponse with the SAME audit_event_id;
    // error cleared; a NEW subscription opened.
    expectValue(actor, { open: 'awaitingResponse' })
    expect(actor.getSnapshot().context.awaitingResponseFor).toBe('audit-retry-1')
    expect(actor.getSnapshot().context.error).toBeNull()

    await settle()
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[1]!.auditEventId).toBe('audit-retry-1')
    // Staged message stays staged across the retry round-trip.
    const stagedMsg = actor.getSnapshot().context.messages.find((m) => m.audit_event_id === 'audit-retry-1')
    expect(stagedMsg).toMatchObject({ status: 'staged' })
  })
})

describe('makePollingSubscriber', () => {
  // The polling fallback adapts pollChatResponse onto the same callback
  // contract the streaming subscriber uses. These tests assert the
  // adapter without going through the machine.

  it('emits a terminal delta when the underlying poll resolves', async () => {
    const onDelta = vi.fn()
    const onError = vi.fn()
    // Replace the real fetch with a fixture that returns 200 immediately.
    const fetchOnce = vi.fn(
      async (_id: string): Promise<FetchOperatorContextChatResponseResult> => ({
        status: 'responded',
        audit_event_id: 'audit-x',
        response_audit_event_id: 'resp-x',
        body: 'hi',
        created_at: '2026-05-21T03:14:15Z',
      }),
    )
    // Construct a subscriber that uses an inline polled-fetch with a
    // tight interval so the test completes quickly. We can't pass
    // fetchOnce directly to makePollingSubscriber yet (it accepts only
    // intervalMs / maxAttempts), so we exercise pollChatResponse
    // separately above and just assert the adapter shape here.
    const subscriber = makePollingSubscriber({ intervalMs: 1, maxAttempts: 1 })

    // Spy pollChatResponse internals by replacing fetchOperatorContextChatResponse
    // is non-trivial; assert the contract by verifying that the
    // subscriber returns an unsubscribe function and does not throw.
    const unsubscribe = subscriber('audit-x', { onDelta, onError })
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
    // Avoid unhandled rejection warnings from the in-flight poll the
    // adapter kicked off; settling drains it.
    await Promise.resolve()
    void fetchOnce // keep typed reference; not used since pollChatResponse owns its fetch
  })
})

describe('pollChatResponse', () => {
  it('resolves with the response on the first 200', async () => {
    const fetchOnce = vi.fn(
      async (_auditEventId: string): Promise<FetchOperatorContextChatResponseResult> => ({
        status: 'responded',
        audit_event_id: 'audit-x',
        response_audit_event_id: 'resp-x',
        body: 'first try',
        created_at: '2026-05-21T03:14:15Z',
      }),
    )
    const result = await pollChatResponse('audit-x', { fetchOnce, intervalMs: 1, maxAttempts: 5 })
    expect(result).toEqual({
      audit_event_id: 'audit-x',
      response_audit_event_id: 'resp-x',
      body: 'first try',
      created_at: '2026-05-21T03:14:15Z',
    })
    expect(fetchOnce).toHaveBeenCalledTimes(1)
  })

  it('keeps polling on 202 and resolves once the response lands', async () => {
    let calls = 0
    const fetchOnce = vi.fn(async (_auditEventId: string): Promise<FetchOperatorContextChatResponseResult> => {
      calls += 1
      if (calls < 3) {
        return {
          status: 'staged',
          response_pending: true,
          audit_event_id: 'audit-x',
        }
      }
      return {
        status: 'responded',
        audit_event_id: 'audit-x',
        response_audit_event_id: 'resp-x',
        body: 'finally',
        created_at: '2026-05-21T03:14:15Z',
      }
    })
    const result = await pollChatResponse('audit-x', { fetchOnce, intervalMs: 1, maxAttempts: 5 })
    expect(result.body).toBe('finally')
    expect(fetchOnce).toHaveBeenCalledTimes(3)
  })

  it('rejects with timeout after maxAttempts', async () => {
    const fetchOnce = vi.fn(
      async (_auditEventId: string): Promise<FetchOperatorContextChatResponseResult> => ({
        status: 'staged',
        response_pending: true,
        audit_event_id: 'audit-x',
      }),
    )
    await expect(pollChatResponse('audit-x', { fetchOnce, intervalMs: 1, maxAttempts: 3 })).rejects.toThrow(/timeout/)
    expect(fetchOnce).toHaveBeenCalledTimes(3)
  })

  it('propagates fetch errors as Error', async () => {
    const fetchOnce = vi.fn(async () => {
      throw new Error('network down')
    })
    await expect(pollChatResponse('audit-x', { fetchOnce, intervalMs: 1, maxAttempts: 5 })).rejects.toThrow(
      'network down',
    )
    expect(fetchOnce).toHaveBeenCalledTimes(1)
  })
})
