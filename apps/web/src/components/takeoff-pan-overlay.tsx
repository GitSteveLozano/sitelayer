import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button.js'

// Pan/drag overlay for the takeoff canvas. Mounted as a sibling of
// <TakeoffWorkspace /> so operations.tsx stays untouched. We reach into the
// rendered .takeoffStageWrap / .takeoffStage DOM, install listeners on the
// wrapper, and compose a translate() onto the existing scale() transform the
// workspace writes. The workspace's own pointer handlers continue to own
// polygon drawing; this overlay only activates on middle-click, space-hold
// drags, and two-finger touch.

type PanState = { x: number; y: number }

const PAN_STORAGE_KEY = 'sitelayer.takeoff.panReset'

function composeTransform(translate: PanState): string {
  // The workspace sets `transform: scale(X)` on .takeoffStage inline. We
  // wrap the parent .takeoffStageWrap so our translate doesn't fight with the
  // inline scale.
  return `translate(${translate.x}px, ${translate.y}px)`
}

export function TakeoffPanOverlay() {
  const [pan, setPan] = useState<PanState>({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const wrapRef = useRef<HTMLElement | null>(null)
  const dragOriginRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const activePointerRef = useRef<number | null>(null)
  const touchOriginRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  // Resolve the stage wrap once mounted. Poll briefly since the workspace may
  // render after us on initial project selection.
  useEffect(() => {
    let cancelled = false
    let attempts = 0
    function tryResolve() {
      if (cancelled) return
      const candidate = document.querySelector<HTMLElement>('.takeoffStageWrap')
      if (candidate) {
        wrapRef.current = candidate
        candidate.style.touchAction = 'none'
        candidate.style.cursor = 'grab'
        return
      }
      attempts += 1
      if (attempts < 20) {
        window.setTimeout(tryResolve, 150)
      }
    }
    tryResolve()
    return () => {
      cancelled = true
      if (wrapRef.current) {
        wrapRef.current.style.cursor = ''
        wrapRef.current.style.touchAction = ''
      }
    }
  }, [])

  // Apply the translate to the inner stage element. We compose on top of the
  // existing scale() transform the workspace sets; to avoid stomping, we
  // target the stageWrap instead (wrapper receives pan, inner keeps zoom).
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const stage = wrap.querySelector<HTMLElement>('.takeoffStage')
    if (!stage) return
    // Read existing inline transform (e.g. "scale(1.2)") and append translate.
    const existing = stage.dataset.panBase ?? stage.style.transform ?? ''
    if (!stage.dataset.panBase) {
      stage.dataset.panBase = existing
    }
    const base = stage.dataset.panBase ?? ''
    const scaleMatch = base.match(/scale\([^)]+\)/)
    const scalePart = scaleMatch ? scaleMatch[0] : 'scale(1)'
    stage.style.transform = `${composeTransform(pan)} ${scalePart}`
  }, [pan])

  // Track the Space key for keyboard-hold pan.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code === 'Space') {
        const target = event.target as HTMLElement | null
        if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
        if (!spaceHeld) setSpaceHeld(true)
        event.preventDefault()
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.code === 'Space') {
        setSpaceHeld(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [spaceHeld])

  // Pointer listeners on the wrapper. Middle-click starts a pan, or
  // left-click when space is held. We swallow the workspace's own pointer
  // capture by invoking stopPropagation on the events that start a pan.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    function onPointerDown(event: PointerEvent) {
      const shouldPan = event.button === 1 || (event.button === 0 && spaceHeld)
      if (!shouldPan) return
      event.preventDefault()
      event.stopPropagation()
      activePointerRef.current = event.pointerId
      dragOriginRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        panX: pan.x,
        panY: pan.y,
      }
      setPanning(true)
      if (wrap) {
        wrap.setPointerCapture(event.pointerId)
        wrap.style.cursor = 'grabbing'
      }
    }

    function onPointerMove(event: PointerEvent) {
      if (activePointerRef.current !== event.pointerId || !dragOriginRef.current) return
      const dx = event.clientX - dragOriginRef.current.startX
      const dy = event.clientY - dragOriginRef.current.startY
      setPan({ x: dragOriginRef.current.panX + dx, y: dragOriginRef.current.panY + dy })
    }

    function onPointerUp(event: PointerEvent) {
      if (activePointerRef.current !== event.pointerId) return
      activePointerRef.current = null
      dragOriginRef.current = null
      setPanning(false)
      if (wrap) {
        try {
          wrap.releasePointerCapture(event.pointerId)
        } catch {
          /* pointer capture may already be released */
        }
        wrap.style.cursor = spaceHeld ? 'grabbing' : 'grab'
      }
    }

    // Two-finger touch pan
    function onTouchStart(event: TouchEvent) {
      if (event.touches.length !== 2) return
      event.preventDefault()
      const [a, b] = [event.touches[0], event.touches[1]]
      if (!a || !b) return
      touchOriginRef.current = {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
        panX: pan.x,
        panY: pan.y,
      }
      setPanning(true)
    }

    function onTouchMove(event: TouchEvent) {
      if (event.touches.length !== 2 || !touchOriginRef.current) return
      event.preventDefault()
      const [a, b] = [event.touches[0], event.touches[1]]
      if (!a || !b) return
      const midX = (a.clientX + b.clientX) / 2
      const midY = (a.clientY + b.clientY) / 2
      setPan({
        x: touchOriginRef.current.panX + (midX - touchOriginRef.current.x),
        y: touchOriginRef.current.panY + (midY - touchOriginRef.current.y),
      })
    }

    function onTouchEnd() {
      touchOriginRef.current = null
      setPanning(false)
    }

    wrap.addEventListener('pointerdown', onPointerDown, true)
    wrap.addEventListener('pointermove', onPointerMove, true)
    wrap.addEventListener('pointerup', onPointerUp, true)
    wrap.addEventListener('pointercancel', onPointerUp, true)
    wrap.addEventListener('touchstart', onTouchStart, { passive: false })
    wrap.addEventListener('touchmove', onTouchMove, { passive: false })
    wrap.addEventListener('touchend', onTouchEnd)

    return () => {
      wrap.removeEventListener('pointerdown', onPointerDown, true)
      wrap.removeEventListener('pointermove', onPointerMove, true)
      wrap.removeEventListener('pointerup', onPointerUp, true)
      wrap.removeEventListener('pointercancel', onPointerUp, true)
      wrap.removeEventListener('touchstart', onTouchStart)
      wrap.removeEventListener('touchmove', onTouchMove)
      wrap.removeEventListener('touchend', onTouchEnd)
    }
  }, [pan.x, pan.y, spaceHeld])

  function fitToView() {
    setPan({ x: 0, y: 0 })
    try {
      window.localStorage.setItem(PAN_STORAGE_KEY, new Date().toISOString())
    } catch {
      /* optional telemetry */
    }
  }

  return (
    <div
      className="takeoffPanControls"
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '6px 0',
        fontSize: 12,
      }}
      data-testid="takeoff-pan-controls"
    >
      <Button type="button" variant="outline" size="sm" onClick={fitToView}>
        Fit to view
      </Button>
      <span className="muted">
        {panning
          ? 'Panning…'
          : spaceHeld
            ? 'Drag to pan'
            : 'Middle-click or hold Space + drag to pan · two-finger touch pans on mobile'}
      </span>
    </div>
  )
}
