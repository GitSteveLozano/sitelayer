import { type CopyPlan, type MirrorAxis } from '@/lib/takeoff/copy-transform'
import { floatBox, floatHead, copyInputStyle, copyActionStyle } from './desktop-body-styles'

// Copy / array / mirror panel (deep-dive H6) — extracted verbatim from
// desktop-body.tsx (behavior preserved). Additive toolbar group: when a
// selection exists in SELECT mode and the COPY… button is toggled on, offer
// copy-with-offset, array-paste (N along a row), and mirror/rotate of the
// duplicated geometry. Each action saves NEW measurements through
// `useCreateMeasurement` (parent's `runCopyPlan`), so quantities recompute
// server-side. Only point-based geometries copy; the gate stays in the parent.
export function CopyPanel({
  targetCount,
  copyDx,
  setCopyDx,
  copyDy,
  setCopyDy,
  copyCount,
  setCopyCount,
  copyMirror,
  setCopyMirror,
  copyRotate,
  setCopyRotate,
  copyBusy,
  runCopyPlan,
}: {
  targetCount: number
  copyDx: string
  setCopyDx: (next: string) => void
  copyDy: string
  setCopyDy: (next: string) => void
  copyCount: string
  setCopyCount: (next: string) => void
  copyMirror: MirrorAxis | 'none'
  setCopyMirror: (next: MirrorAxis | 'none') => void
  copyRotate: string
  setCopyRotate: (next: string) => void
  copyBusy: boolean
  runCopyPlan: (mode: CopyPlan['mode']) => void
}) {
  return (
    <div style={floatBox({ bottom: 110, left: '50%', transform: 'translateX(-50%)', width: 360 })}>
      <div style={floatHead}>
        Copy · {targetCount} {targetCount === 1 ? 'measurement' : 'measurements'}
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <label style={{ flex: 1, fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700 }}>
            OFFSET X (BOARD)
            <input type="number" value={copyDx} onChange={(e) => setCopyDx(e.target.value)} style={copyInputStyle} />
          </label>
          <label style={{ flex: 1, fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700 }}>
            OFFSET Y (BOARD)
            <input type="number" value={copyDy} onChange={(e) => setCopyDy(e.target.value)} style={copyInputStyle} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <label style={{ flex: 1, fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700 }}>
            ARRAY COUNT
            <input
              type="number"
              min={1}
              value={copyCount}
              onChange={(e) => setCopyCount(e.target.value)}
              style={copyInputStyle}
            />
          </label>
          <label style={{ flex: 1, fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700 }}>
            MIRROR
            <select
              value={copyMirror}
              onChange={(e) => setCopyMirror(e.target.value as MirrorAxis | 'none')}
              style={copyInputStyle}
            >
              <option value="none">None</option>
              <option value="x">Flip ↔</option>
              <option value="y">Flip ↕</option>
            </select>
          </label>
          <label style={{ flex: 1, fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700 }}>
            ROTATE °
            <input
              type="number"
              value={copyRotate}
              onChange={(e) => setCopyRotate(e.target.value)}
              style={copyInputStyle}
            />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            disabled={copyBusy}
            onClick={() => void runCopyPlan('offset')}
            style={copyActionStyle(false, copyBusy)}
          >
            {copyBusy ? 'COPYING…' : 'COPY OFFSET'}
          </button>
          <button
            type="button"
            disabled={copyBusy}
            onClick={() => void runCopyPlan('array')}
            style={copyActionStyle(false, copyBusy)}
          >
            ARRAY ×{Math.max(1, Math.floor(Number(copyCount) || 1))}
          </button>
        </div>
        <div style={{ fontFamily: 'var(--m-num)', fontSize: 9, color: 'var(--m-ink-3)', lineHeight: 1.4 }}>
          New measurements keep the same item, unit, and sheet — quantities recompute on save. Mirror / rotate apply to
          every copy.
        </div>
      </div>
    </div>
  )
}
