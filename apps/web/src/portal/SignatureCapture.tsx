import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Canvas-based signature pad for the customer portal accept flow.
 *
 * - Mobile-first: pointer events cover touch + mouse.
 * - Outputs a PNG data URL on demand via `requestDataUrl()` exposed
 *   through the imperative ref.
 * - Pure light theme — no dark mode for the customer portal.
 */
export type SignatureCaptureProps = {
  onChange: (dataUrl: string | null) => void
  /** Optional explicit dimensions; defaults to a responsive 100% × 180. */
  height?: number
}

export function SignatureCapture({ onChange, height = 180 }: SignatureCaptureProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [hasInk, setHasInk] = useState(false)
  const drawing = useRef(false)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
  // Resize observer keeps the canvas backing store in sync with its
  // CSS box. Without this the strokes look pixelated on hi-dpi screens
  // and the ink is offset on rotation.
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    function resize() {
      const dpr = window.devicePixelRatio || 1
      const rect = container!.getBoundingClientRect()
      const w = Math.max(1, Math.floor(rect.width))
      const h = height
      canvas!.width = w * dpr
      canvas!.height = h * dpr
      canvas!.style.width = `${w}px`
      canvas!.style.height = `${h}px`
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.lineWidth = 2.2
      ctx!.lineCap = 'round'
      ctx!.lineJoin = 'round'
      ctx!.strokeStyle = '#0f172a'
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)
    return () => ro.disconnect()
  }, [height])

  function pointFromEvent(event: PointerEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function startStroke(event: PointerEvent) {
    const point = pointFromEvent(event)
    if (!point) return
    drawing.current = true
    lastPoint.current = point
    canvasRef.current?.setPointerCapture(event.pointerId)
  }

  function continueStroke(event: PointerEvent) {
    if (!drawing.current) return
    const ctx = canvasRef.current?.getContext('2d')
    const last = lastPoint.current
    const point = pointFromEvent(event)
    if (!ctx || !last || !point) return
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
    lastPoint.current = point
    if (!hasInk) setHasInk(true)
  }

  function endStroke(event: PointerEvent) {
    if (!drawing.current) return
    drawing.current = false
    lastPoint.current = null
    canvasRef.current?.releasePointerCapture(event.pointerId)
    const dataUrl = canvasRef.current?.toDataURL('image/png') ?? null
    if (dataUrl && hasInk) onChange(dataUrl)
  }

  function clearCanvas() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
    setHasInk(false)
    onChange(null)
  }

  // Combined pointer handler reduces hook noise vs. registering 4 useEffects.
  const pointerHandlers = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => startStroke(e.nativeEvent),
      onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => continueStroke(e.nativeEvent),
      onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => endStroke(e.nativeEvent),
      onPointerCancel: (e: React.PointerEvent<HTMLCanvasElement>) => endStroke(e.nativeEvent),
      onPointerLeave: (e: React.PointerEvent<HTMLCanvasElement>) => endStroke(e.nativeEvent),
    }),
    [],
  )

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          border: '1px solid var(--m-line, #e2e8f0)',
          borderRadius: 12,
          background: '#fff',
          touchAction: 'none',
        }}
      >
        <canvas
          ref={canvasRef}
          {...pointerHandlers}
          aria-label="Signature pad — sign with your finger or mouse"
          style={{ display: 'block', width: '100%', height, touchAction: 'none', cursor: 'crosshair' }}
        />
      </div>
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--m-ink-3, #64748b)' }}>
          {hasInk ? 'Signature captured.' : 'Sign above with your finger or mouse.'}
        </span>
        <button
          type="button"
          onClick={clearCanvas}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--m-accent, #2563eb)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Clear
        </button>
      </div>
    </div>
  )
}
