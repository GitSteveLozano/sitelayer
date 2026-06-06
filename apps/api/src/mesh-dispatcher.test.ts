import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAiChatEnabled } from './mesh-dispatcher.js'

// Unit coverage for the single AI-chat feature gate. The chat's only
// response path is a hand-off to the operator's private mesh (MESH_API_URL,
// Tailnet-only). isAiChatEnabled() is what lets the route + widget cleanly
// turn OFF on a deployment with no mesh access so messages never hang.

describe('isAiChatEnabled', () => {
  let prevMeshApiUrl: string | undefined
  let prevAiChatEnabled: string | undefined
  beforeEach(() => {
    prevMeshApiUrl = process.env.MESH_API_URL
    prevAiChatEnabled = process.env.AI_CHAT_ENABLED
    delete process.env.MESH_API_URL
    delete process.env.AI_CHAT_ENABLED
  })
  afterEach(() => {
    if (prevMeshApiUrl === undefined) delete process.env.MESH_API_URL
    else process.env.MESH_API_URL = prevMeshApiUrl
    if (prevAiChatEnabled === undefined) delete process.env.AI_CHAT_ENABLED
    else process.env.AI_CHAT_ENABLED = prevAiChatEnabled
  })

  it('is disabled when nothing is configured', () => {
    expect(isAiChatEnabled()).toBe(false)
  })

  it('is enabled implicitly when MESH_API_URL is set', () => {
    process.env.MESH_API_URL = 'http://mesh-hetzner:8713'
    expect(isAiChatEnabled()).toBe(true)
  })

  it('treats a whitespace-only MESH_API_URL as unset (disabled)', () => {
    process.env.MESH_API_URL = '   '
    expect(isAiChatEnabled()).toBe(false)
  })

  it('AI_CHAT_ENABLED=1/true/on/yes forces enabled even with no MESH_API_URL', () => {
    for (const value of ['1', 'true', 'on', 'yes', 'TRUE', 'On']) {
      process.env.AI_CHAT_ENABLED = value
      delete process.env.MESH_API_URL
      expect(isAiChatEnabled(), `value=${value}`).toBe(true)
    }
  })

  it('AI_CHAT_ENABLED=0/false/off/no forces disabled even with MESH_API_URL set', () => {
    for (const value of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      process.env.AI_CHAT_ENABLED = value
      process.env.MESH_API_URL = 'http://mesh-hetzner:8713'
      expect(isAiChatEnabled(), `value=${value}`).toBe(false)
    }
  })

  it('falls back to the implicit MESH_API_URL signal on an unrecognized override value', () => {
    // A typo shouldn't silently force the chat on or off — it falls
    // through to the env signal.
    process.env.AI_CHAT_ENABLED = 'maybe'
    process.env.MESH_API_URL = 'http://mesh-hetzner:8713'
    expect(isAiChatEnabled()).toBe(true)

    delete process.env.MESH_API_URL
    expect(isAiChatEnabled()).toBe(false)
  })
})
