import { type PointerEvent as ReactPointerEvent } from 'react'
import { type TakeoffPoint } from '@sitelayer/domain'
import { type TakeoffMeasurement } from '@/lib/api'

export type Tool = 'polygon' | 'rect' | 'lineal' | 'arc' | 'count'

// Canvas interaction modes layered over the drawing surface (ported from
// Steve's Desktop v2 mockup `DCanvasScale` / `DCanvasItemPalette` /
// `DCanvasEditMeasure` / `DCanvasBulkSelect` in /tmp/steve3/04_app.js).
//   draw   — default; tap to add points to a draft measurement.
//   scale  — calibrate the sheet scale from a drawn reference line.
//   select — marquee / multi-select committed measurements for bulk actions.
export type CanvasMode = 'draw' | 'scale' | 'select' | 'ai-count' | 'ai-takeoff'

// Cross-sheet callout (dsg__50 "EST CANVAS · CROSS-SHEET REF JUMP"). A detail
// callout (e.g. "B3") drawn on one sheet references a detail on another. The
// extraction pipeline that would emit { page_id, tag, target_page_idx, x, y }
// rows does not exist yet, so the callout POSITIONS + targets are
// presentational — but the sheet list they jump BETWEEN is the REAL page list,
// so clicking one genuinely opens the referenced page (same honest GAP as the
// shipped mobile cross-link `takeoff-cross-link.tsx`).
export type SheetCallout = {
  tag: string
  /** board-space (0–100) position of the callout circle on the source sheet */
  x: number
  y: number
  detail: string
  /** index into the real page list this callout jumps to (clamped at render) */
  targetPageIdx: number
}

export type MobileTool = 'polygon' | 'lineal' | 'count'
export type MobileMode = 'manual' | 'draw'

export interface MobileCanvasSurfaceProps {
  svgRef: React.RefObject<SVGSVGElement | null>
  tool: MobileTool
  deduct: boolean
  onTap: (e: ReactPointerEvent<SVGSVGElement>) => void
  draftPoints: TakeoffPoint[]
  measurements: TakeoffMeasurement[]
  selectedId: string | null
  /** When non-null the canvas is in bulk-select mode; these ids are highlighted. */
  bulkIds: Set<string> | null
  onSelectMeasurement: (id: string) => void
  /** Render slot for the page underlay behind the SVG — a PdfPageCanvas (PDFium)
   *  for PDF blueprints, an <img> for raster, or null for the bare grid. */
  underlay?: React.ReactNode
  /** EDIT GEOM (msg22): the measurement currently in vertex-drag edit, its live
   *  working points, the index of the handle being dragged, and the move sink. */
  editId: string | null
  editPoints: TakeoffPoint[]
  editDragIdxRef: React.MutableRefObject<number | null>
  onEditPoint: (idx: number, p: TakeoffPoint) => void
}

// MobileScopeTotal removed — the mobile body now uses the canonical ScopeTotal
// from lib/takeoff/canvas-totals (identical shape, signed by is_deduction).
