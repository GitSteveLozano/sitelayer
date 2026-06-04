// capture-capabilities.ts — the single resolver for the capture capability
// ladder (decomposition plan §4). Before this, the same probe logic (audio
// support, DOM-replay support, beacon-enabled, tier) was re-derived inline in
// `AuthenticatedFeedbackDock.tsx`, `IssueReporter.tsx`, and
// `product-trace-beacon.ts`. This composes the existing primitives
// (`isAudioCaptureSupported()`, `isCaptureReplayRecorderSupported()`, the
// beacon gate) into one `CaptureCapabilities` so every surface agrees.
//
// Strictly additive / degrade-down (plan §4 "Capability tiers"):
//   tier 0 — passive events (always available; the floor)
//   tier 1 — +DOM replay (rrweb), no OS prompt
//   tier 2 — +audio (getUserMedia grant)
//   tier 3 — +video (getDisplayMedia grant + MediaRecorder)
//
// IMPORTANT (bundle hygiene): this module must stay off the eager critical
// path's rrweb dependency. The beacon + trace emitter import it for every
// visitor, and `@rrweb/record` is deliberately confined to the lazy
// `vendor-rrweb` chunk (see apps/web/vite.config.ts). So we DO NOT statically
// import `capture-replay-recorder.ts` (which pulls rrweb) here. DOM-replay
// support is composed via an injectable probe: callers that already load the
// recorder (the docks) can pass the real `isCaptureReplayRecorderSupported`,
// and the default is a dependency-free environment check.

import { isAudioCaptureSupported, isScreenCaptureSupported } from './capture-recorder'
import { traceBeaconEnabled } from './product-trace-consent'

export type CaptureTier = 0 | 1 | 2 | 3

export type CaptureCapabilities = {
  /** Highest capability tier currently available (degrade down, never up). */
  tier: CaptureTier
  /** `getUserMedia({audio})` + MediaRecorder available (tier 2). */
  audio: boolean
  /** rrweb DOM-replay recorder can run here (tier 1). */
  dom_replay: boolean
  /** Public trace beacon enabled: URL set + consent granted + not DNT (tier 0 transport). */
  beacon: boolean
  /** In-browser screen video recorder available (tier 3). */
  video: boolean
}

/**
 * Injectable probes so the resolver stays dependency-free on the eager path.
 * Each defaults to a primitive that does not pull heavy vendor code.
 */
export type CaptureCapabilityProbes = {
  audioSupported?: () => boolean
  domReplaySupported?: () => boolean
  beaconEnabled?: () => boolean
  videoSupported?: () => boolean
}

/** Environment-level DOM-replay capability — mirrors the recorder's own browser
 * check (`capture-replay-recorder.ts`) without importing it (keeps rrweb off the
 * eager path). Callers that already load the recorder may override this with
 * `isCaptureReplayRecorderSupported`. */
function defaultDomReplaySupported(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && typeof Blob !== 'undefined'
}

/** The beacon gate: URL configured + consent granted + not opted out (DNT/GPC).
 * Identical composition to the former private `beaconEnabled()` in
 * `product-trace-beacon.ts`. */
function defaultBeaconEnabled(): boolean {
  return traceBeaconEnabled()
}

function defaultVideoSupported(): boolean {
  return isScreenCaptureSupported()
}

/**
 * Resolve the current capture capabilities by composing the existing probes.
 * Pure and side-effect-free; safe to call on every render / event.
 */
export function resolveCaptureCapabilities(probes: CaptureCapabilityProbes = {}): CaptureCapabilities {
  const audio = (probes.audioSupported ?? isAudioCaptureSupported)()
  const dom_replay = (probes.domReplaySupported ?? defaultDomReplaySupported)()
  const beacon = (probes.beaconEnabled ?? defaultBeaconEnabled)()
  const video = (probes.videoSupported ?? defaultVideoSupported)()

  // Tier ladder is strictly additive: each higher tier requires the one below.
  let tier: CaptureTier = 0
  if (dom_replay) tier = 1
  if (tier === 1 && audio) tier = 2
  if (tier === 2 && video) tier = 3

  return { tier, audio, dom_replay, beacon, video }
}
