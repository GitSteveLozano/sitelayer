import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TraceIdFooter } from './TraceIdFooter'

// Mirror the navigator.clipboard surface that the component depends on.
// jsdom doesn't ship a usable clipboard polyfill, so we provide our own
// spy + restore it between tests. The component's catch branch swallows
// rejections to keep the UI noise-free — covered explicitly below.

describe('TraceIdFooter', () => {
  let originalClipboard: Clipboard | undefined
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    originalClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    cleanup()
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
    } else {
      // @ts-expect-error — drop the prop on environments that started without one.
      delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard
    }
  })

  test('renders the trace id and exposes a copy button', () => {
    render(<TraceIdFooter requestId="web-abc-123" />)
    expect(screen.getByText(/Trace ID:/)).toBeTruthy()
    expect(screen.getByText(/web-abc-123/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /copy trace id/i })).toBeTruthy()
  })

  test('clicking copy writes the id to the clipboard and flips the button label', async () => {
    render(<TraceIdFooter requestId="web-abc-123" />)
    fireEvent.click(screen.getByRole('button', { name: /copy trace id/i }))
    expect(writeText).toHaveBeenCalledWith('web-abc-123')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /trace id copied/i })).toBeTruthy()
    })
  })

  test('silently absorbs clipboard rejections (e.g. permission denied)', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    render(<TraceIdFooter requestId="web-abc-123" />)
    fireEvent.click(screen.getByRole('button', { name: /copy trace id/i }))
    // Wait one tick for the rejected promise to settle.
    await Promise.resolve()
    // Button label stays "Copy" — no "Copied" feedback on failure.
    expect(screen.getByRole('button', { name: /copy trace id/i })).toBeTruthy()
  })
})
