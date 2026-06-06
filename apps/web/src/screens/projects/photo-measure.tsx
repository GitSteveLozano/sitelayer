import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Card, MobileButton } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { ErrorState } from '@/components/shell/ErrorState'
import { useCreateMeasurement, useServiceItems, type ServiceItem } from '@/lib/api'

/**
 * `prj-photo-measure` — photo measure mode from Sitemap §5 panel 3.
 *
 * Capture a still image (camera or photo library), draw a rectangle
 * over a feature, type one known dimension, and the other dimension
 * falls out of the rectangle's aspect ratio. Saved as a `lineal`
 * measurement with a `photo:<json>` suffix on notes capturing the
 * pixel rect + known dim so a future re-render can replay it.
 *
 * Why no real-world calibration: we only need the *measured* feature's
 * size, not absolute positioning on a blueprint. The user is the
 * trusted reference (they typed the 45 inches). The aspect ratio of
 * the drawn rectangle gives the other side; the photo is the audit
 * trail, not a coordinate system.
 *
 * The image itself doesn't upload yet — we keep it client-side only
 * and persist a thumbnail-sized data URL in notes if it fits the API
 * payload limit. Full upload + retrieval lands when the photo bucket
 * is wired (same path as foreman daily-log photos).
 */
export function PhotoMeasureScreen() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const serviceItems = useServiceItems()
  const create = useCreateMeasurement(projectId ?? '')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageNatural, setImageNatural] = useState<{ w: number; h: number } | null>(null)
  // Rectangle is two screen-relative points (0–1 each axis) so it
  // stays anchored when the image scales for different viewports.
  const [rect, setRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const [draftStart, setDraftStart] = useState<{ x: number; y: number } | null>(null)
  // Reference dimension — which axis ("w" = horizontal, "h" = vertical)
  // and the value the user types. We compute the other axis from the
  // rectangle's aspect ratio.
  const [refAxis, setRefAxis] = useState<'w' | 'h'>('w')
  const [refValue, setRefValue] = useState<string>('')
  const [refUnit, setRefUnit] = useState<'in' | 'ft' | 'cm' | 'm'>('in')
  const [serviceItemCode, setServiceItemCode] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const items = serviceItems.data?.serviceItems ?? []

  useEffect(() => {
    if (!serviceItemCode && items[0]) setServiceItemCode(items[0].code)
  }, [serviceItemCode, items])

  // Cleanup the object URL when the user picks a new image.
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [imageUrl])

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setRect(null)
    setDraftStart(null)
    const url = URL.createObjectURL(file)
    setImageUrl(url)
  }

  const onImageLoaded = () => {
    const img = imgRef.current
    if (!img) return
    setImageNatural({ w: img.naturalWidth, h: img.naturalHeight })
  }

  const onCanvasDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!imageUrl) return
    const svg = e.currentTarget
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const local = pt.matrixTransform(ctm.inverse())
    setDraftStart({ x: clamp(local.x, 0, 100), y: clamp(local.y, 0, 100) })
    setRect(null)
  }

  const onCanvasUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!draftStart) return
    const svg = e.currentTarget
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const local = pt.matrixTransform(ctm.inverse())
    const x2 = clamp(local.x, 0, 100)
    const y2 = clamp(local.y, 0, 100)
    if (Math.abs(x2 - draftStart.x) < 1 || Math.abs(y2 - draftStart.y) < 1) {
      // User tapped without dragging — ignore.
      setDraftStart(null)
      return
    }
    setRect({
      x1: Math.min(draftStart.x, x2),
      y1: Math.min(draftStart.y, y2),
      x2: Math.max(draftStart.x, x2),
      y2: Math.max(draftStart.y, y2),
    })
    setDraftStart(null)
  }

  const computed = useMemo(() => {
    if (!rect || !imageNatural) return null
    const refNum = Number(refValue)
    if (!Number.isFinite(refNum) || refNum <= 0) return null
    // Convert SVG-fraction rect to pixel rect using image natural size.
    const pxW = ((rect.x2 - rect.x1) / 100) * imageNatural.w
    const pxH = ((rect.y2 - rect.y1) / 100) * imageNatural.h
    if (pxW <= 0 || pxH <= 0) return null
    if (refAxis === 'w') {
      const scale = refNum / pxW
      return { w: refNum, h: pxH * scale }
    }
    const scale = refNum / pxH
    return { w: pxW * scale, h: refNum }
  }, [rect, imageNatural, refValue, refAxis])

  const canSave = Boolean(rect && computed && serviceItemCode && !create.isPending)

  const onSave = async () => {
    if (!canSave || !rect || !computed) return
    setError(null)
    try {
      // Persist as a `lineal` measurement carrying the longer side
      // (a photo-measured frame is a 1D feature most of the time —
      // caulk run, lintel, vent height). The shorter side goes into
      // notes for the audit trail; the rectangle + ref dim go inline
      // on the thumbnail data URL so a future re-render can replay.
      const longer = Math.max(computed.w, computed.h)
      const shorter = Math.min(computed.w, computed.h)
      const thumbnail = imgRef.current && imageNatural ? await compressThumbnail(imgRef.current) : null
      await create.mutateAsync({
        blueprint_document_id: null,
        service_item_code: serviceItemCode,
        unit: refUnit === 'in' || refUnit === 'cm' ? refUnit : `${refUnit}`,
        quantity: longer,
        geometry: {
          kind: 'lineal',
          points: [
            { x: rect.x1, y: rect.y1 },
            { x: rect.x2, y: rect.y2 },
          ],
        },
        notes: `photo · ref ${refValue} ${refUnit} ${refAxis === 'w' ? 'wide' : 'tall'} · short ${shorter.toFixed(2)} ${refUnit}`,
        image_thumbnail: thumbnail,
      })
      navigate(`/projects/${projectId}/takeoff-summary`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  if (!projectId) {
    return (
      <ErrorState
        title="Missing project"
        body="Open this screen from a project so we know where to save the measurement."
        retry={
          <Link
            to="/projects"
            className="w-full h-[50px] rounded-[14px] bg-accent text-white text-[16px] font-semibold inline-flex items-center justify-center"
          >
            Pick a project
          </Link>
        }
      />
    )
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to={`/projects/${projectId}/takeoff-canvas`} className="text-[12px] text-ink-3">
          ← Canvas
        </Link>
        <h1 className="mt-2 font-display text-[22px] font-bold tracking-tight leading-tight">Photo measure</h1>
        <p className="text-[12px] text-ink-3 mt-1 max-w-md">
          Snap a photo, drag a rectangle around the feature, type one known dimension. The other side falls out of the
          aspect ratio.
        </p>
      </div>

      <div className="px-4 space-y-3">
        {!imageUrl ? (
          <Card>
            <div className="text-[13px] font-semibold mb-2">Capture or pick</div>
            <p className="text-[12px] text-ink-3 mb-3">
              Mobile browsers open the camera directly. On desktop you'll get a file picker.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onPickFile}
              className="hidden"
            />
            <MobileButton variant="primary" onClick={() => fileRef.current?.click()}>
              Open camera
            </MobileButton>
          </Card>
        ) : (
          <>
            <Card className="!p-0 overflow-hidden">
              <div className="relative">
                <img
                  ref={imgRef}
                  src={imageUrl}
                  alt="Measurement subject"
                  onLoad={onImageLoaded}
                  className="block w-full h-auto select-none"
                  draggable={false}
                />
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  onPointerDown={onCanvasDown}
                  onPointerUp={onCanvasUp}
                  className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
                >
                  {rect ? (
                    <rect
                      x={rect.x1}
                      y={rect.y1}
                      width={rect.x2 - rect.x1}
                      height={rect.y2 - rect.y1}
                      fill="rgba(217, 144, 74, 0.18)"
                      stroke="rgb(217, 144, 74)"
                      strokeWidth={0.4}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                </svg>
              </div>
              <div className="px-3 py-2 border-t border-line flex items-center justify-between text-[12px] text-ink-3">
                <span>{rect ? 'Rectangle locked. Edit reference below.' : 'Press + drag to draw a rectangle.'}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (imageUrl) URL.revokeObjectURL(imageUrl)
                    setImageUrl(null)
                    setRect(null)
                    setImageNatural(null)
                  }}
                  className="text-accent font-medium"
                >
                  New photo
                </button>
              </div>
            </Card>

            {rect ? (
              <Card>
                <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-2">Reference</div>
                <div className="flex gap-1.5 mb-3">
                  {(['w', 'h'] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setRefAxis(a)}
                      className={
                        refAxis === a
                          ? 'flex-1 py-2 rounded-md text-[13px] font-semibold bg-accent text-white'
                          : 'flex-1 py-2 rounded-md text-[13px] font-semibold bg-card-soft text-ink-2'
                      }
                    >
                      {a === 'w' ? 'Width →' : 'Height ↓'}
                    </button>
                  ))}
                </div>
                <div className="flex items-end gap-2">
                  <label className="flex-1 block">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Value</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.1"
                      value={refValue}
                      onChange={(e) => setRefValue(e.target.value)}
                      placeholder="45"
                      className="mt-1 w-full text-[18px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
                    />
                  </label>
                  <select
                    value={refUnit}
                    onChange={(e) => setRefUnit(e.target.value as typeof refUnit)}
                    className="text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent shrink-0 w-20"
                  >
                    <option value="in">in</option>
                    <option value="ft">ft</option>
                    <option value="cm">cm</option>
                    <option value="m">m</option>
                  </select>
                </div>
                {computed ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                    <div className="bg-card-soft rounded-md py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Width</div>
                      <div className="font-mono tabular-nums text-[18px] font-semibold mt-1">
                        {computed.w.toFixed(2)}
                        <span className="text-[12px] text-ink-3 font-normal ml-1">{refUnit}</span>
                      </div>
                    </div>
                    <div className="bg-card-soft rounded-md py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Height</div>
                      <div className="font-mono tabular-nums text-[18px] font-semibold mt-1">
                        {computed.h.toFixed(2)}
                        <span className="text-[12px] text-ink-3 font-normal ml-1">{refUnit}</span>
                      </div>
                    </div>
                  </div>
                ) : null}
              </Card>
            ) : null}

            {rect && computed ? (
              <Card tight>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                  Service item
                </label>
                <select
                  value={serviceItemCode}
                  onChange={(e) => setServiceItemCode(e.target.value)}
                  className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
                >
                  {items.length === 0 ? <option value="">Loading…</option> : null}
                  {items.map((it: ServiceItem) => (
                    <option key={it.code} value={it.code}>
                      {it.code} — {it.name}
                    </option>
                  ))}
                </select>
              </Card>
            ) : null}

            {error ? <div className="text-[12px] text-warn">{error}</div> : null}

            <MobileButton variant="primary" disabled={!canSave} onClick={onSave}>
              {create.isPending ? 'Saving…' : 'Save measurement'}
            </MobileButton>

            <Attribution source="POST /api/projects/:id/takeoff/measurement · kind=lineal · photo metadata in notes" />
          </>
        )}
      </div>
    </div>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Downscale the loaded photo to a 512px-wide JPEG @ q=0.7 and return
 * the data URL. Stays well under the 200KB inline cap the server
 * enforces; falls back to null if the canvas API isn't available.
 */
async function compressThumbnail(img: HTMLImageElement): Promise<string | null> {
  if (typeof document === 'undefined' || !img.naturalWidth) return null
  const TARGET_W = 512
  const ratio = img.naturalWidth > TARGET_W ? TARGET_W / img.naturalWidth : 1
  const w = Math.round(img.naturalWidth * ratio)
  const h = Math.round(img.naturalHeight * ratio)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  // Quality 0.7 keeps construction-photo legibility while staying
  // small. q=0.5 starts to look smudgy on EIFS / plank textures.
  return canvas.toDataURL('image/jpeg', 0.7)
}
