import { type DetectedScale } from '@/lib/takeoff/sheet-scale'
import { formatQty } from '@/lib/takeoff/canvas-totals'
import { MButton } from '@/components/m'
import { floatBox } from './desktop-body-styles'

// Top strip: sheet name + DONE / total — extracted verbatim from desktop-body.tsx
// (behavior preserved). Shows the active draft name, the current sheet label,
// any detected drawing scale, the grand-total quantity, and the Done → button.
export function TopStrip({
  draftName,
  sheetLabel,
  detectedScale,
  grandTotal,
  onDone,
}: {
  draftName: string
  sheetLabel: string
  detectedScale: DetectedScale | null
  grandTotal: number
  onDone: () => void
}) {
  return (
    <div
      style={floatBox({
        top: 16,
        left: 16,
        right: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '12px 16px',
        boxShadow: '6px 6px 0 var(--m-ink)',
      })}
    >
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
          }}
        >
          Takeoff · {draftName}
        </span>
        <span
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 18,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {sheetLabel}
        </span>
        {detectedScale ? (
          <span
            title={
              detectedScale.labeled
                ? 'Drawing scale detected from the title block'
                : 'Possible drawing scale found on this sheet'
            }
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: 'var(--m-accent)',
              whiteSpace: 'nowrap',
            }}
          >
            SCALE {detectedScale.label}
            {detectedScale.labeled ? '' : ' (?)'}
          </span>
        ) : null}
      </div>
      <span style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        <span style={{ textAlign: 'right' }}>
          <span
            style={{
              display: 'block',
              fontFamily: 'var(--m-num)',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            Total qty
          </span>
          <span
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 22,
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatQty(grandTotal)}
          </span>
        </span>
        <MButton variant="primary" onClick={onDone}>
          Done →
        </MButton>
      </span>
    </div>
  )
}
