import { Spark, MI } from '@/components/m'
import { formatQty } from '@/lib/takeoff/canvas-totals'
import { type MirrorAxis } from '@/lib/takeoff/copy-transform'
import { type MobileTool } from './types'

// Field + action styling for the mobile copy panel (H6). Co-located with the
// panel that owns them (moved verbatim from mobile-body.tsx).
const mCopyLabelStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: 'var(--m-num)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: 'var(--m-ink-4)',
}
const mCopyInputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '8px 8px',
  border: '2px solid var(--m-ink-2)',
  background: 'var(--m-sand)',
  fontFamily: 'var(--m-num)',
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--m-ink)',
}

// ---------------------------------------------------------------------------
// AI launch slab — "● AI · Count or draft with AI" — launches the mobile
// AI-takeoff flow (chooser → count / auto-takeoff lanes). Brutalist ink slab
// with the Spark marker. Extracted verbatim from mobile-body.tsx.
// ---------------------------------------------------------------------------
export function MobileAiLaunch({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div style={{ padding: '10px 16px 0' }}>
      {/* "● AI" — launches the mobile AI-takeoff flow (chooser → count /
          auto-takeoff lanes). Brutalist ink slab with the Spark marker. */}
      <button
        type="button"
        onClick={onLaunch}
        style={{
          width: '100%',
          minHeight: 52,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '0 16px',
          background: 'var(--m-ink)',
          color: 'var(--m-sand)',
          border: '2px solid var(--m-ink)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <Spark size={16} state="strong" />
          <span style={{ minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: 'var(--m-accent)',
              }}
            >
              AI
            </span>
            <span
              style={{
                display: 'block',
                fontFamily: 'var(--m-font-display)',
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: '-0.01em',
                marginTop: 1,
              }}
            >
              Count or draft with AI
            </span>
          </span>
        </span>
        <MI.ChevRight size={20} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mono tool toolbar — square brutalist chips (POLY/RECT/LIN/PT/TAP).
// POLY/LIN/PT drive the existing draw handlers unchanged. RECT is a polygon
// alias (tap the 4 corners). TAP hands off to the AI tap-to-detect canvas.
// Extracted verbatim from mobile-body.tsx.
// ---------------------------------------------------------------------------
export function MobileToolToolbar({
  toolLabel,
  onPickTool,
  onTap,
}: {
  toolLabel: 'POLY' | 'RECT' | 'LIN' | 'PT'
  /** Picks a real draw tool (POLY/RECT → polygon, LIN → lineal, PT → count). */
  onPickTool: (tool: MobileTool, label: 'POLY' | 'RECT' | 'LIN' | 'PT') => void
  /** Hands off to the AI tap-to-detect canvas (the TAP chip). */
  onTap: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        marginBottom: 8,
        border: '2px solid var(--m-ink)',
        background: 'var(--m-card-soft)',
      }}
    >
      {(
        [
          { tool: 'polygon', label: 'POLY' },
          { tool: 'polygon', label: 'RECT' },
          { tool: 'lineal', label: 'LIN' },
          { tool: 'count', label: 'PT' },
          { tool: null, label: 'TAP' },
        ] as const
      ).map((t, i, arr) => {
        // TAP is the AI hand-off (tool: null); never an active draw tool.
        // RECT shares the polygon tool value, so highlight it only when
        // its label is the user's pick (tracked alongside the tool).
        const isTap = t.tool === null
        const on = isTap ? false : t.label === toolLabel
        return (
          <button
            key={t.label}
            type="button"
            onClick={() => {
              if (t.tool === null) {
                onTap()
                return
              }
              onPickTool(t.tool, t.label)
            }}
            style={{
              flex: 1,
              padding: '14px 0',
              background: on ? 'var(--m-accent)' : 'transparent',
              color: isTap ? 'var(--m-accent)' : on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
              border: 'none',
              borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: on ? 700 : 600,
              letterSpacing: '0.06em',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Deduct/cutout toggle (msg19 "WIN") — only meaningful for an area
// (polygon/rect) tool. Extracted verbatim from mobile-body.tsx.
// ---------------------------------------------------------------------------
export function MobileDeductToggle({ deduct, onToggle }: { deduct: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={deduct}
      style={{
        width: '100%',
        marginBottom: 8,
        padding: '10px 12px',
        background: deduct ? 'var(--m-ink)' : 'transparent',
        color: deduct ? 'var(--m-sand)' : 'var(--m-ink-2)',
        border: '2px solid var(--m-ink)',
        fontFamily: 'var(--m-num)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <span>DEDUCT · CUTOUT (E.G. WINDOW)</span>
      <span style={{ color: deduct ? 'var(--m-accent)' : 'var(--m-ink-4)' }}>{deduct ? '● ON' : '○ OFF'}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Bulk-select toggle (msg23) — switches canvas taps from draw to multi-select.
// Extracted verbatim from mobile-body.tsx.
// ---------------------------------------------------------------------------
export function MobileBulkSelectToggle({
  bulkMode,
  bulkSelectedCount,
  canvasMeasurementCount,
  onToggle,
  onSelectAll,
}: {
  bulkMode: boolean
  bulkSelectedCount: number
  canvasMeasurementCount: number
  onToggle: () => void
  onSelectAll: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={bulkMode}
      style={{
        width: '100%',
        marginBottom: 8,
        padding: '10px 12px',
        background: bulkMode ? 'var(--m-accent)' : 'transparent',
        color: bulkMode ? 'var(--m-accent-ink)' : 'var(--m-ink-2)',
        border: '2px solid var(--m-ink)',
        fontFamily: 'var(--m-num)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <span>{bulkMode ? `${bulkSelectedCount} SELECTED` : 'SELECT MULTIPLE'}</span>
      {bulkMode ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onSelectAll()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation()
              onSelectAll()
            }
          }}
          style={{ color: 'var(--m-accent-ink)', textDecoration: 'underline', cursor: 'pointer' }}
        >
          SELECT ALL · {canvasMeasurementCount}
        </span>
      ) : (
        <span style={{ color: 'var(--m-ink-4)' }}>○ OFF</span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Bulk selection footer (msg23) — the selection total readout + REASSIGN /
// COPY / DELETE actions shown while bulk-selecting. Extracted verbatim from
// mobile-body.tsx.
// ---------------------------------------------------------------------------
export function MobileBulkFooter({
  bulkPolys,
  bulkTotal,
  bulkUnit,
  bulkSelectedCount,
  copyOpen,
  reassignPending,
  deletePending,
  onReassign,
  onToggleCopy,
  onDelete,
}: {
  bulkPolys: number
  bulkTotal: number
  bulkUnit: string
  bulkSelectedCount: number
  copyOpen: boolean
  reassignPending: boolean
  deletePending: boolean
  onReassign: () => void
  onToggleCopy: () => void
  onDelete: () => void
}) {
  return (
    <div style={{ marginTop: 8, background: 'var(--m-ink)', border: '2px solid var(--m-ink)' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--m-ink-2)' }}>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--m-accent)',
          }}
        >
          SELECTION · {bulkPolys} POLY{bulkPolys === 1 ? '' : 'S'} · TOTAL
        </div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 26,
            lineHeight: 1,
            marginTop: 4,
            color: 'var(--m-sand)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatQty(bulkTotal)}
          <span style={{ fontSize: 13, color: 'var(--m-ink-4)', marginLeft: 6 }}>{bulkUnit.toUpperCase()}</span>
        </div>
      </div>
      <div style={{ display: 'flex' }}>
        <button
          type="button"
          onClick={onReassign}
          disabled={reassignPending}
          style={{
            flex: 1,
            padding: '12px 6px',
            background: 'transparent',
            color: 'var(--m-sand)',
            border: 'none',
            borderRight: '1px solid var(--m-ink-2)',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            cursor: 'pointer',
          }}
        >
          REASSIGN ITEM
        </button>
        <button
          type="button"
          onClick={onToggleCopy}
          style={{
            flex: 1,
            padding: '12px 6px',
            background: copyOpen ? 'var(--m-accent)' : 'transparent',
            color: copyOpen ? 'var(--m-accent-ink)' : 'var(--m-sand)',
            border: 'none',
            borderRight: '1px solid var(--m-ink-2)',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            cursor: 'pointer',
          }}
        >
          {copyOpen ? 'COPY ✕' : 'COPY…'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={deletePending}
          style={{
            flex: 1,
            padding: '12px 6px',
            background: 'transparent',
            color: 'var(--m-red)',
            border: 'none',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            cursor: 'pointer',
          }}
        >
          DELETE {bulkSelectedCount}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Copy / array / mirror panel (deep-dive H6). Renders when the COPY… toggle is
// on and a copyable measurement is selected (single or bulk). Saves NEW
// measurements via the create path — same item/unit/sheet — so quantities
// recompute. Extracted verbatim from mobile-body.tsx.
// ---------------------------------------------------------------------------
export function MobileCopyPanel({
  copyableCount,
  copyDx,
  copyDy,
  copyCount,
  copyMirror,
  copyRotate,
  copyBusy,
  onCopyDx,
  onCopyDy,
  onCopyCount,
  onCopyMirror,
  onCopyRotate,
  onRun,
}: {
  copyableCount: number
  copyDx: string
  copyDy: string
  copyCount: string
  copyMirror: MirrorAxis | 'none'
  copyRotate: string
  copyBusy: boolean
  onCopyDx: (v: string) => void
  onCopyDy: (v: string) => void
  onCopyCount: (v: string) => void
  onCopyMirror: (v: MirrorAxis | 'none') => void
  onCopyRotate: (v: string) => void
  onRun: (mode: 'offset' | 'array') => void
}) {
  const mCopyActionStyle: React.CSSProperties = {
    flex: 1,
    padding: '12px 8px',
    border: 'none',
    background: 'var(--m-accent)',
    color: 'var(--m-accent-ink)',
    fontFamily: 'var(--m-num)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    cursor: copyBusy ? 'not-allowed' : 'pointer',
    opacity: copyBusy ? 0.6 : 1,
  }
  return (
    <div style={{ marginTop: 8, background: 'var(--m-ink)', border: '2px solid var(--m-ink)' }}>
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--m-ink-2)',
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.06em',
          color: 'var(--m-accent)',
        }}
      >
        COPY · {copyableCount} {copyableCount === 1 ? 'MEASUREMENT' : 'MEASUREMENTS'}
      </div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={mCopyLabelStyle}>
            OFFSET X
            <input type="number" value={copyDx} onChange={(e) => onCopyDx(e.target.value)} style={mCopyInputStyle} />
          </label>
          <label style={mCopyLabelStyle}>
            OFFSET Y
            <input type="number" value={copyDy} onChange={(e) => onCopyDy(e.target.value)} style={mCopyInputStyle} />
          </label>
          <label style={mCopyLabelStyle}>
            COUNT
            <input
              type="number"
              min={1}
              value={copyCount}
              onChange={(e) => onCopyCount(e.target.value)}
              style={mCopyInputStyle}
            />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={mCopyLabelStyle}>
            MIRROR
            <select
              value={copyMirror}
              onChange={(e) => onCopyMirror(e.target.value as MirrorAxis | 'none')}
              style={mCopyInputStyle}
            >
              <option value="none">None</option>
              <option value="x">Flip ↔</option>
              <option value="y">Flip ↕</option>
            </select>
          </label>
          <label style={mCopyLabelStyle}>
            ROTATE °
            <input
              type="number"
              value={copyRotate}
              onChange={(e) => onCopyRotate(e.target.value)}
              style={mCopyInputStyle}
            />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" disabled={copyBusy} onClick={() => onRun('offset')} style={mCopyActionStyle}>
            {copyBusy ? 'COPYING…' : 'COPY OFFSET'}
          </button>
          <button type="button" disabled={copyBusy} onClick={() => onRun('array')} style={mCopyActionStyle}>
            ARRAY ×{Math.max(1, Math.floor(Number(copyCount) || 1))}
          </button>
        </div>
      </div>
    </div>
  )
}
