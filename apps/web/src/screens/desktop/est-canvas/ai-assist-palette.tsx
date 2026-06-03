import { type CanvasMode } from './types'
import { floatBox, floatHead } from './desktop-body-styles'

// AI ASSIST palette (top-right, left of the item palette) — extracted verbatim
// from desktop-body.tsx (behavior preserved). Launcher for the AI setup flows;
// selecting one parks the canvas mode in 'ai-count' / 'ai-takeoff' so the setup
// overlay mounts (the routes already exist in desktop-workspace.tsx).
export function AiAssistPalette({
  projectId,
  draftPoints,
  setMode,
}: {
  projectId: string
  draftPoints: readonly unknown[]
  setMode: (mode: CanvasMode) => void
}) {
  return (
    <div style={floatBox({ top: 92, right: 312, width: 220 })}>
      <div style={floatHead}>● AI Assist</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {(
          [
            { label: 'AUTO-COUNT A SYMBOL', mode: 'ai-count' as const },
            { label: 'AUTO-TAKEOFF JOB', mode: 'ai-takeoff' as const },
          ] as const
        ).map((b, i, arr) => (
          <button
            key={b.label}
            type="button"
            onClick={() => {
              // Don't silently discard an in-progress (drawn but unsaved) measurement.
              if (draftPoints.length > 0 && !window.confirm('Discard the unsaved measurement you are drawing?')) return
              setMode(b.mode)
            }}
            disabled={!projectId}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '12px 14px',
              background: 'var(--m-sand)',
              color: 'var(--m-ink)',
              border: 'none',
              borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: '0.04em',
              cursor: projectId ? 'pointer' : 'default',
              opacity: projectId ? 1 : 0.4,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--m-num)',
                fontWeight: 800,
                fontSize: 11,
                color: 'var(--m-accent-ink)',
                background: 'var(--m-accent)',
                padding: '1px 6px',
                flexShrink: 0,
              }}
              aria-hidden
            >
              AI
            </span>
            {b.label}
          </button>
        ))}
      </div>
    </div>
  )
}
