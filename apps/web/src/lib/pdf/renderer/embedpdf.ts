// EmbedPDF-backed renderer (ported from qedviz). Uses PDFium WASM — the same
// engine Chrome uses for its built-in PDF viewer — via @embedpdf/engines direct
// mode. Implements the engine-agnostic PdfRenderer contract in ./types.
//
// Background: pdfjs-dist 4.x and 5.x both silently hang past page 1 in this
// kind of setup. PDFium is a different rendering pipeline entirely and does
// not hang — it is the chosen foundation for the takeoff drawing surface.

import { createPdfiumDirectEngine } from '@embedpdf/engines/pdfium'
import PdfiumWasm from '@embedpdf/pdfium/pdfium.wasm?url'
import type { PdfBookmarkObject, PdfDocumentObject, PdfPageObject, PdfTextRun } from '@embedpdf/models'
import type {
  PageRectRenderOptions,
  PageRenderOptions,
  PdfBookmark,
  PdfDocument,
  PdfRenderer,
  PdfSearchHandle,
  PdfSearchHit,
  RenderHandle,
  TextLayerOptions,
} from './types'

function flattenBookmarks(nodes: PdfBookmarkObject[]): PdfBookmark[] {
  return nodes.map((node) => {
    let pageNumber: number | null = null
    const target = node.target
    if (target && target.type === 'destination' && target.destination) {
      const idx = target.destination.pageIndex
      if (typeof idx === 'number' && Number.isFinite(idx)) {
        pageNumber = idx + 1
      }
    } else if (target && target.type === 'action') {
      // pdfjs-lib-like "GoTo" actions sometimes surface destination inline
      const action = target.action as { destination?: { pageIndex?: number } }
      if (action?.destination && typeof action.destination.pageIndex === 'number') {
        pageNumber = action.destination.pageIndex + 1
      }
    }
    const children = node.children && node.children.length > 0 ? flattenBookmarks(node.children) : undefined
    return { title: node.title, pageNumber, ...(children ? { children } : {}) }
  })
}

type EmbedEngine = Awaited<ReturnType<typeof createPdfiumDirectEngine>>

let enginePromise: Promise<EmbedEngine> | null = null

function getEngine(): Promise<EmbedEngine> {
  if (!enginePromise) {
    enginePromise = createPdfiumDirectEngine(PdfiumWasm as string, {})
  }
  return enginePromise
}

function arrayBufferFromSource(source: ArrayBuffer | string): Promise<ArrayBuffer> {
  if (typeof source === 'string') {
    return fetch(source, { credentials: 'include' }).then((r) => r.arrayBuffer())
  }
  return Promise.resolve(source)
}

// Draw a raw ImageDataLike payload onto the caller's HTMLCanvasElement. Resizes
// the canvas to the raw image dimensions first. The source pixel format from
// PDFium via @embedpdf is standard RGBA, same as ImageData — no channel swap.
function blitImageData(
  canvas: HTMLCanvasElement,
  raw: { data: Uint8ClampedArray; width: number; height: number },
): void {
  canvas.width = raw.width
  canvas.height = raw.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  // Re-pack into a Uint8ClampedArray with an owned ArrayBuffer so the ImageData
  // constructor's stricter typings accept it (the source may be backed by a
  // SharedArrayBuffer-like in some runtimes).
  const buf = new Uint8ClampedArray(raw.data.length)
  buf.set(raw.data)
  const imageData = new ImageData(buf, raw.width, raw.height)
  ctx.putImageData(imageData, 0, 0)
}

export const embedpdfRenderer: PdfRenderer = {
  name: 'embedpdf',
  async load(source): Promise<PdfDocument> {
    const engine = await getEngine()
    const buffer = await arrayBufferFromSource(source)
    const file = { id: `sitelayer-${String(buffer.byteLength)}`, content: buffer }
    const doc: PdfDocumentObject = await engine.openDocumentBuffer(file).toPromise()
    const pages = doc.pages

    const pageByNumber = (pageNumber: number): PdfPageObject | null => {
      const index = pageNumber - 1
      if (index < 0 || index >= pages.length) return null
      return pages[index] ?? null
    }

    // Region rendering is optional on the engine surface — older/leaner builds
    // may not ship renderPageRectRaw. Detect it once so the tiled renderer can
    // fall back to whole-page rendering when it's missing.
    const supportsRectRaw = typeof (engine as { renderPageRectRaw?: unknown }).renderPageRectRaw === 'function'

    return {
      numPages: doc.pageCount,

      async getPageSize(pageNumber) {
        const page = pageByNumber(pageNumber)
        if (!page) throw new Error(`page ${pageNumber} out of range`)
        return { width: page.size.width, height: page.size.height }
      },

      renderPage(opts: PageRenderOptions): RenderHandle {
        let cancelled = false
        let abortFn: (() => void) | null = null

        const promise = (async () => {
          const page = pageByNumber(opts.pageNumber)
          if (!page) throw new Error(`page ${opts.pageNumber} out of range`)
          if (cancelled) return

          const dpr = opts.devicePixelRatio ?? window.devicePixelRatio ?? 1
          const task = engine.renderPageRaw(doc, page, { scaleFactor: opts.scale, dpr })
          abortFn = () => {
            try {
              task.abort({ code: 7, message: 'cancelled' })
            } catch {
              // already-settled aborts are safe to ignore
            }
          }

          try {
            const raw = await task.toPromise()
            if (cancelled) return
            blitImageData(opts.canvas, raw)
          } catch (err) {
            if (cancelled) return
            const message = err instanceof Error ? err.message : String(err)
            // swallow abort-style errors — a cancellation is not a failure
            if (/abort|cancel/i.test(message)) return
            throw err
          }
        })()

        return {
          promise,
          cancel() {
            cancelled = true
            if (abortFn) abortFn()
          },
        }
      },

      // Region render: only attached when the engine build exposes
      // renderPageRectRaw (feature-detected below). The tiled renderer calls
      // this per tile so each canvas stays under the iOS canvas-area cap;
      // callers feature-detect via `typeof doc.renderPageRect === 'function'`.
      ...(supportsRectRaw
        ? {
            renderPageRect(opts: PageRectRenderOptions): RenderHandle {
              let cancelled = false
              let abortFn: (() => void) | null = null

              const promise = (async () => {
                const page = pageByNumber(opts.pageNumber)
                if (!page) throw new Error(`page ${opts.pageNumber} out of range`)
                if (cancelled) return

                const dpr = opts.devicePixelRatio ?? window.devicePixelRatio ?? 1
                // Engine rect is page-space points: origin top-left, size in
                // points. wDev = round(size.width * scaleFactor * dpr).
                const rect = {
                  origin: { x: opts.rect.x, y: opts.rect.y },
                  size: { width: opts.rect.width, height: opts.rect.height },
                }
                const task = engine.renderPageRectRaw(doc, page, rect, { scaleFactor: opts.scale, dpr })
                abortFn = () => {
                  try {
                    task.abort({ code: 7, message: 'cancelled' })
                  } catch {
                    // already-settled aborts are safe to ignore
                  }
                }

                try {
                  const raw = await task.toPromise()
                  if (cancelled) return
                  blitImageData(opts.canvas, raw)
                } catch (err) {
                  if (cancelled) return
                  const message = err instanceof Error ? err.message : String(err)
                  // swallow abort-style errors — a cancellation is not a failure
                  if (/abort|cancel/i.test(message)) return
                  throw err
                }
              })()

              return {
                promise,
                cancel() {
                  cancelled = true
                  if (abortFn) abortFn()
                },
              }
            },
          }
        : {}),

      async getPageText(pageNumber) {
        const page = pageByNumber(pageNumber)
        if (!page) return ''
        try {
          return await engine.extractText(doc, [page.index]).toPromise()
        } catch {
          return ''
        }
      },

      async getBookmarks() {
        try {
          const bookmarks = await engine.getBookmarks(doc).toPromise()
          return flattenBookmarks(bookmarks.bookmarks)
        } catch {
          return []
        }
      },

      renderTextLayer(opts: TextLayerOptions): RenderHandle {
        let cancelled = false
        let abortFn: (() => void) | null = null
        const container = opts.container

        const promise = (async () => {
          const page = pageByNumber(opts.pageNumber)
          if (!page) return

          const task = engine.getPageTextRuns(doc, page)
          abortFn = () => {
            try {
              task.abort({ code: 7, message: 'cancelled' })
            } catch {
              // already-settled aborts are safe to ignore
            }
          }

          let textRuns: PdfTextRun[]
          try {
            const result = await task.toPromise()
            if (cancelled) return
            textRuns = result.runs
          } catch (err) {
            if (cancelled) return
            const message = err instanceof Error ? err.message : String(err)
            if (/abort|cancel/i.test(message)) return
            throw err
          }

          // Clear any previous content and prep the overlay for positioned text
          // spans. The container receives the full display size from the caller
          // (via width/height style); spans are in CSS pixels at the scale.
          container.innerHTML = ''
          container.style.position = 'absolute'
          container.style.inset = '0'
          container.style.pointerEvents = 'auto'
          container.style.overflow = 'hidden'
          container.style.lineHeight = '1'

          const s = opts.scale
          const pageWidthPts = page.size.width
          const pageHeightPts = page.size.height

          const fragment = document.createDocumentFragment()
          const tunedSpans: Array<{ el: HTMLSpanElement; targetWidth: number }> = []
          for (const run of textRuns) {
            if (!run.text) continue
            const rect = run.rect
            const originX = rect.origin?.x ?? 0
            const originY = rect.origin?.y ?? 0
            const rectW = rect.size?.width ?? 0
            const rectH = rect.size?.height ?? 0
            if (rectW <= 0 || rectH <= 0) continue

            // Guard against runs whose coords are outside the page box; PDFium
            // occasionally emits bogus geometry for rotated text.
            if (originX > pageWidthPts + 5 || originY > pageHeightPts + 5) continue

            const span = document.createElement('span')
            span.textContent = run.text
            span.style.position = 'absolute'
            span.style.left = `${originX * s}px`
            span.style.top = `${originY * s}px`
            span.style.height = `${rectH * s}px`
            span.style.fontSize = `${Math.max(1, rectH * s)}px`
            span.style.color = 'transparent'
            span.style.whiteSpace = 'pre'
            span.style.transformOrigin = '0 0'
            span.style.userSelect = 'text'
            span.style.lineHeight = '1'
            fragment.appendChild(span)
            tunedSpans.push({ el: span, targetWidth: rectW * s })
          }
          if (cancelled) return
          container.appendChild(fragment)

          // Second pass: x-scale each span so its rendered width matches the
          // PDF-reported run width (keeps text selection aligned with glyphs
          // when substitution fonts differ from the embedded ones).
          for (const { el, targetWidth } of tunedSpans) {
            const naturalWidth = el.offsetWidth
            if (naturalWidth > 0 && targetWidth > 0) {
              const ratio = targetWidth / naturalWidth
              if (ratio > 0.2 && ratio < 5) {
                el.style.transform = `scaleX(${ratio})`
              }
            }
          }
        })()

        return {
          promise,
          cancel() {
            cancelled = true
            if (abortFn) abortFn()
          },
        }
      },

      search(query: string): PdfSearchHandle {
        const progressCbs: Array<(hits: PdfSearchHit[]) => void> = []
        let cancelled = false
        let abortFn: (() => void) | null = null

        const done = (async () => {
          if (!query) return
          const task = engine.searchAllPages(doc, query)
          abortFn = () => {
            try {
              task.abort({ code: 7, message: 'cancelled' })
            } catch {
              // already-settled aborts are safe to ignore
            }
          }
          task.onProgress((p) => {
            if (cancelled) return
            const hits: PdfSearchHit[] = p.results.map((r) => ({
              pageNumber: r.pageIndex + 1,
              before: r.context.before,
              match: r.context.match,
              after: r.context.after,
              rects: r.rects.map((rect) => ({
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.size.width,
                height: rect.size.height,
              })),
            }))
            if (hits.length === 0) return
            for (const cb of progressCbs) cb(hits)
          })
          try {
            await task.toPromise()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (/abort|cancel/i.test(message)) return
            throw err
          }
        })()

        return {
          onProgress(cb) {
            progressCbs.push(cb)
          },
          done,
          cancel() {
            cancelled = true
            if (abortFn) abortFn()
          },
        }
      },

      async destroy() {
        try {
          await engine.closeDocument(doc).toPromise()
        } catch {
          // closing a doc after engine shutdown is benign
        }
      },
    }
  },
}
