import { describe, it, expect } from 'vitest'
import { buildAgentToolsManifest } from './agent-tools.js'

describe('agent-tools manifest', () => {
  const m = buildAgentToolsManifest()

  it('enumerates the registered deterministic workflows', () => {
    expect(m.contract_version).toBe(1)
    expect(m.workflow_count).toBeGreaterThan(5)
    expect(m.workflows.length).toBe(m.workflow_count)
    // sorted by name for stable output
    const names = m.workflows.map((w) => w.name)
    expect([...names].sort()).toEqual(names)
  })

  it('every workflow exposes states + an event vocabulary + legal events keyed by state', () => {
    for (const w of m.workflows) {
      expect(w.all_states.length).toBeGreaterThan(0)
      expect(w.all_event_types.length).toBeGreaterThan(0)
      expect(w.all_states).toContain(w.initial_state)
      // legal_events_by_state covers exactly the full state set
      expect(Object.keys(w.legal_events_by_state).sort()).toEqual([...w.all_states].sort())
    }
  })

  it('terminal states accept no human/agent-dispatchable events', () => {
    for (const w of m.workflows) {
      for (const terminal of w.terminal_states) {
        expect(w.legal_events_by_state[terminal]).toEqual([])
      }
    }
  })

  it('every legal event is a {type,label} drawn from the workflow event vocabulary', () => {
    for (const w of m.workflows) {
      const vocab = new Set(w.all_event_types)
      for (const state of w.all_states) {
        const events = w.legal_events_by_state[state] as Array<{ type: string; label: string }>
        for (const ev of events) {
          expect(typeof ev.type).toBe('string')
          expect(typeof ev.label).toBe('string')
          expect(vocab.has(ev.type)).toBe(true)
        }
      }
    }
  })
})
