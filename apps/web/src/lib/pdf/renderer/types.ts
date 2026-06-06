// PDF renderer interface (ported from qedviz client/src/features/pdf-reader/
// renderer/types.ts). Engine-agnostic contract the takeoff drawing surface
// renders against; the active engine is PDFium via @embedpdf (see ./embedpdf).

export interface PageRenderOptions {
  pageNumber: number
  canvas: HTMLCanvasElement
  scale: number
  devicePixelRatio?: number
}

/**
 * Render a single page-space sub-rect of a page (units = PDF points, origin
 * top-left) into the supplied canvas. Used by the tiled renderer so a large
 * architectural sheet renders as a grid of small canvases, each staying under
 * the iOS/Safari canvas-area cap. The canvas is resized to the rect's pixel
 * dimensions (`round(rect.width * scale * dpr)` x `round(rect.height * scale *
 * dpr)`), matching the whole-page `renderPage` blit contract.
 */
export interface PageRectRenderOptions {
  pageNumber: number
  canvas: HTMLCanvasElement
  /** Sub-rect of the page to render, in PDF points (top-left origin). */
  rect: PdfPageRect
  /** css-px per PDF point (before device-pixel-ratio). */
  scale: number
  devicePixelRatio?: number
}

export interface TextLayerOptions {
  pageNumber: number
  container: HTMLElement
  scale: number
}

export interface RenderHandle {
  promise: Promise<void>
  cancel(): void
}

export interface PdfBookmark {
  /** Outline entry label. */
  title: string
  /**
   * 1-indexed page number this bookmark jumps to. Null for entries that
   * don't resolve to a concrete destination (e.g. URL actions or
   * actions we can't route).
   */
  pageNumber: number | null
  /** Nested entries (chapter sections under a chapter root, etc). */
  children?: PdfBookmark[]
}

/** Page-space rectangle: origin top-left, units = PDF points. */
export interface PdfPageRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfSearchHit {
  /** 1-indexed page number. */
  pageNumber: number
  /** Words leading up to the match (no ellipsis). */
  before: string
  /** The matched text, case preserved. */
  match: string
  /** Words following the match. */
  after: string
  /** Match rects on the page, in PDF points (top-left origin). */
  rects: PdfPageRect[]
}

export interface PdfSearchHandle {
  /** Called with each batch of hits from one page as progress streams in. */
  onProgress(cb: (hits: PdfSearchHit[]) => void): void
  /** Resolves once the full document has been searched. */
  done: Promise<void>
  cancel(): void
}

export interface PdfDocument {
  numPages: number
  renderPage(opts: PageRenderOptions): RenderHandle
  /**
   * Render one page-space sub-rect into a canvas (tile rendering). Optional:
   * present only on engine builds that expose region rendering. Callers must
   * feature-detect (`typeof doc.renderPageRect === 'function'`) and fall back
   * to whole-page `renderPage` when absent.
   */
  renderPageRect?(opts: PageRectRenderOptions): RenderHandle
  renderTextLayer?(opts: TextLayerOptions): RenderHandle
  getPageSize(pageNumber: number): Promise<{ width: number; height: number }>
  getPageText?(pageNumber: number): Promise<string>
  /** Returns the PDF's table-of-contents tree. Empty when absent. */
  getBookmarks?(): Promise<PdfBookmark[]>
  /** Streams search hits across the entire document. */
  search?(query: string): PdfSearchHandle
  destroy(): Promise<void>
}

export interface PdfRenderer {
  readonly name: string
  load(source: ArrayBuffer | string): Promise<PdfDocument>
}
