import { describe, expect, it } from 'vitest'
import { validateQboStateSecret } from './qbo-config.js'

describe('validateQboStateSecret', () => {
  it('rejects prod when state secret is missing', () => {
    const result = validateQboStateSecret({
      tier: 'prod',
      stateSecret: null,
      clientSecret: 'qbo-client-secret',
    })
    expect(result).toEqual({ ok: false, reason: 'missing' })
  })

  it('rejects prod when state secret is empty/whitespace', () => {
    const result = validateQboStateSecret({
      tier: 'prod',
      stateSecret: '   ',
      clientSecret: 'qbo-client-secret',
    })
    expect(result).toEqual({ ok: false, reason: 'missing' })
  })

  it('rejects prod when state secret reuses the client secret', () => {
    const result = validateQboStateSecret({
      tier: 'prod',
      stateSecret: 'qbo-client-secret',
      clientSecret: 'qbo-client-secret',
    })
    expect(result).toEqual({ ok: false, reason: 'reused-client-secret' })
  })

  it('accepts prod when state secret is distinct and present', () => {
    const result = validateQboStateSecret({
      tier: 'prod',
      stateSecret: 'qbo-state-secret',
      clientSecret: 'qbo-client-secret',
    })
    expect(result).toEqual({ ok: true, stateSecret: 'qbo-state-secret' })
  })

  it('falls back to client secret outside prod when state secret is missing', () => {
    const result = validateQboStateSecret({
      tier: 'dev',
      stateSecret: null,
      clientSecret: 'qbo-client-secret',
    })
    expect(result).toEqual({ ok: true, stateSecret: 'qbo-client-secret' })
  })

  it('uses provided state secret outside prod when present', () => {
    const result = validateQboStateSecret({
      tier: 'preview',
      stateSecret: 'preview-state',
      clientSecret: 'qbo-client-secret',
    })
    expect(result).toEqual({ ok: true, stateSecret: 'preview-state' })
  })
})
