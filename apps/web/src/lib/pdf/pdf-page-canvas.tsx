// React binding for the PDFium renderer (apps/web/src/lib/pdf/renderer). This
// is the layer the desktop takeoff canvas renders a plan-set page through —
// crisp vector zoom from PDFium replacing the server-rasterized image, with the
// SVG measurement overlay sitting on top of the returned canvas.
//
// Two render paths, chosen by page size + effective scale (see PdfPageCanvas):
//
//   - Single-canvas (fast path): a normal page at a modest scale rasterizes to
//     ONE <canvas> carrying the caller's exact style — identical to the
//     historical behavior.
//   - Tiled: a large architectural sheet (or any page whose full raster would
//     blow the iOS/Safari ~16.78M-px canvas-AREA cap) renders as a low-res base
//     layer plus a grid of hi-res tile canvases. Each tile stays under the cap,
//     so the page is crisp on deep zoom AND never white-screens iOS. Requires
//     the engine's optional renderPageRect; if absent we fall back to the
//     clamped single-canvas path so nothing breaks.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { loadPdfDocument, type PdfDocument } from './renderer'
import { baseLayerScale, buildTileGrid, fitsSingleCanvas, MAX_CANVAS_SIDE, type PageSize, type Tile } from './tiling'

/**
 * Load a PDF document once per `source` (a credentialed URL to the PDF bytes,
 * or an ArrayBuffer). The doc is destroyed on source change / unmount so the
 * PDFium document handle never leaks. Returns `null` doc while loading or when
 * `source` is null.
 */
export function usePdfDocument(source: ArrayBuffer | string | null): {
  doc: PdfDocument | null
  error: Error | null
  loading: boolean
} {
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!source) {
      setDoc(null)
      setError(null)
      setLoading(false)
      return
    }
    let disposed = false
    let loaded: PdfDocument | null = null
    setLoading(true)
    setError(null)
    setDoc(null)
    loadPdfDocument(source)
      .then((d) => {
        if (disposed) {
          void d.destroy()
          return
        }
        loaded = d
        setDoc(d)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (disposed) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setLoading(false)
      })
    return () => {
      disposed = true
      void loaded?.destroy()
    }
  }, [source])

  return { doc, error, loading }
}

export interface PdfPageCanvasProps {
  doc: PdfDocument
  pageNumber: number
  /** Render scale in CSS px per PDF point (before device-pixel-ratio). */
  scale: number
  className?: string
  style?: CSSProperties
  onError?: (err: Error) => void
}

function devicePixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1
}

/**
 * Single-canvas render: rasterize the whole page to one canvas, clamping the
 * effective scale so neither side exceeds MAX_CANVAS_SIDE. This is the original
 * behavior, kept verbatim as the fast path and the no-region-support fallback.
 * The caller's style (incl. objectFit) is applied directly to the canvas.
 */
function SingleCanvasPage({ doc, pageNumber, scale, className, style, onError }: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let handle: { promise: Promise<void>; cancel(): void } | null = null
    void (async () => {
      // Clamp the effective render scale by page size so a large sheet (e.g. a
      // 34x22" plan) at high zoom can't allocate a multi-hundred-MB canvas or
      // exceed the browser's max canvas dimension. ~4096px/side keeps it safe
      // while still far crisper than the rasterized PNG.
      let effectiveScale = scale
      try {
        const size = await doc.getPageSize(pageNumber)
        if (cancelled) return
        const fit = Math.min(MAX_CANVAS_SIDE / size.width, MAX_CANVAS_SIDE / size.height)
        effectiveScale = Math.max(1, Math.min(scale, fit))
      } catch {
        // fall back to the requested scale if the size lookup fails
      }
      const live = canvasRef.current
      if (cancelled || !live) return
      handle = doc.renderPage({ pageNumber, canvas: live, scale: effectiveScale })
      void handle.promise.catch((err: unknown) => {
        if (!cancelled) onError?.(err instanceof Error ? err : new Error(String(err)))
      })
    })()
    return () => {
      cancelled = true
      handle?.cancel()
    }
  }, [doc, pageNumber, scale, onError])

  return <canvas ref={canvasRef} className={className} style={style} />
}

/** The page-area rectangle inside `box` for a given objectFit mode. `contain`
 * letterboxes to the page aspect ratio; everything else fills the box (matches
 * `fill`, the other value the callers use). */
function contentBox(
  box: { width: number; height: number },
  page: PageSize,
  objectFit: CSSProperties['objectFit'],
): { left: number; top: number; width: number; height: number } {
  if (objectFit === 'contain') {
    const pageAspect = page.width / page.height
    const boxAspect = box.width / box.height
    if (boxAspect > pageAspect) {
      // Box is wider than the page: letterbox left/right.
      const width = box.height * pageAspect
      return { left: (box.width - width) / 2, top: 0, width, height: box.height }
    }
    // Box is taller than the page: letterbox top/bottom.
    const height = box.width / pageAspect
    return { left: 0, top: (box.height - height) / 2, width: box.width, height }
  }
  return { left: 0, top: 0, width: box.width, height: box.height }
}

/** One tile canvas. Renders its page-space rect via doc.renderPageRect and
 * positions itself by percentage within the content box. Keyed by col/row +
 * scale so a scale change remounts (new pixel dims). */
function TileCanvas({
  doc,
  pageNumber,
  tile,
  page,
  scale,
  dpr,
  onError,
}: {
  doc: PdfDocument
  pageNumber: number
  tile: Tile
  page: PageSize
  scale: number
  dpr: number
  onError?: ((err: Error) => void) | undefined
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const live = canvasRef.current
    if (!live || !doc.renderPageRect) return
    let cancelled = false
    const handle = doc.renderPageRect({ pageNumber, canvas: live, rect: tile.rect, scale, devicePixelRatio: dpr })
    void handle.promise.catch((err: unknown) => {
      if (!cancelled) onError?.(err instanceof Error ? err : new Error(String(err)))
    })
    return () => {
      cancelled = true
      handle.cancel()
    }
  }, [doc, pageNumber, tile, scale, dpr, onError])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        left: `${(tile.rect.x / page.width) * 100}%`,
        top: `${(tile.rect.y / page.height) * 100}%`,
        width: `${(tile.rect.width / page.width) * 100}%`,
        height: `${(tile.rect.height / page.height) * 100}%`,
        // Cover the percentage cell exactly; tiles abut edge-to-edge.
        objectFit: 'fill',
      }}
    />
  )
}

/**
 * Tiled render: a low-res base canvas (drawn immediately) plus a grid of
 * hi-res tile canvases composited over it. The wrapper carries the caller's
 * style (minus objectFit, which we reinterpret as layout); the inner content
 * layer is positioned to match where the page lands under the requested
 * objectFit, so this looks the same as the single-canvas path — just sharper.
 */
function TiledPage({
  doc,
  pageNumber,
  scale,
  page,
  className,
  style,
  onError,
}: PdfPageCanvasProps & { page: PageSize }) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)

  const dpr = devicePixelRatio()
  const objectFit = style?.objectFit
  const grid = buildTileGrid(page, scale, { dpr })

  // Track the wrapper's pixel box so the content layer can be placed under the
  // requested objectFit. ResizeObserver keeps it correct across layout changes.
  useLayoutEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      setBox({ width: rect.width, height: rect.height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Base layer: whole page at a cap-safe low scale, drawn once per page. Gives
  // an instant (if soft) image under the hi-res tiles so there's never a blank
  // sheet while tiles stream in.
  useEffect(() => {
    const canvas = baseCanvasRef.current
    if (!canvas) return
    let cancelled = false
    const base = baseLayerScale(page, scale, dpr)
    const handle = doc.renderPage({ pageNumber, canvas, scale: base, devicePixelRatio: dpr })
    void handle.promise.catch((err: unknown) => {
      if (!cancelled) onError?.(err instanceof Error ? err : new Error(String(err)))
    })
    return () => {
      cancelled = true
      handle.cancel()
    }
  }, [doc, pageNumber, page, scale, dpr, onError])

  // Strip objectFit out of the wrapper style — it's a no-op on a div and we
  // reinterpret it as content-box layout below.
  const { objectFit: _omitObjectFit, ...wrapperStyle } = style ?? {}
  void _omitObjectFit

  const content = box ? contentBox(box, page, objectFit) : null

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{ ...wrapperStyle, position: wrapperStyle.position ?? 'relative' }}
    >
      {content ? (
        <div
          style={{
            position: 'absolute',
            left: content.left,
            top: content.top,
            width: content.width,
            height: content.height,
          }}
        >
          {/* Low-res base fills the content box exactly. */}
          <canvas
            ref={baseCanvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill' }}
          />
          {/* Hi-res tiles composite over the base. Remount on scale change via
              the scale in the key so stale-resolution canvases are dropped. */}
          {grid.tiles.map((tile) => (
            <TileCanvas
              key={`${String(pageNumber)}:${String(grid.scale)}:${String(tile.col)}:${String(tile.row)}`}
              doc={doc}
              pageNumber={pageNumber}
              tile={tile}
              page={page}
              scale={grid.scale}
              dpr={grid.dpr}
              onError={onError}
            />
          ))}
        </div>
      ) : (
        // Pre-measure: render just the base canvas filling the wrapper so the
        // page is visible on the first paint, before the content box is known.
        <canvas
          ref={baseCanvasRef}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: objectFit ?? 'fill' }}
        />
      )}
    </div>
  )
}

/**
 * Render a single PDF page via PDFium. Picks the single-canvas fast path when
 * the whole-page raster fits a safe canvas, otherwise tiles the page so a large
 * sheet stays crisp on deep zoom and never trips the iOS canvas-area cap.
 * Public prop API (doc / pageNumber / scale / className / style / onError) is
 * stable — callers are unaffected by which path runs.
 */
export function PdfPageCanvas(props: PdfPageCanvasProps) {
  const { doc, pageNumber, scale } = props
  const [page, setPage] = useState<PageSize | null>(null)

  useEffect(() => {
    let cancelled = false
    void doc
      .getPageSize(pageNumber)
      .then((size) => {
        if (!cancelled) setPage({ width: size.width, height: size.height })
      })
      .catch(() => {
        // Size lookup failed — leave page null so we use the single-canvas
        // path, which clamps defensively on its own.
        if (!cancelled) setPage(null)
      })
    return () => {
      cancelled = true
    }
  }, [doc, pageNumber])

  const dpr = devicePixelRatio()
  // Tile only when: we know the page size, the whole-page raster would exceed a
  // safe canvas, AND the engine build supports region rendering. Otherwise the
  // single-canvas path (which clamps to MAX_CANVAS_SIDE) keeps things working.
  const shouldTile = page !== null && typeof doc.renderPageRect === 'function' && !fitsSingleCanvas(page, scale, dpr)

  if (shouldTile && page) {
    return <TiledPage {...props} page={page} />
  }
  return <SingleCanvasPage {...props} />
}
