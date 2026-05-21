import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { createChatWidgetMachine } from './chat-widget'
import type { StageOperatorContextChatInput, StageOperatorContextChatResponse } from '@/lib/api/operator-context-chat'
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

function startActor(stage = makeStageOk()) {
  const actor = createActor(createChatWidgetMachine(stage)).start()
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
    expectValue(actor, { open: 'idle' })
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
    expect(ctx.error).toBeNull()
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
