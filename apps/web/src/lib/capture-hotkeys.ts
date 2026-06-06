// capture-hotkeys.ts — opt-in desktop keyboard shortcuts for flagging issues and
// driving a reproduction bracket without reaching for the mouse.
//
// The operator ask: "Desktop might allow hotkeys ... something you can opt-in
// to." So these are OFF by default, desktop-only (a fine pointer + hover, i.e. a
// real keyboard), and use ⌘/Ctrl+Shift+<digit> combos — deliberately chosen
// because Mod+Shift+<digit> is unbound in Chrome/Firefox/Safari, unlike the
// devtools (I/J/C), web-console (K), responsive-design (M), and view-source (U)
// combos. The matcher is a pure function so the binding logic is unit-testable.

export type CaptureHotkeyAction = 'open_report' | 'toggle_repro' | 'mark'

export type CaptureHotkeyBinding = {
  action: CaptureHotkeyAction
  /** Requires the platform "command" modifier (metaKey on mac, ctrlKey else). */
  mod: boolean
  shift: boolean
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string
  /** Plain-English description for the on-screen hint list. */
  label: string
}

export const DEFAULT_CAPTURE_HOTKEYS: readonly CaptureHotkeyBinding[] = [
  { action: 'open_report', mod: true, shift: true, key: '1', label: 'Flag an issue' },
  { action: 'toggle_repro', mod: true, shift: true, key: '2', label: 'Start / stop a reproduction' },
  { action: 'mark', mod: true, shift: true, key: '3', label: 'Mark this moment' },
] as const

/** Minimal shape of the bits of KeyboardEvent the matcher reads (test-friendly). */
export type CaptureHotkeyEvent = {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

export function matchCaptureHotkey(
  event: CaptureHotkeyEvent,
  bindings: readonly CaptureHotkeyBinding[] = DEFAULT_CAPTURE_HOTKEYS,
): CaptureHotkeyAction | null {
  // Alt is never part of our combos; its presence means "not ours" (avoids
  // hijacking OS/browser Alt menus).
  if (event.altKey) return null
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  for (const binding of bindings) {
    if (binding.mod !== mod) continue
    if (binding.shift !== event.shiftKey) continue
    if (binding.key.toLowerCase() !== key) continue
    return binding.action
  }
  return null
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaPlatform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
  const hint = uaPlatform || navigator.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(hint)
}

/** Render a binding as a glyph hint, e.g. "⌘⇧1" on mac, "Ctrl+Shift+1" elsewhere. */
export function formatCaptureHotkey(binding: CaptureHotkeyBinding, mac: boolean = isMacPlatform()): string {
  const parts: string[] = []
  if (binding.mod) parts.push(mac ? '⌘' : 'Ctrl')
  if (binding.shift) parts.push(mac ? '⇧' : 'Shift')
  parts.push(binding.key.toUpperCase())
  return mac ? parts.join('') : parts.join('+')
}

/**
 * Whether this device should be offered keyboard shortcuts at all: a real
 * keyboard implies a fine pointer with hover. Touch-only phones/tablets get the
 * on-screen controls instead. SSR-safe (returns false without a window).
 */
export function captureHotkeysSupported(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches
  } catch {
    return false
  }
}

export type CaptureHotkeyHandlers = Partial<Record<CaptureHotkeyAction, () => void>>

export type RegisterCaptureHotkeysOptions = {
  bindings?: readonly CaptureHotkeyBinding[]
  /** Live gate — return false to ignore key events (e.g. when shortcuts are off). */
  enabled?: () => boolean
  /** Event target; defaults to window. Injected for tests. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}

/**
 * Attach a keydown listener that fires the matching handler. Returns an
 * unsubscribe function. A matched, handled action calls `preventDefault()` so it
 * does not also trigger a stray browser behavior.
 */
export function registerCaptureHotkeys(
  handlers: CaptureHotkeyHandlers,
  options: RegisterCaptureHotkeysOptions = {},
): () => void {
  const target = options.target ?? (typeof window !== 'undefined' ? window : null)
  if (!target) return () => {}
  const bindings = options.bindings ?? DEFAULT_CAPTURE_HOTKEYS
  const listener = (event: Event) => {
    if (options.enabled && !options.enabled()) return
    const keyboardEvent = event as unknown as CaptureHotkeyEvent & { preventDefault?: () => void }
    if (typeof keyboardEvent.key !== 'string') return
    const action = matchCaptureHotkey(keyboardEvent, bindings)
    if (!action) return
    const handler = handlers[action]
    if (!handler) return
    keyboardEvent.preventDefault?.()
    handler()
  }
  target.addEventListener('keydown', listener)
  return () => target.removeEventListener('keydown', listener)
}
