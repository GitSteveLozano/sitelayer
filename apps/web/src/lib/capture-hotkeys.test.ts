import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CAPTURE_HOTKEYS,
  formatCaptureHotkey,
  matchCaptureHotkey,
  registerCaptureHotkeys,
  type CaptureHotkeyEvent,
} from './capture-hotkeys'

function evt(partial: Partial<CaptureHotkeyEvent>): CaptureHotkeyEvent {
  return { key: '', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...partial }
}

describe('matchCaptureHotkey', () => {
  it('matches the default Mod+Shift+digit bindings (meta or ctrl)', () => {
    expect(matchCaptureHotkey(evt({ key: '1', metaKey: true, shiftKey: true }))).toBe('open_report')
    expect(matchCaptureHotkey(evt({ key: '2', ctrlKey: true, shiftKey: true }))).toBe('toggle_repro')
    expect(matchCaptureHotkey(evt({ key: '3', metaKey: true, shiftKey: true }))).toBe('mark')
  })

  it('requires the modifier and shift', () => {
    expect(matchCaptureHotkey(evt({ key: '1', metaKey: true }))).toBeNull() // no shift
    expect(matchCaptureHotkey(evt({ key: '1', shiftKey: true }))).toBeNull() // no mod
    expect(matchCaptureHotkey(evt({ key: '9', metaKey: true, shiftKey: true }))).toBeNull() // unbound key
  })

  it('never matches when Alt is held (avoids OS/browser menu collisions)', () => {
    expect(matchCaptureHotkey(evt({ key: '1', metaKey: true, shiftKey: true, altKey: true }))).toBeNull()
  })
})

describe('formatCaptureHotkey', () => {
  it('renders mac glyphs and non-mac words', () => {
    const open = DEFAULT_CAPTURE_HOTKEYS.find((binding) => binding.action === 'open_report')!
    expect(formatCaptureHotkey(open, true)).toBe('⌘⇧1')
    expect(formatCaptureHotkey(open, false)).toBe('Ctrl+Shift+1')
  })
})

describe('registerCaptureHotkeys', () => {
  function fakeTarget() {
    let listener: ((event: Event) => void) | null = null
    return {
      addEventListener: vi.fn((_type: string, l: EventListenerOrEventListenerObject) => {
        listener = l as (event: Event) => void
      }),
      removeEventListener: vi.fn(() => {
        listener = null
      }),
      dispatch(e: Partial<CaptureHotkeyEvent> & { preventDefault?: () => void }) {
        listener?.(e as unknown as Event)
      },
    }
  }

  it('fires the matching handler and prevents default', () => {
    const target = fakeTarget()
    const onMark = vi.fn()
    const preventDefault = vi.fn()
    const unsubscribe = registerCaptureHotkeys({ mark: onMark }, { target })

    target.dispatch({ key: '3', metaKey: true, shiftKey: true, preventDefault })
    expect(onMark).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)

    unsubscribe()
    expect(target.removeEventListener).toHaveBeenCalled()
  })

  it('respects the enabled gate', () => {
    const target = fakeTarget()
    const onOpen = vi.fn()
    registerCaptureHotkeys({ open_report: onOpen }, { target, enabled: () => false })
    target.dispatch({ key: '1', metaKey: true, shiftKey: true })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('ignores actions with no registered handler', () => {
    const target = fakeTarget()
    // Only open_report handled; pressing the repro toggle is a no-op (no throw).
    registerCaptureHotkeys({ open_report: vi.fn() }, { target })
    expect(() => target.dispatch({ key: '2', metaKey: true, shiftKey: true })).not.toThrow()
  })
})
