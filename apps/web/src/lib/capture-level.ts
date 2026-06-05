// capture-level.ts — the progressive opt-in "recording level" the user climbs
// on the site itself, instead of having the level fixed by the invite link.
//
// The operator ask: "something you can opt-in to on the site and progressively
// add more and more recording." This models that as one strictly-additive
// ladder the user picks from, persisted in localStorage and clamped to what the
// current device/browser can actually do (so we never offer screen video on a
// phone where `getDisplayMedia` would just fail).
//
//   note   — describe it (typed note + auto state snapshot). Always available.
//   replay — + record my screen *actions* (rrweb DOM replay, no OS prompt).
//   audio  — + record my voice (microphone prompt).
//   screen — + record my screen *video* (screen-picker prompt; desktop only).
//
// Each higher rung includes the ones below it, so choosing "audio" also records
// the DOM replay that makes the report reproducible. Audio/screen still require
// their explicit in-dock controls and a browser permission — opting into the
// level only *offers* them; it never starts a media stream on its own.

import type { CaptureCapabilities } from './capture-capabilities'

export type CaptureLevel = 'note' | 'replay' | 'audio' | 'screen'

export const CAPTURE_LEVEL_ORDER: readonly CaptureLevel[] = ['note', 'replay', 'audio', 'screen'] as const

export const CAPTURE_LEVEL_STORAGE_KEY = 'sitelayer.capture-level'

export const DEFAULT_CAPTURE_LEVEL: CaptureLevel = 'replay'

export type CaptureLevelMeta = {
  level: CaptureLevel
  /** Short button/stepper label. */
  label: string
  /** One-line plain-English description for the opt-in control. */
  description: string
  /** Whether selecting this rung will (later) trigger a browser permission. */
  prompts: boolean
}

export const CAPTURE_LEVEL_META: Record<CaptureLevel, CaptureLevelMeta> = {
  note: {
    level: 'note',
    label: 'Describe it',
    description: 'Type what is wrong. We attach the page and app state automatically.',
    prompts: false,
  },
  replay: {
    level: 'replay',
    label: 'Replay my actions',
    description: 'Also record your clicks and the page (no microphone, no prompt).',
    prompts: false,
  },
  audio: {
    level: 'audio',
    label: 'Record my voice',
    description: 'Also narrate the problem out loud (asks for the microphone once).',
    prompts: true,
  },
  screen: {
    level: 'screen',
    label: 'Record my screen',
    description: 'Also record screen video (asks to share your screen; desktop only).',
    prompts: true,
  },
}

export type CaptureLevelStreams = {
  note: boolean
  domReplay: boolean
  audio: boolean
  screen: boolean
}

export function captureLevelRank(level: CaptureLevel): number {
  const rank = CAPTURE_LEVEL_ORDER.indexOf(level)
  return rank < 0 ? 0 : rank
}

export function isCaptureLevel(value: unknown): value is CaptureLevel {
  return typeof value === 'string' && (CAPTURE_LEVEL_ORDER as readonly string[]).includes(value)
}

/** The set of streams a chosen level turns on. Strictly additive. */
export function captureLevelStreams(level: CaptureLevel): CaptureLevelStreams {
  const rank = captureLevelRank(level)
  return {
    note: true,
    domReplay: rank >= captureLevelRank('replay'),
    audio: rank >= captureLevelRank('audio'),
    screen: rank >= captureLevelRank('screen'),
  }
}

/** Whether the device/browser can support a given rung right now. */
export function isCaptureLevelAvailable(level: CaptureLevel, capabilities: CaptureCapabilities): boolean {
  switch (level) {
    case 'note':
      return true
    case 'replay':
      return capabilities.dom_replay
    case 'audio':
      return capabilities.audio
    case 'screen':
      return capabilities.video
  }
}

/** The rungs offerable on this device, lowest→highest. 'note' is always present. */
export function availableCaptureLevels(capabilities: CaptureCapabilities): CaptureLevel[] {
  return CAPTURE_LEVEL_ORDER.filter((level) => isCaptureLevelAvailable(level, capabilities))
}

/**
 * Clamp a desired level down to what the device can do: the highest available
 * rung that is not above the desired one. Falls back to 'note'. This is what
 * keeps a "screen" preference from a desktop session from breaking when the
 * same user reopens the link on a phone.
 */
export function clampCaptureLevel(desired: CaptureLevel, capabilities: CaptureCapabilities): CaptureLevel {
  const wantRank = captureLevelRank(desired)
  let resolved: CaptureLevel = 'note'
  for (const level of CAPTURE_LEVEL_ORDER) {
    if (captureLevelRank(level) <= wantRank && isCaptureLevelAvailable(level, capabilities)) {
      resolved = level
    }
  }
  return resolved
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

/** Read the persisted preference (unclamped). Returns null when unset/invalid. */
export function readStoredCaptureLevel(): CaptureLevel | null {
  const store = safeLocalStorage()
  if (!store) return null
  const raw = store.getItem(CAPTURE_LEVEL_STORAGE_KEY)
  return isCaptureLevel(raw) ? raw : null
}

export function writeStoredCaptureLevel(level: CaptureLevel): void {
  const store = safeLocalStorage()
  if (!store) return
  try {
    store.setItem(CAPTURE_LEVEL_STORAGE_KEY, level)
  } catch {
    /* storage disabled: level falls back to the device default */
  }
}

/**
 * The effective level for this session: the stored preference (or the default)
 * clamped to the device's capabilities.
 */
export function resolveCaptureLevel(
  capabilities: CaptureCapabilities,
  options: { stored?: CaptureLevel | null; fallback?: CaptureLevel } = {},
): CaptureLevel {
  const stored = options.stored !== undefined ? options.stored : readStoredCaptureLevel()
  const desired = stored ?? options.fallback ?? DEFAULT_CAPTURE_LEVEL
  return clampCaptureLevel(desired, capabilities)
}
