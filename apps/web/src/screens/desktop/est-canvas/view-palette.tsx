import { floatBox, floatHead } from './desktop-body-styles'

// VIEW palette (zoom + pan), below the TOOL palette — extracted verbatim from
// desktop-body.tsx (behavior preserved). Drives the shared `useCanvasViewport`
// zoom/pan/hand state plus the cross-sheet callout overlay toggle.
export function ViewPalette({
  zoom,
  zoomBy,
  resetView,
  handMode,
  setHandMode,
  showCallouts,
  setShowCallouts,
}: {
  zoom: number
  zoomBy: (factor: number) => void
  resetView: () => void
  handMode: boolean
  setHandMode: (next: (prev: boolean) => boolean) => void
  showCallouts: boolean
  setShowCallouts: (next: (prev: boolean) => boolean) => void
}) {
  return (
    <div style={floatBox({ top: 456, left: 16, width: 56 })}>
      <div style={{ ...floatHead, padding: '8px 0', textAlign: 'center' }}>VIEW</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {(
          [
            { label: '＋', title: 'Zoom in', onClick: () => zoomBy(1.25) },
            { label: `${Math.round(zoom * 100)}%`, title: 'Reset view', onClick: resetView, small: true },
            { label: '－', title: 'Zoom out', onClick: () => zoomBy(0.8) },
            { label: '⤢', title: 'Fit to screen', onClick: resetView },
            {
              label: '✋',
              title: 'Pan (or hold Space / middle-drag)',
              onClick: () => setHandMode((h) => !h),
              toggle: 'hand' as const,
            },
            {
              // Cross-sheet callout overlay (dsg__50): show the detail-reference
              // circles so a click jumps to the referenced sheet.
              label: 'REF',
              title: 'Cross-sheet detail callouts — click a circle to jump',
              onClick: () => setShowCallouts((s) => !s),
              toggle: 'refs' as const,
            },
          ] as const
        ).map((b, i, arr) => {
          const active =
            'toggle' in b ? (b.toggle === 'hand' ? handMode : b.toggle === 'refs' ? showCallouts : false) : false
          return (
            <button
              key={b.title}
              type="button"
              title={b.title}
              aria-label={b.title}
              aria-pressed={'toggle' in b ? active : undefined}
              onClick={b.onClick}
              style={{
                width: 56,
                height: 40,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: active ? 'var(--m-accent)' : 'var(--m-sand)',
                color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                border: 'none',
                borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                fontFamily: 'var(--m-num)',
                fontSize: 'small' in b && b.small ? 10 : 16,
                fontWeight: 800,
                letterSpacing: '0.02em',
                cursor: 'pointer',
              }}
            >
              {b.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
