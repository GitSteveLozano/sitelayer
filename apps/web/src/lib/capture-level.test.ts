import { afterEach, describe, expect, it } from 'vitest'
import type { CaptureCapabilities } from './capture-capabilities'
import {
  CAPTURE_LEVEL_STORAGE_KEY,
  availableCaptureLevels,
  captureLevelStreams,
  clampCaptureLevel,
  isCaptureLevel,
  readStoredCaptureLevel,
  resolveCaptureLevel,
  writeStoredCaptureLevel,
} from './capture-level'

function caps(partial: Partial<CaptureCapabilities>): CaptureCapabilities {
  return { tier: 0, audio: false, dom_replay: false, beacon: false, video: false, ...partial }
}

const DESKTOP = caps({ tier: 3, audio: true, dom_replay: true, video: true })
const PHONE = caps({ tier: 2, audio: true, dom_replay: true, video: false })
const LOCKED = caps({ tier: 0 })

afterEach(() => {
  window.localStorage.removeItem(CAPTURE_LEVEL_STORAGE_KEY)
})

describe('capture level ladder', () => {
  it('is strictly additive', () => {
    expect(captureLevelStreams('note')).toEqual({ note: true, domReplay: false, audio: false, screen: false })
    expect(captureLevelStreams('replay')).toEqual({ note: true, domReplay: true, audio: false, screen: false })
    expect(captureLevelStreams('audio')).toEqual({ note: true, domReplay: true, audio: true, screen: false })
    expect(captureLevelStreams('screen')).toEqual({ note: true, domReplay: true, audio: true, screen: true })
  })

  it('offers only the rungs the device can do', () => {
    expect(availableCaptureLevels(DESKTOP)).toEqual(['note', 'replay', 'audio', 'screen'])
    // A phone has no getDisplayMedia → no screen rung.
    expect(availableCaptureLevels(PHONE)).toEqual(['note', 'replay', 'audio'])
    // A locked-down browser still always offers the typed note.
    expect(availableCaptureLevels(LOCKED)).toEqual(['note'])
  })

  it('clamps a desktop preference down on a phone', () => {
    expect(clampCaptureLevel('screen', DESKTOP)).toBe('screen')
    expect(clampCaptureLevel('screen', PHONE)).toBe('audio')
    expect(clampCaptureLevel('audio', LOCKED)).toBe('note')
  })

  it('persists and resolves the stored preference against capabilities', () => {
    expect(readStoredCaptureLevel()).toBeNull()
    writeStoredCaptureLevel('screen')
    expect(readStoredCaptureLevel()).toBe('screen')

    // Stored "screen" resolves fully on desktop, clamps to audio on a phone.
    expect(resolveCaptureLevel(DESKTOP)).toBe('screen')
    expect(resolveCaptureLevel(PHONE)).toBe('audio')
  })

  it('falls back to the default level when nothing is stored', () => {
    expect(resolveCaptureLevel(DESKTOP, { stored: null })).toBe('replay')
    expect(resolveCaptureLevel(LOCKED, { stored: null })).toBe('note')
  })

  it('guards the level type', () => {
    expect(isCaptureLevel('audio')).toBe(true)
    expect(isCaptureLevel('nope')).toBe(false)
    expect(isCaptureLevel(null)).toBe(false)
  })
})
