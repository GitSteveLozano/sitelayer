// React binding for the PDFium renderer (apps/web/src/lib/pdf/renderer). This
// is the layer the desktop takeoff canvas will render a plan-set page through —
// crisp vector zoom from PDFium replacing the server-rasterized image, with the
// SVG measurement overlay sitting on top of the returned <canvas>.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { loadPdfDocument, type PdfDocument } from './renderer'

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

/**
 * Render a single PDF page to an owned `<canvas>` via PDFium. Re-renders when
 * the page or scale changes; cancels an in-flight render on change/unmount.
 */
export function PdfPageCanvas({ doc, pageNumber, scale, className, style, onError }: PdfPageCanvasProps) {
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
        const MAX_SIDE = 4096
        const fit = Math.min(MAX_SIDE / size.width, MAX_SIDE / size.height)
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
