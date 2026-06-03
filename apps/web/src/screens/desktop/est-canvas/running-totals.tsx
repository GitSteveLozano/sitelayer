import { type ScopeTotal } from '@/lib/takeoff/canvas-totals'
import { type TakeoffCondition } from '@/lib/api/conditions'
import { formatQty } from '@/lib/takeoff/canvas-totals'

// Running totals by scope item + condition legend — extracted verbatim from the
// ITEM / quantities panel in desktop-body.tsx (behavior preserved). Pure render
// of the parent-derived `totals` and `conditionLegend` arrays.
export function RunningTotals({
  totals,
  conditionLegend,
}: {
  totals: ScopeTotal[]
  conditionLegend: Array<{ condition: TakeoffCondition; count: number; quantity: number }>
}) {
  return (
    <>
      {/* Running totals by scope item */}
      <div
        style={{
          borderTop: '2px solid var(--m-ink)',
          paddingTop: 10,
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        Running quantities
      </div>
      {totals.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--m-ink-3)', lineHeight: 1.5 }}>
          No measurements yet. Draw on the canvas to add one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {totals.map((t) => (
            <div
              key={t.code}
              style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}
            >
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t.code}</span>
              <span className="num" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                {formatQty(t.quantity)} {t.mixedUnits ? 'mixed' : t.unit}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Condition legend (Takeoff Deep Dive H1) — per-condition drawn
          count + quantity, color-keyed to the canvas. Only shows when at
          least one measurement was drawn against a condition. */}
      {conditionLegend.length > 0 ? (
        <>
          <div
            style={{
              borderTop: '2px solid var(--m-ink)',
              paddingTop: 10,
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            Conditions
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {conditionLegend.map((row) => (
              <div
                key={row.condition.id}
                style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      background: row.condition.color,
                      border: '1px solid var(--m-line)',
                      flex: '0 0 auto',
                    }}
                  />
                  {row.condition.name}
                </span>
                <span className="num" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                  {row.count}× · {formatQty(row.quantity)}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  )
}
