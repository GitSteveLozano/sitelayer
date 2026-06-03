import { type Tool, type CanvasMode } from './types'
import { floatBox, floatHead } from './desktop-body-styles'

// TOOL palette (top-left, below the strip) — extracted verbatim from
// desktop-body.tsx (behavior preserved). The draw buttons map 1:1 to the
// machine's draft `tool`; SCALE / SEL are interaction modes (DCanvasScale /
// DCanvasBulkSelect) that layer overlays over the same canvas.
export function ToolPalette({
  mode,
  tool,
  draftPoints,
  setMode,
  setTool,
  setDraftPoints,
  clearSelection,
}: {
  mode: CanvasMode
  tool: Tool
  draftPoints: readonly unknown[]
  setMode: (mode: CanvasMode) => void
  setTool: (tool: Tool) => void
  setDraftPoints: (points: never[]) => void
  clearSelection: () => void
}) {
  return (
    <div style={floatBox({ top: 92, left: 16, width: 56 })}>
      <div style={{ ...floatHead, padding: '8px 0', textAlign: 'center' }}>TOOL</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {(
          [
            { kind: 'draw', tool: 'polygon', label: 'POLY' },
            { kind: 'draw', tool: 'rect', label: 'RECT' },
            { kind: 'draw', tool: 'lineal', label: 'LIN' },
            { kind: 'draw', tool: 'arc', label: 'ARC' },
            { kind: 'draw', tool: 'count', label: 'PT' },
            { kind: 'draw', tool: 'tap', label: 'TAP' },
            // SCALE / SEL are interaction modes (DCanvasScale / DCanvasBulkSelect),
            // not new geometry tools — they layer overlays over the same canvas.
            { kind: 'mode', mode: 'scale', label: 'SCALE' },
            { kind: 'mode', mode: 'select', label: 'SEL' },
          ] as const
        ).map((t, i, arr) => {
          const isDraw = t.kind === 'draw'
          // RECT is a real drag-rectangle area tool; TAP is an alias for the
          // count tool (mobile-surface naming). All other draw buttons map
          // 1:1 to their geometry tool.
          const value: Tool = isDraw ? (t.tool === 'tap' ? 'count' : (t.tool as Tool)) : 'polygon'
          const on = isDraw
            ? mode === 'draw' &&
              ((t.tool === 'polygon' && tool === 'polygon') ||
                (t.tool === 'rect' && tool === 'rect') ||
                (t.tool === 'lineal' && tool === 'lineal') ||
                (t.tool === 'arc' && tool === 'arc') ||
                (t.tool === 'count' && tool === 'count') ||
                // TAP highlights when the count tool is active.
                (t.tool === 'tap' && tool === 'count'))
            : mode === t.mode
          return (
            <button
              key={t.label}
              type="button"
              onClick={() => {
                // Don't silently discard a drawn-but-unsaved measurement when
                // switching tools/modes (e.g. after a failed save, clicking
                // SEL used to wipe the polygon with no warning).
                if (draftPoints.length > 0 && !window.confirm('Discard the unsaved measurement you are drawing?'))
                  return
                if (isDraw) {
                  setMode('draw')
                  // SET_TOOL resets the in-progress draft (points + redo).
                  setTool(value)
                } else {
                  setMode(t.mode)
                  // Leaving the draw surface: drop any in-progress draft.
                  setDraftPoints([])
                }
                // Clear the whole machine selection slice + the copy panel.
                clearSelection()
              }}
              style={{
                width: 56,
                height: 48,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: on ? 'var(--m-accent)' : 'var(--m-sand)',
                color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                border: 'none',
                borderTop: t.kind === 'mode' && arr[i - 1]?.kind === 'draw' ? '2px solid var(--m-ink)' : 'none',
                borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: '0.04em',
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
