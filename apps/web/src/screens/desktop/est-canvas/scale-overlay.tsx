import { type TakeoffPoint } from '@sitelayer/domain'
import { type BlueprintDocument } from '@/lib/api'
import { MButton } from '@/components/m'
import { floatBox, floatHead } from './desktop-body-styles'

// DCanvasScale · scale-calibration overlay (center) — extracted verbatim from
// desktop-body.tsx (behavior preserved). Renders only while the canvas mode is
// 'scale'; the gating stays in the parent. The two board-space reference points
// + typed real-world length flow through the page-calibration mutation
// (`applyScale`), and the provisional drawing-scale ratio is a read-only hint.
export function ScaleOverlay({
  activeBlueprint,
  scalePoints,
  scaleLength,
  setScaleLength,
  provisionalRatio,
  scaleError,
  applyScale,
  calibratePending,
  onAiVerify,
}: {
  activeBlueprint: BlueprintDocument | null
  scalePoints: TakeoffPoint[]
  scaleLength: string
  setScaleLength: (next: string) => void
  provisionalRatio: number | null
  scaleError: string | null
  applyScale: () => void
  calibratePending: boolean
  onAiVerify: () => void
}) {
  return (
    <div
      style={floatBox({
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 420,
      })}
    >
      <div style={floatHead}>● Set scale · {activeBlueprint?.file_name ?? 'sheet'}</div>
      <div style={{ padding: 24 }}>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            color: 'var(--m-ink-3)',
            fontWeight: 600,
            lineHeight: 1.5,
          }}
        >
          {scalePoints.length < 2
            ? `CLICK TWO POINTS OF A KNOWN DIMENSION ON THE SHEET (${scalePoints.length}/2), THEN ENTER ITS LENGTH:`
            : 'ENTER THE REAL-WORLD LENGTH OF THE LINE YOU DREW:'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              padding: '12px 14px',
              background: 'var(--m-card-soft)',
              border: '2px solid var(--m-ink)',
            }}
          >
            <input
              value={scaleLength}
              onChange={(e) => setScaleLength(e.target.value.replace(/[^\d.]/g, ''))}
              inputMode="decimal"
              aria-label="Real-world length"
              style={{
                width: 80,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 32,
                color: 'var(--m-ink)',
              }}
            />
            <span style={{ fontSize: 16, color: 'var(--m-ink-3)', fontWeight: 700 }}>FT</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            {/* Provisional drawing-scale ratio (= 1:N · PROVISIONAL), shown
                once a line + length are present — matches design dsg__46. */}
            {provisionalRatio != null ? (
              <div
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontSize: 16,
                  fontWeight: 800,
                  color: 'var(--m-ink)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                = 1:{provisionalRatio}
              </div>
            ) : (
              <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, color: 'var(--m-ink-3)', fontWeight: 600 }}>
                {scalePoints.length}/2 PTS
              </div>
            )}
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                color: scalePoints.length >= 2 ? 'var(--m-amber)' : 'var(--m-ink-3)',
                fontWeight: 700,
                marginTop: 3,
              }}
            >
              {scalePoints.length >= 2 ? '● PROVISIONAL' : '○ DRAW LINE'}
            </div>
          </div>
        </div>
        {scaleError ? (
          <div style={{ color: 'var(--m-red)', fontSize: 12, fontWeight: 600, marginTop: 10 }}>{scaleError}</div>
        ) : null}
        <div
          style={{
            padding: '12px 14px',
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            marginTop: 16,
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1.5,
          }}
        >
          AI can detect + verify scale on all sheets at once.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <MButton variant="ghost" onClick={applyScale} disabled={scalePoints.length < 2 || calibratePending}>
            {calibratePending ? 'Saving…' : 'Apply to sheet'}
          </MButton>
          <MButton variant="primary" onClick={onAiVerify}>
            AI verify all
          </MButton>
        </div>
      </div>
    </div>
  )
}
