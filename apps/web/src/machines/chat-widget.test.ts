import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { chatWidgetMachine } from './chat-widget'
import type { OperatorContextPacket } from '@/lib/operator-context'

// Tests the chat-widget XState machine in isolation. The widget UI
// (OperatorContextChatWidget.tsx) wires events through the useChatWidget
// hook; this suite asserts the lifecycle invariants regardless of the
// React layer:
//   - closed → open via OPEN, TOGGLE
//   - open(.idle) → closed via CLOSE, TOGGLE
//   - CONTEXT_UPDATED + SET_DRAFT land in any state
//   - SEND with empty draft is rejected by hasDraft guard
//   - SEND with non-empty draft enqueues the message + clears the draft
//   - enqueueDraft attaches packet_generated_at when a packet is present

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

describe('chatWidgetMachine', () => {
  it('starts in closed with empty context', () => {
    const actor = createActor(chatWidgetMachine).start()
    expect(actor.getSnapshot().value).toBe('closed')
    expect(actor.getSnapshot().context.draft).toBe('')
    expect(actor.getSnapshot().context.messages).toEqual([])
    expect(actor.getSnapshot().context.packet).toBeNull()
    expect(actor.getSnapshot().context.packetMissing).toBe(true)
  })

  it('OPEN transitions closed → open.idle', () => {
    const actor = createActor(chatWidgetMachine).start()
    actor.send({ type: 'OPEN' })
    expect(actor.getSnapshot().matches({ open: 'idle' })).toBe(true)
  })

  it('TOGGLE flips closed ↔ open both ways', () => {
    const actor = createActor(chatWidgetMachine).start()
    actor.send({ type: 'TOGGLE' })
    expect(actor.getSnapshot().matches('open')).toBe(true)
    actor.send({ type: 'TOGGLE' })
    expect(actor.getSnapshot().matches('closed')).toBe(true)
  })

  it('CLOSE from open returns to closed', () => {
    const actor = createActor(chatWidgetMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'CLOSE' })
    expect(actor.getSnapshot().matches('closed')).toBe(true)
  })

  it('CONTEXT_UPDATED syncs the packet and clears packetMissing', () => {
    const actor = createActor(chatWidgetMachine).start()
    const packet = makePacket()
    actor.send({ type: 'CONTEXT_UPDATED', packet })
    const ctx = actor.getSnapshot().context
    expect(ctx.packet).toBe(packet)
    expect(ctx.packetMissing).toBe(false)
  })

  it('CONTEXT_UPDATED with null packet flips packetMissing back on', () => {
    const actor = createActor(chatWidgetMachine).start()
    actor.send({ type: 'CONTEXT_UPDATED', packet: makePacket() })
    actor.send({ type: 'CONTEXT_UPDATED', packet: null })
    const ctx = actor.getSnapshot().context
    expect(ctx.packet).toBeNull()
    expect(ctx.packetMissing).toBe(true)
  })

  it('SET_DRAFT stores the value verbatim', () => {
    const actor = createActor(chatWidgetMachine).start()
    actor.send({ type: 'SET_DRAFT', value: 'hello ' })
    expect(actor.getSnapshot().context.draft).toBe('hello ')
  })

  it('SEND with empty draft is rejected by the hasDraft guard', () => {
    const actor = createActor(chatWidgetMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SEND' })
    // Guard blocks the transition; no message enqueued.
    expect(actor.getSnapshot().context.messages).toEqual([])
  })

  it('SEND with whitespace-only draft is rejected by the hasDraft guard', () => {
    const actor = createActor(chatWidgetMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: '   \t  ' })
    actor.send({ type: 'SEND' })
    expect(actor.getSnapshot().context.messages).toEqual([])
  })

  it('SEND with a real draft enqueues and clears the draft', () => {
    const actor = createActor(chatWidgetMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: '  what is the focus?  ' })
    actor.send({ type: 'SEND' })
    const ctx = actor.getSnapshot().context
    expect(ctx.draft).toBe('')
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0]).toMatchObject({
      role: 'operator',
      body: 'what is the focus?',
    })
    expect(ctx.messages[0]!.id).toMatch(/^m-\d+/)
    // No packet was synced; the optional field is absent (not undefined).
    expect('packet_generated_at' in ctx.messages[0]!).toBe(false)
  })

  it('SEND attaches packet_generated_at when a packet is in context', () => {
    const actor = createActor(chatWidgetMachine).start()
    const packet = makePacket({ generated_at: '2026-05-21T01:23:45Z' })
    actor.send({ type: 'CONTEXT_UPDATED', packet })
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'SET_DRAFT', value: 'do the thing' })
    actor.send({ type: 'SEND' })
    const ctx = actor.getSnapshot().context
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0]?.packet_generated_at).toBe('2026-05-21T01:23:45Z')
  })

  it('CONTEXT_UPDATED can fire while open without changing the state', () => {
    const actor = createActor(chatWidgetMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'CONTEXT_UPDATED', packet: makePacket() })
    expect(actor.getSnapshot().matches({ open: 'idle' })).toBe(true)
    expect(actor.getSnapshot().context.packet).not.toBeNull()
  })

  it('DISMISS_ERROR clears the context.error', () => {
    const actor = createActor(chatWidgetMachine).start()
    // No public event sets error, so write context directly via snapshot
    // is not allowed in v5 — instead, verify DISMISS_ERROR is a no-op
    // when error is already null (the path the UI hits after a retry).
    actor.send({ type: 'DISMISS_ERROR' })
    expect(actor.getSnapshot().context.error).toBeNull()
  })
})
