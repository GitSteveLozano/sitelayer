import { type ServiceItem } from '@/lib/api'
import { floatBox } from './desktop-body-styles'

// DCanvasItemPalette · "/"-style scope-item command palette — extracted verbatim
// from desktop-body.tsx (behavior preserved). Renders only while open; the
// `itemPaletteOpen` gate stays in the parent. Picking an item either reassigns a
// pending committed selection or sets the draft item (the parent's
// `applyItemPick` decides which).
export function ItemPalette({
  itemQuery,
  setItemQuery,
  paletteItems,
  serviceItemCode,
  applyItemPick,
  closePalette,
}: {
  itemQuery: string
  setItemQuery: (next: string) => void
  paletteItems: ServiceItem[]
  serviceItemCode: string
  applyItemPick: (code: string) => void
  // Escape: close the palette and clear any pending reassign.
  closePalette: () => void
}) {
  return (
    <div
      style={floatBox({
        top: 120,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 520,
      })}
    >
      <div
        style={{
          padding: '14px 18px',
          borderBottom: '2px solid var(--m-ink)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'var(--m-card)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontWeight: 800,
            fontSize: 14,
            color: 'var(--m-accent-ink)',
            background: 'var(--m-accent)',
            padding: '2px 8px',
          }}
          aria-hidden
        >
          /
        </span>
        <input
          autoFocus
          value={itemQuery}
          onChange={(e) => setItemQuery(e.target.value)}
          placeholder="Assign item…"
          aria-label="Assign scope item"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontFamily: 'var(--m-font-display)',
            fontWeight: 700,
            fontSize: 18,
            color: 'var(--m-ink)',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && paletteItems[0]) {
              applyItemPick(paletteItems[0].code)
            } else if (e.key === 'Escape') {
              closePalette()
            }
          }}
        />
        <span style={{ fontFamily: 'var(--m-num)', fontSize: 10, color: 'var(--m-ink-3)', fontWeight: 600 }}>
          ↑↓ NAVIGATE · ⏎ SELECT
        </span>
      </div>
      {paletteItems.length === 0 ? (
        <div style={{ padding: '14px 18px', fontSize: 13, color: 'var(--m-ink-3)' }}>No matching items.</div>
      ) : (
        paletteItems.map((it, i) => {
          const hot = it.code === serviceItemCode || (serviceItemCode === '' && i === 0)
          return (
            <button
              key={it.code}
              type="button"
              onClick={() => applyItemPick(it.code)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '12px 18px',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                background: hot ? 'var(--m-accent)' : 'var(--m-card)',
                color: hot ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                border: 'none',
                borderBottom: '1px solid var(--m-line-2)',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 9,
                  fontWeight: 700,
                  width: 54,
                  color: hot ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                }}
              >
                {it.code}
              </span>
              <span style={{ flex: 1, fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 15 }}>
                {it.name}
              </span>
              <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>
                {(it.unit ?? '').toUpperCase()}
              </span>
            </button>
          )
        })
      )}
    </div>
  )
}
