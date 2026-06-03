import { type PitchDriver, type TakeoffPoint } from '@sitelayer/domain'
import { round2 } from '@/lib/takeoff/canvas-math'
import { formatQty } from '@/lib/takeoff/canvas-totals'
import { MButton } from '@/components/m'
import { type Tool } from './types'
import { pitchInputStyle, ghostChip } from './constants'

// Draft HUD — the live big-number measurement readout, UNDO/REDO/CLEAR/SNAP/
// DEDUCT chips, the pitch rise:run driver, the Add button, and the inline
// error/toast lines. Extracted verbatim from the ITEM / quantities panel in
// desktop-body.tsx (behavior preserved). Every prop is a parent-derived value,
// machine-backed slice, or local setter/handler — no refs.
export function DraftHud({
  tool,
  draftPoints,
  draftQuantity,
  unitForItem,
  redoStack,
  snapEnabled,
  setSnapEnabled,
  deduct,
  setDeduct,
  isAreaTool,
  pitchAppliesToTool,
  pitchRise,
  setPitchRise,
  pitchRun,
  setPitchRun,
  activePitch,
  pitchFactor,
  undoPoint,
  redoPoint,
  clearDraft,
  onSave,
  canSave,
  createPending,
  error,
  savedToast,
}: {
  tool: Tool
  draftPoints: TakeoffPoint[]
  draftQuantity: number
  unitForItem: string
  redoStack: readonly unknown[]
  snapEnabled: boolean
  setSnapEnabled: (next: (prev: boolean) => boolean) => void
  deduct: boolean
  setDeduct: (next: (prev: boolean) => boolean) => void
  isAreaTool: boolean
  pitchAppliesToTool: boolean
  pitchRise: string
  setPitchRise: (next: string) => void
  pitchRun: string
  setPitchRun: (next: string) => void
  activePitch: PitchDriver | null
  pitchFactor: number
  undoPoint: () => void
  redoPoint: () => void
  // CANCEL→START_DRAW (empty path) drops the draft points + redo.
  clearDraft: () => void
  onSave: () => void
  canSave: boolean
  createPending: boolean
  error: string | null
  savedToast: string | null
}) {
  return (
    <>
      {/* Live measurement readout (big-number) */}
      <div
        style={{
          padding: '12px 14px',
          background: 'var(--m-ink)',
          color: 'var(--m-sand)',
          border: '2px solid var(--m-ink)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--m-accent)',
          }}
        >
          {tool === 'polygon'
            ? `POLY · ${draftPoints.length} PTS`
            : tool === 'rect'
              ? `RECT · ${draftPoints.length ? 'DRAWN' : 'DRAG'}`
              : tool === 'arc'
                ? `ARC · ${draftPoints.length}/3`
                : tool === 'lineal'
                  ? `LIN · ${draftPoints.length} PTS`
                  : `PT · ${draftPoints.length}`}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 32,
            lineHeight: 1,
            marginTop: 4,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {tool === 'count' ? `${draftPoints.length}` : formatQty(draftQuantity)}
          <span style={{ fontSize: 13, color: 'var(--m-ink-4)', marginLeft: 6 }}>
            {tool === 'polygon'
              ? unitForItem
              : tool === 'lineal'
                ? unitForItem
                : draftPoints.length === 1
                  ? 'CT'
                  : 'CTS'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={undoPoint}
          disabled={draftPoints.length === 0}
          style={ghostChip(draftPoints.length === 0)}
        >
          UNDO
        </button>
        <button
          type="button"
          onClick={redoPoint}
          disabled={redoStack.length === 0}
          style={ghostChip(redoStack.length === 0)}
        >
          REDO
        </button>
        <button
          type="button"
          onClick={() => {
            // CANCEL→START_DRAW (empty path) drops the draft points + redo.
            clearDraft()
          }}
          disabled={draftPoints.length === 0}
          style={ghostChip(draftPoints.length === 0)}
        >
          CLEAR
        </button>
        <button
          type="button"
          onClick={() =>
            setSnapEnabled((on) => {
              const next = !on
              try {
                localStorage.setItem('sitelayer.snap', next ? 'on' : 'off')
              } catch {
                /* private mode */
              }
              return next
            })
          }
          title="Snap new points to nearby vertices and to horizontal/vertical"
          style={{
            ...ghostChip(false),
            ...(snapEnabled
              ? { background: 'var(--m-ink)', color: 'var(--m-paper)', borderColor: 'var(--m-ink)' }
              : {}),
          }}
        >
          SNAP {snapEnabled ? 'ON' : 'OFF'}
        </button>
        {isAreaTool ? (
          <button
            type="button"
            onClick={() => setDeduct((on) => !on)}
            title="Cutout: subtract this area from the net (e.g. a window or door opening)"
            style={{
              ...ghostChip(false),
              ...(deduct ? { background: 'var(--m-red)', color: 'var(--m-paper)', borderColor: 'var(--m-red)' } : {}),
            }}
          >
            DEDUCT {deduct ? 'ON' : 'OFF'}
          </button>
        ) : null}
      </div>

      {/* Pitch / slope driver (H2). Rise:run drives the slope factor
          √(rise²+run²)/run applied to the scaled area/length so sloped
          cladding/gables read true surface area. Blank/0 ⇒ flat ⇒ ×1.0. */}
      {pitchAppliesToTool ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
          }}
        >
          <span title="Roof/slope pitch — rise in run (e.g. 6 in 12). Blank = flat.">PITCH</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={pitchRise}
            onChange={(e) => setPitchRise(e.target.value)}
            placeholder="rise"
            aria-label="Pitch rise"
            style={pitchInputStyle}
          />
          <span style={{ color: 'var(--m-ink)' }}>:</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={pitchRun}
            onChange={(e) => setPitchRun(e.target.value)}
            placeholder="run"
            aria-label="Pitch run"
            style={pitchInputStyle}
          />
          <span style={{ color: activePitch && pitchFactor > 1 ? 'var(--m-amber)' : 'var(--m-ink-3)' }}>
            ×{round2(pitchFactor)}
          </span>
        </div>
      ) : null}

      <MButton variant="primary" onClick={() => void onSave()} disabled={!canSave}>
        {createPending ? 'Saving…' : `Add ${draftQuantity > 0 ? formatQty(draftQuantity) : ''} ${unitForItem}`.trim()}
      </MButton>

      {error ? <div style={{ fontSize: 12, color: 'var(--m-red)' }}>{error}</div> : null}
      {savedToast ? <div style={{ fontSize: 12, color: 'var(--m-green)' }}>{savedToast}</div> : null}
    </>
  )
}
