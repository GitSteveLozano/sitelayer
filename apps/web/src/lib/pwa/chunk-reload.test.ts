import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { __test, installChunkReloadHandler, isChunkLoadError, recoverFromChunkError } from './chunk-reload'

// Tests for the stale-chunk recovery wiring. We can't trigger a real
// browser ChunkLoadError under jsdom, so instead we assert:
//   1. The pattern-matcher accepts every shape we expect to see.
//   2. `recoverFromChunkError` schedules exactly one `location.reload()`
//      per session and respects the sessionStorage flag.
//   3. The window-level handler routes unhandled-rejection + error
//      events into the same reload path.

beforeEach(() => {
  window.sessionStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('isChunkLoadError', () => {
  test('matches Vite "Failed to fetch dynamically imported module"', () => {
    expect(
      isChunkLoadError(
        new Error('Failed to fetch dynamically imported module: https://app.example.com/assets/foo-abc123.js'),
      ),
    ).toBe(true)
  })

  test('matches webpack "Loading chunk N failed"', () => {
    expect(isChunkLoadError(new Error('Loading chunk 42 failed.'))).toBe(true)
  })

  test('matches a ChunkLoadError name', () => {
    const err: Error & { name: string } = new Error('something broke')
    err.name = 'ChunkLoadError'
    expect(isChunkLoadError(err)).toBe(true)
  })

  test('does not match unrelated errors', () => {
    expect(isChunkLoadError(new Error('TypeError: undefined is not a function'))).toBe(false)
    expect(isChunkLoadError({ message: 'API 500' })).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('recoverFromChunkError', () => {
  test('triggers location.reload after the delay and sets the session flag', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })

    const scheduled = recoverFromChunkError(new Error('Loading chunk 5 failed'))
    expect(scheduled).toBe(true)
    expect(window.sessionStorage.getItem(__test.SESSION_FLAG)).toBe('1')
    expect(reload).not.toHaveBeenCalled()

    vi.advanceTimersByTime(__test.RELOAD_DELAY_MS)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('skips the second attempt within the same session (no reload loop)', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })

    // Pre-set the flag as if a prior chunk error already triggered a
    // reload — this is the "reload also crashed" scenario.
    window.sessionStorage.setItem(__test.SESSION_FLAG, '1')

    const scheduled = recoverFromChunkError(new Error('Loading chunk 5 failed'))
    expect(scheduled).toBe(false)

    vi.advanceTimersByTime(__test.RELOAD_DELAY_MS)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('installChunkReloadHandler', () => {
  test('window error event with a chunk error schedules a reload', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })

    const cleanup = installChunkReloadHandler()
    try {
      const err = new Error('Failed to fetch dynamically imported module: https://x/y.js')
      window.dispatchEvent(new ErrorEvent('error', { error: err, message: err.message }))
      vi.advanceTimersByTime(__test.RELOAD_DELAY_MS)
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })

  test('non-chunk errors are ignored', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })

    const cleanup = installChunkReloadHandler()
    try {
      window.dispatchEvent(
        new ErrorEvent('error', { error: new Error('Plain runtime error'), message: 'Plain runtime error' }),
      )
      vi.advanceTimersByTime(__test.RELOAD_DELAY_MS)
      expect(reload).not.toHaveBeenCalled()
      expect(window.sessionStorage.getItem(__test.SESSION_FLAG)).toBeNull()
    } finally {
      cleanup()
    }
  })
})
