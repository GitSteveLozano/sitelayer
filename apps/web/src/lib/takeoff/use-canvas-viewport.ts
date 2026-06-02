// Shared pan/zoom/viewport capability layer for the takeoff drawing surface.
//
// Phase C of the responsive consolidation extracts the desktop est-canvas's
// PlanSwift-style navigation layer (cursor-anchored wheel zoom, drag-to-pan via
// middle/right button + Space-hold + a Hand tool, fit/reset) into one reusable
// hook so the single responsive canvas can turn it ON at the desktop capability
// and leave it OFF (the lightweight phone form factor) — a CAPABILITY split, not
// an input-model fork. The point-mapping math itself stays in `canvas-math.ts`
// (`screenToBoardPoint`) and is unaffected: the SVG `getScreenCTM()` folds in
// the CSS transform this hook drives, so a tap still maps to the correct 0–100
// board point at any zoom/pan.
//
// DATA + GEOMETRY remain reused verbatim; only the navigation chrome is shared
// here. When `enabled` is false the hook is inert (zoom 1, pan 0, no listeners)
// so the mobile surface's tap-to-add path is never touched.

import { useEffect, useRef, useState } from 'react'
import { clamp } from './canvas-math'

// Canvas zoom bounds (PlanSwift-style navigation), preserved from est-canvas.
export const MIN_ZOOM = 0.4
export const MAX_ZOOM = 12

export interface CanvasViewport {
  /** Live zoom factor (1 = fit). */
  zoom: number
  /** Live pan offset in container pixels. */
  pan: { x: number; y: number }
  /** Whether the Hand (pan) tool is toggled on. */
  handMode: boolean
  setHandMode: React.Dispatch<React.SetStateAction<boolean>>
  /** Whether Space is currently held (Figma-style temporary pan). */
  spaceHeld: boolean
  /** Whether a pan drag is in progress (drives the grab/grabbing cursor). */
  panning: boolean
  /** The scroll/zoom viewport element — attach to the clipping container. */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** Zoom by `factor` around the container center (button zoom). */
  zoomBy: (factor: number) => void
  /** Reset zoom + pan to the fitted view. */
  resetView: () => void
  /** Begin a pan drag from a pointer-down (returns true when it consumed it). */
  beginPan: (e: {
    button: number
    clientX: number
    clientY: number
    pointerId: number
    currentTarget: Element
  }) => boolean
  /** Continue an in-progress pan drag (no-op when not panning). Returns true when handled. */
  movePan: (clientX: number, clientY: number) => boolean
  /** End an in-progress pan drag. Returns true when one was active. */
  endPan: (e: { pointerId: number; currentTarget: Element }) => boolean
}

/**
 * The shared pan/zoom capability. Pass `enabled: false` for the lightweight
 * (phone) form factor — the hook stays inert and never attaches listeners.
 * `deps` re-runs the wheel listener attach (the desktop canvas passes the
 * loading flags so the listener (re)attaches once the container mounts).
 */
export function useCanvasViewport(enabled: boolean, deps: unknown[] = []): CanvasViewport {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [handMode, setHandMode] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)

  // Live mirrors so the wheel/keyboard listeners read current zoom/pan without
  // re-subscribing on every change (identical to the est-canvas behavior).
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])
  useEffect(() => {
    panRef.current = pan
  }, [pan])

  // Zoom by `factor` around a point (cx, cy) given in container pixels so the
  // content under that point stays put (cursor- or center-anchored).
  const applyZoom = (factor: number, cx: number, cy: number) => {
    const z = zoomRef.current
    const nz = clamp(z * factor, MIN_ZOOM, MAX_ZOOM)
    if (nz === z) return
    const p = panRef.current
    const ux = (cx - p.x) / z
    const uy = (cy - p.y) / z
    setZoom(nz)
    setPan({ x: cx - ux * nz, y: cy - uy * nz })
  }
  const zoomBy = (factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    applyZoom(factor, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2)
  }
  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // Non-passive wheel listener: preventDefault stops the PAGE from scrolling
  // (Steve's "scrolling issues") and zooms toward the cursor instead.
  useEffect(() => {
    if (!enabled) return
    const cont = containerRef.current
    if (!cont) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = cont.getBoundingClientRect()
      applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top)
    }
    cont.addEventListener('wheel', onWheel, { passive: false })
    return () => cont.removeEventListener('wheel', onWheel)
    // applyZoom reads live zoom/pan via refs, so those aren't deps; `deps` lets
    // the caller re-attach once the container mounts (loading early-return).
    // (react-hooks/exhaustive-deps is not enabled in this project.)
  }, [enabled, ...deps])

  // Hold Space to pan (Figma-style), but never while typing in an input.
  useEffect(() => {
    if (!enabled) return
    const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && /^(input|textarea|select)$/i.test(t.tagName)
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        e.preventDefault()
        setSpaceHeld(true)
      }
    }
    const ku = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    return () => {
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
    }
  }, [enabled])

  // Drag-to-pan: middle-button, RIGHT-button (PlanSwift-style drag-to-move the
  // plan), Space-hold, or the Hand tool. The pointer-capture + currentTarget are
  // handled here so the caller's pointer handlers stay focused on drawing.
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const beginPan: CanvasViewport['beginPan'] = (e) => {
    if (!enabled) return false
    if (!(e.button === 1 || e.button === 2 || spaceHeld || handMode)) return false
    e.currentTarget.setPointerCapture?.(e.pointerId)
    panStartRef.current = { x: e.clientX, y: e.clientY, panX: panRef.current.x, panY: panRef.current.y }
    setPanning(true)
    return true
  }
  const movePan: CanvasViewport['movePan'] = (clientX, clientY) => {
    const start = panStartRef.current
    if (!start) return false
    setPan({ x: start.panX + (clientX - start.x), y: start.panY + (clientY - start.y) })
    return true
  }
  const endPan: CanvasViewport['endPan'] = (e) => {
    if (!panStartRef.current) return false
    panStartRef.current = null
    setPanning(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    return true
  }

  return {
    zoom: enabled ? zoom : 1,
    pan: enabled ? pan : { x: 0, y: 0 },
    handMode,
    setHandMode,
    spaceHeld,
    panning,
    containerRef,
    zoomBy,
    resetView,
    beginPan,
    movePan,
    endPan,
  }
}
