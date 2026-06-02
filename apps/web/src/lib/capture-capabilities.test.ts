import { describe, expect, it } from 'vitest'
import { resolveCaptureCapabilities } from './capture-capabilities'

const ALL_OFF = {
  audioSupported: () => false,
  domReplaySupported: () => false,
  beaconEnabled: () => false,
  videoSupported: () => false,
}

describe('resolveCaptureCapabilities', () => {
  it('falls to tier 0 (passive events only) when nothing is supported', () => {
    const caps = resolveCaptureCapabilities(ALL_OFF)
    expect(caps).toEqual({ tier: 0, audio: false, dom_replay: false, beacon: false, video: false })
  })

  it('reaches tier 1 with DOM replay only', () => {
    const caps = resolveCaptureCapabilities({ ...ALL_OFF, domReplaySupported: () => true })
    expect(caps.tier).toBe(1)
    expect(caps.dom_replay).toBe(true)
  })

  it('reaches tier 2 with DOM replay + audio', () => {
    const caps = resolveCaptureCapabilities({
      ...ALL_OFF,
      domReplaySupported: () => true,
      audioSupported: () => true,
    })
    expect(caps.tier).toBe(2)
    expect(caps.audio).toBe(true)
  })

  it('reaches tier 3 only with the full additive ladder', () => {
    const caps = resolveCaptureCapabilities({
      audioSupported: () => true,
      domReplaySupported: () => true,
      beaconEnabled: () => true,
      videoSupported: () => true,
    })
    expect(caps.tier).toBe(3)
    expect(caps).toEqual({ tier: 3, audio: true, dom_replay: true, beacon: true, video: true })
  })

  it('degrades down: audio without DOM replay stays at tier 0', () => {
    const caps = resolveCaptureCapabilities({ ...ALL_OFF, audioSupported: () => true })
    expect(caps.tier).toBe(0)
    expect(caps.audio).toBe(true)
  })

  it('video without the lower tiers does not skip the ladder', () => {
    const caps = resolveCaptureCapabilities({ ...ALL_OFF, videoSupported: () => true })
    expect(caps.tier).toBe(0)
    expect(caps.video).toBe(true)
  })

  it('beacon availability is independent of the recorder tier', () => {
    const caps = resolveCaptureCapabilities({ ...ALL_OFF, beaconEnabled: () => true })
    expect(caps.beacon).toBe(true)
    expect(caps.tier).toBe(0)
  })
})
