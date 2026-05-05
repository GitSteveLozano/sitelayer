import { useEffect, useRef, useState } from 'react'
import { MobileButton, Pill, Sheet } from '@/components/mobile'

/**
 * Camera-driven barcode + QR scanner. Uses the browser's
 * `BarcodeDetector` API where available (Chrome / Edge / Android,
 * recent Safari) and falls back to "not supported" messaging
 * elsewhere — at which point the parent screen's manual code-entry
 * field is the only path. This is the design's intent: degrade
 * gracefully, never block the worker.
 *
 * Camera permission is requested lazily (on Sheet open) so users
 * who never tap the camera button never get prompted.
 */

// Minimal local types — TS lib doesn't ship BarcodeDetector globally.
interface BarcodeDetectorOptions {
  formats?: string[]
}
interface DetectedBarcode {
  rawValue: string
  format: string
}
interface BarcodeDetectorLike {
  detect: (source: HTMLVideoElement | ImageBitmap) => Promise<DetectedBarcode[]>
}
interface BarcodeDetectorConstructor {
  new (options?: BarcodeDetectorOptions): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

function getBarcodeDetector(): BarcodeDetectorConstructor | null {
  if (typeof window === 'undefined') return null
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
  return ctor ?? null
}

export interface BarcodeScannerSheetProps {
  open: boolean
  onClose: () => void
  onDetected: (value: string) => void
}

export function BarcodeScannerSheet({ open, onClose, onDetected }: BarcodeScannerSheetProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const detectorRef = useRef<BarcodeDetectorLike | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [supported] = useState(() => Boolean(getBarcodeDetector()))

  // Latest-callback ref so the camera lifecycle effect doesn't tear
  // down + re-acquire each time the parent re-renders with a fresh
  // inline `onDetected` arrow (e.g. when the user types in the
  // asset-code input on the parent screen).
  const onDetectedRef = useRef(onDetected)
  useEffect(() => {
    onDetectedRef.current = onDetected
  }, [onDetected])

  useEffect(() => {
    if (!open || !supported) return
    let cancelled = false

    async function start() {
      setError(null)
      try {
        const Ctor = getBarcodeDetector()
        if (!Ctor) {
          setError('BarcodeDetector unavailable')
          return
        }
        detectorRef.current = new Ctor({
          formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'data_matrix'],
        })

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play().catch(() => {})
        }
        setScanning(true)
        loop()
      } catch (e) {
        // Most common failure: permission denied. Surface the message
        // so the user knows why the camera didn't open.
        const msg = e instanceof Error ? e.message : 'Camera unavailable'
        setError(/permission/i.test(msg) ? 'Camera permission denied — type the code instead.' : msg)
      }
    }

    function loop() {
      if (cancelled) return
      const video = videoRef.current
      const detector = detectorRef.current
      if (!video || !detector) return
      detector
        .detect(video)
        .then((results) => {
          if (cancelled) return
          if (results.length > 0) {
            const first = results[0]
            if (first?.rawValue) {
              onDetectedRef.current(first.rawValue)
              return
            }
          }
          rafRef.current = window.requestAnimationFrame(loop)
        })
        .catch(() => {
          // detect() can throw when the video isn't ready yet — just
          // try again next frame.
          if (!cancelled) rafRef.current = window.requestAnimationFrame(loop)
        })
    }

    void start()

    return () => {
      cancelled = true
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      const stream = streamRef.current
      streamRef.current = null
      if (stream) stream.getTracks().forEach((t) => t.stop())
      setScanning(false)
    }
  }, [open, supported])

  if (!open) return null

  return (
    <Sheet open onClose={onClose} title="Scan barcode or QR">
      <div className="space-y-3">
        {!supported ? (
          <div className="space-y-2">
            <Pill tone="warn">Not supported</Pill>
            <div className="text-[12px] text-ink-2">
              This browser doesn't expose the BarcodeDetector API yet. Type the asset code in the field instead — it
              works the same way once entered.
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative aspect-[4/3] rounded-md overflow-hidden bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                className="w-full h-full object-cover"
                aria-label="Camera preview"
              />
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="w-3/4 aspect-square border-2 border-white/80 rounded-md shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
              </div>
            </div>
            <div className="flex items-center justify-between text-[12px] text-ink-3">
              <span>{scanning ? 'Aim at the sticker — auto-fills on read.' : 'Starting camera…'}</span>
              {scanning ? <Pill tone="good">Live</Pill> : null}
            </div>
          </div>
        )}
        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        <MobileButton variant="ghost" onClick={onClose}>
          Cancel
        </MobileButton>
      </div>
    </Sheet>
  )
}

export function isBarcodeScanSupported(): boolean {
  return (
    Boolean(getBarcodeDetector()) && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  )
}
