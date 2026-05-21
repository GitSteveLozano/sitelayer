import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { createChatWidgetMachine, pollChatResponse, type ChatWidgetResponse } from './chat-widget'
import type {
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

/** Default poller never resolves so tests that don't care about the
 * polling state can observe the awaitingResponse state indefinitely
 * without having to control timing. Tests that DO care pass a custom
 * poller that resolves or rejects synchronously. */
const pendingForeverPoller = () => new Promise<ChatWidgetResponse>(() => {})

function startActor(
  stage = makeStageOk(),
  poller: (auditEventId: string) => Promise<ChatWidgetResponse> = pendingForeverPoller,
) {
  const actor = createActor(createChatWidgetMachine(stage, poller)).start()
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

  it('SEND with a packet stages through the API actor', async () => {
    const packet = makePacket({ generated_at: '2026-05-21T01:23:45Z' })
    const { actor, stage } = startActor(makeStageOk('audit-123'))
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
    // After staging succeeds, the machine moves to awaitingResponse
    // and invokes the polling actor (pending-forever poller in this
    // test). The staged message is now visible with audit_event_id;
    // awaitingResponseFor matches so the UI knows to show the
    // "waiting for response" affordance.
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
  })

  it('polling resolves → idle with response appended + staged flipped to responded', async () => {
    const packet = makePacket()
    const poller = vi.fn(
      async (auditEventId: string): Promise<ChatWidgetResponse> => ({
        audit_event_id: auditEventId,
        response_audit_event_id: 'resp-001',
        body: 'Hello back, operator.',
        created_at: '2026-05-21T03:14:15Z',
      }),
    )
    const { actor } = startActor(makeStageOk('audit-456'), poller)
    actor.send({ type: 'CONTEXT_UPDATED', packet })
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: 'hi' })
    actor.send({ type: 'SEND' })

    await settle()
    await settle()
    expectValue(actor, { open: 'idle' })

    const ctx = actor.getSnapshot().context
    expect(poller).toHaveBeenCalledWith('audit-456')
    expect(ctx.awaitingResponseFor).toBeNull()
    expect(ctx.error).toBeNull()

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

  it('polling rejects → idle with error, staged message stays at staged', async () => {
    const packet = makePacket()
    const poller = vi.fn(async () => {
      throw new Error('chat response timeout — subscription-CLI runner did not respond in time')
    })
    const { actor } = startActor(makeStageOk('audit-789'), poller)
    actor.send({ type: 'CONTEXT_UPDATED', packet })
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: 'hi' })
    actor.send({ type: 'SEND' })

    await settle()
    await settle()
    expectValue(actor, { open: 'idle' })

    const ctx = actor.getSnapshot().context
    expect(ctx.awaitingResponseFor).toBeNull()
    expect(ctx.error).toMatch(/timeout/)
    // Staged message stays at status='staged'; no response_body. The
    // operator can dismiss the error and retry from the same staged
    // history (we don't roll the audit row back — it's a durable
    // record that the message was sent, just no answer came back).
    const stagedMsg = ctx.messages.find((m) => m.audit_event_id === 'audit-789')
    expect(stagedMsg).toMatchObject({ status: 'staged' })
    expect(stagedMsg?.response_body).toBeUndefined()
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
    const fetchOnce = vi.fn(
      async (_auditEventId: string): Promise<FetchOperatorContextChatResponseResult> => {
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
      },
    )
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
    await expect(pollChatResponse('audit-x', { fetchOnce, intervalMs: 1, maxAttempts: 5 })).rejects.toThrow('network down')
    expect(fetchOnce).toHaveBeenCalledTimes(1)
  })
})
