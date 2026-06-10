import { type TakeoffMeasurement } from '@/lib/api'
import { formatQty } from '@/lib/takeoff/canvas-totals'
import { floatBox } from './desktop-body-styles'

// DCanvasEditMeasure · single-selection contextual action bar — extracted
// verbatim from desktop-body.tsx (behavior preserved). Renders when exactly one
// committed measurement is selected in SELECT mode. While EDIT GEOM is engaged
// it shows APPLY/CANCEL; otherwise REASSIGN/EDIT GEOM/DUPLICATE/COPY/DELETE.
export function SingleSelectBar({
  selectedMeasurement,
  selectedIndex,
  measurementCount,
  editGeomId,
  patchPending,
  commitEditGeom,
  cancelEditGeom,
  onReassign,
  onEditGeom,
  onDuplicate,
  copyOpen,
  toggleCopy,
  onTags,
  onDelete,
}: {
  selectedMeasurement: TakeoffMeasurement
  selectedIndex: number
  measurementCount: number
  editGeomId: string | null
  patchPending: boolean
  commitEditGeom: () => void
  cancelEditGeom: () => void
  onReassign: () => void
  onEditGeom: () => void
  onDuplicate: () => void
  copyOpen: boolean
  toggleCopy: () => void
  onTags: () => void
  onDelete: () => void
}) {
  return (
    <div
      style={floatBox({
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'stretch',
      })}
    >
      <div style={{ padding: '14px 20px', borderRight: '2px solid var(--m-ink)' }}>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--m-accent-ink)',
            background: 'var(--m-accent)',
            display: 'inline-block',
            padding: '2px 6px',
          }}
        >
          {editGeomId === selectedMeasurement.id
            ? 'EDIT GEOM · DRAG A HANDLE'
            : `SELECTED · ${selectedIndex >= 0 ? selectedIndex + 1 : '—'} OF ${measurementCount}`}
        </span>
        <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 24, marginTop: 6 }}>
          {formatQty(Number(selectedMeasurement.quantity))} {selectedMeasurement.unit} ·{' '}
          {selectedMeasurement.service_item_code}
        </div>
      </div>
      {(editGeomId === selectedMeasurement.id
        ? ([
            { l: patchPending ? 'SAVING…' : 'APPLY', action: () => void commitEditGeom() },
            { l: 'CANCEL', action: cancelEditGeom },
          ] as const)
        : ([
            { l: 'REASSIGN', action: onReassign },
            { l: 'EDIT GEOM', action: onEditGeom },
            { l: 'DUPLICATE', action: () => void onDuplicate() },
            { l: copyOpen ? 'COPY ✕' : 'COPY…', action: toggleCopy },
            { l: 'TAGS', action: onTags },
            { l: 'DELETE', danger: true, action: onDelete },
          ] as const)
      ).map((b, i, arr) => (
        <button
          key={b.l}
          type="button"
          onClick={b.action}
          disabled={patchPending && editGeomId === selectedMeasurement.id}
          style={{
            padding: '0 22px',
            background: 'var(--m-card)',
            color: 'danger' in b && b.danger ? 'var(--m-red)' : 'var(--m-ink)',
            border: 'none',
            borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            cursor: 'pointer',
          }}
        >
          {b.l}
        </button>
      ))}
    </div>
  )
}

// DCanvasBulkSelect · marquee multi-selection toolbar (2+) — extracted verbatim
// from desktop-body.tsx (behavior preserved). Renders when 2+ committed
// measurements are marquee-selected in SELECT mode.
export function BulkSelectToolbar({
  count,
  bulkTotal,
  onReassign,
  copyOpen,
  toggleCopy,
  onBulkDelete,
}: {
  count: number
  bulkTotal: number
  onReassign: () => void
  copyOpen: boolean
  toggleCopy: () => void
  onBulkDelete: () => void
}) {
  return (
    <div
      style={floatBox({
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'stretch',
      })}
    >
      <div style={{ padding: '14px 24px', borderRight: '2px solid var(--m-ink)' }}>
        <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700, color: 'var(--m-ink-3)' }}>
          MARQUEE SELECTION · {count} {count === 1 ? 'ITEM' : 'ITEMS'}
        </div>
        <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 28, marginTop: 6 }}>
          {formatQty(bulkTotal)}
        </div>
      </div>
      <button
        type="button"
        onClick={onReassign}
        style={{
          padding: '0 24px',
          background: 'var(--m-card)',
          border: 'none',
          borderRight: '2px solid var(--m-ink)',
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.06em',
          cursor: 'pointer',
        }}
      >
        REASSIGN ITEM
      </button>
      <button
        type="button"
        onClick={toggleCopy}
        style={{
          padding: '0 24px',
          background: copyOpen ? 'var(--m-accent)' : 'var(--m-card)',
          color: copyOpen ? 'var(--m-accent-ink)' : 'var(--m-ink)',
          border: 'none',
          borderRight: '2px solid var(--m-ink)',
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.06em',
          cursor: 'pointer',
        }}
      >
        {copyOpen ? 'COPY ✕' : 'COPY…'}
      </button>
      <button
        type="button"
        onClick={onBulkDelete}
        style={{
          padding: '0 24px',
          background: 'var(--m-card)',
          color: 'var(--m-red)',
          border: 'none',
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.06em',
          cursor: 'pointer',
        }}
      >
        DELETE {count}
      </button>
    </div>
  )
}
