import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MButton, MI, MPill } from '@/components/m'

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
  const ctor = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
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
    <MSheet title="Scan barcode or QR" onClose={onClose}>
      <div className="space-y-3">
        {!supported ? (
          <div className="space-y-2">
            <MPill tone="amber">Not supported</MPill>
            <div className="text-[12px] text-ink-2">
              This browser doesn't expose the BarcodeDetector API yet. Type the asset code in the field instead — it
              works the same way once entered.
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative aspect-[4/3] overflow-hidden bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                className="w-full h-full object-cover"
                aria-label="Camera preview"
              />
              {/* Scan frame — square corners per the v2 brand (msg__71). */}
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="w-3/4 aspect-square border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
              </div>
            </div>
            <div className="flex items-center justify-between text-[12px] text-ink-3">
              <span>{scanning ? 'Aim at the sticker — auto-fills on read.' : 'Starting camera…'}</span>
              {scanning ? <MPill tone="green">Live</MPill> : null}
            </div>
          </div>
        )}
        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        <MButton variant="ghost" onClick={onClose}>
          Cancel
        </MButton>
      </div>
    </MSheet>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow). Replaces the legacy
 * mobile-kit Sheet (rounded-t-[24px]) this sheet used pre-v2.
 * ESC and backdrop-tap dismiss. Same local-helper pattern as
 * screens/mobile/schedule.tsx and screens/financial/generate-payroll-export-sheet.tsx.
 */
function MSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(15, 14, 12, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="m-sheet" style={{ maxWidth: 720 }}>
        <div className="m-sheet-header">
          <div className="m-sheet-title">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              color: 'var(--m-ink)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <MI.X size={20} />
          </button>
        </div>
        <div className="m-sheet-body" style={{ padding: '16px 20px' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

export function isBarcodeScanSupported(): boolean {
  return (
    Boolean(getBarcodeDetector()) && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  )
}
