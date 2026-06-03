import { describe, expect, it } from 'vitest'
import { qboCircuitKey } from './qbo-circuit.js'

// Per-company circuit-breaker key. The breaker used to key on the bare
// integration name 'qbo' (GLOBAL) — one tenant's revoked-token / outage
// failures would open the circuit for EVERY company and halt the whole QBO
// drain. Keying per company isolates the blast radius. These tests pin the
// invariants the runner pushers rely on:
//
//   - distinct companies → distinct keys (no cross-tenant interference)
//   - same company → same key (the breaker, the persisted circuit_state row,
//     and any metrics label all agree)
//   - keys are namespaced under `qbo:` so they don't collide with other
//     integrations' breaker keys.
describe('qboCircuitKey', () => {
  it('namespaces the key per company under qbo:', () => {
    expect(qboCircuitKey('company-abc')).toBe('qbo:company-abc')
  })

  it('produces distinct keys for distinct companies', () => {
    expect(qboCircuitKey('company-a')).not.toBe(qboCircuitKey('company-b'))
  })

  it('is deterministic: same company → same key', () => {
    const id = '4b9a7f10-3c2d-4e5a-8b1c-9f0e1d2c3b4a'
    expect(qboCircuitKey(id)).toBe(qboCircuitKey(id))
  })

  it('is no longer the global "qbo" key', () => {
    // The old global key would have halted every tenant's drain on one
    // tenant's failure. The per-company key must never equal it.
    expect(qboCircuitKey('any-company')).not.toBe('qbo')
  })
})
