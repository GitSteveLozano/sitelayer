import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { PdfPageCanvas } from './pdf-page-canvas'
import type { PageRectRenderOptions, PageRenderOptions, PdfDocument, RenderHandle } from './renderer'

// jsdom has no ResizeObserver; the tiled path uses one to measure its wrapper.
// Provide a minimal stub that fires once on observe so the content box resolves.
class ResizeObserverStub {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    this.cb([], this as unknown as ResizeObserver)
  }
  unobserve() {}
  disconnect() {}
}

const noopHandle = () => ({ promise: Promise.resolve(), cancel: vi.fn() })

interface MockOpts {
  size: { width: number; height: number }
  withRect: boolean
}

function makeDoc({ size, withRect }: MockOpts) {
  const renderPage = vi.fn((_opts: PageRenderOptions): RenderHandle => noopHandle())
  const renderPageRect = vi.fn((_opts: PageRectRenderOptions): RenderHandle => noopHandle())
  const doc = {
    numPages: 1,
    getPageSize: vi.fn(() => Promise.resolve(size)),
    renderPage,
    destroy: vi.fn(() => Promise.resolve()),
    ...(withRect ? { renderPageRect } : {}),
  } as unknown as PdfDocument
  return { doc, renderPage, renderPageRect }
}

// Flush the getPageSize promise + the effects it schedules.
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  // Force a known dpr so the cap math is deterministic across machines.
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
  // jsdom getBoundingClientRect returns zeros; give the wrapper a real box so
  // contentBox produces a positive content rect.
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1000,
    height: 700,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 700,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PdfPageCanvas path selection', () => {
  it('uses the single-canvas path for a normal page at a modest scale', async () => {
    // Letter page at scale 2 / dpr 2 = 1224x1584 px — under the caps.
    const { doc, renderPage, renderPageRect } = makeDoc({ size: { width: 612, height: 792 }, withRect: true })
    const { container } = render(<PdfPageCanvas doc={doc} pageNumber={1} scale={2} style={{ objectFit: 'contain' }} />)
    await flush()
    // Exactly one canvas, no wrapper div, no tile renders.
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
    expect(renderPage).toHaveBeenCalledTimes(1)
    expect(renderPageRect).not.toHaveBeenCalled()
  })

  it('tiles a large architectural sheet when region rendering is available', async () => {
    // 34x22" sheet (2448x1584 pt) at scale 4 / dpr 2 → 19584 px/side: way over
    // the caps, so it must tile.
    const { doc, renderPage, renderPageRect } = makeDoc({ size: { width: 2448, height: 1584 }, withRect: true })
    const { container } = render(<PdfPageCanvas doc={doc} pageNumber={1} scale={4} style={{ objectFit: 'contain' }} />)
    await flush()
    // Base canvas + many tile canvases (> the single-canvas case).
    const canvases = container.querySelectorAll('canvas')
    expect(canvases.length).toBeGreaterThan(1)
    // Base layer rendered via renderPage; tiles via renderPageRect.
    expect(renderPage).toHaveBeenCalled()
    expect(renderPageRect).toHaveBeenCalled()
    // Every tile render targets a page-space sub-rect inside the page bounds.
    for (const [opts] of renderPageRect.mock.calls) {
      expect(opts.rect.x).toBeGreaterThanOrEqual(0)
      expect(opts.rect.y).toBeGreaterThanOrEqual(0)
      expect(opts.rect.x + opts.rect.width).toBeLessThanOrEqual(2448 + 1e-6)
      expect(opts.rect.y + opts.rect.height).toBeLessThanOrEqual(1584 + 1e-6)
    }
  })

  it('falls back to the single-canvas path when region rendering is unavailable', async () => {
    // Same large sheet, but the engine build lacks renderPageRect → no tiling,
    // single clamped canvas instead (nothing breaks).
    const { doc, renderPage } = makeDoc({ size: { width: 2448, height: 1584 }, withRect: false })
    const { container } = render(<PdfPageCanvas doc={doc} pageNumber={1} scale={4} style={{ objectFit: 'contain' }} />)
    await flush()
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
    expect(renderPage).toHaveBeenCalledTimes(1)
  })

  it('preserves the className/style prop API on the rendered output (tiled wrapper)', async () => {
    const { doc } = makeDoc({ size: { width: 2448, height: 1584 }, withRect: true })
    const { container } = render(
      <PdfPageCanvas doc={doc} pageNumber={1} scale={4} className="pdf-underlay" style={{ opacity: 0.7 }} />,
    )
    await flush()
    const wrapper = container.querySelector('.pdf-underlay')
    expect(wrapper).not.toBeNull()
    expect((wrapper as HTMLElement).style.opacity).toBe('0.7')
  })
})
