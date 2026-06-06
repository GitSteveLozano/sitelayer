// PDF renderer entry point for the takeoff drawing surface. PDFium (EmbedPDF)
// is the only engine — pdfjs 4.x/5.x silently hang past page 1, so it is
// intentionally not used here (unlike qedviz, which kept a pdfjs escape hatch).
// The renderer is lazy-loaded so the PDFium WASM only downloads when a plan set
// is actually opened.

import type { PdfRenderer } from './types'

let pdfRendererPromise: Promise<PdfRenderer> | null = null

export function loadPdfRenderer(): Promise<PdfRenderer> {
  if (!pdfRendererPromise) {
    pdfRendererPromise = import('./embedpdf').then(({ embedpdfRenderer }) => embedpdfRenderer)
  }
  return pdfRendererPromise
}

export async function loadPdfDocument(source: ArrayBuffer | string) {
  const renderer = await loadPdfRenderer()
  return renderer.load(source)
}

export type {
  PageRectRenderOptions,
  PageRenderOptions,
  PdfBookmark,
  PdfDocument,
  PdfPageRect,
  PdfRenderer,
  PdfSearchHandle,
  PdfSearchHit,
  RenderHandle,
} from './types'
