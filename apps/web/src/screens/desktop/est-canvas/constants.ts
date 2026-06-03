import { type SheetCallout } from './types'

/** Accept filter for the blueprint file input — PDF plan sets + images.
 * The upload control itself is gated to admin/foreman/office (owner/foreman
 * personas), matching the API role gate on POST /api/projects/:id/blueprints. */
export const BLUEPRINT_UPLOAD_ACCEPT = 'application/pdf,image/*'

export const MAX_POLYGON_POINTS = 64

export const SHEET_CALLOUTS: SheetCallout[] = [
  { tag: 'A1', x: 22, y: 30, detail: 'Wall section A1', targetPageIdx: 1 },
  { tag: 'B3', x: 58, y: 48, detail: 'Detail B3 · parapet flashing', targetPageIdx: 2 },
]

// Ghost-chip button style for UNDO / CLEAR (mono, ink-bordered).
export function ghostChip(disabled: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '8px 0',
    background: 'transparent',
    color: 'var(--m-ink)',
    border: '2px solid var(--m-ink)',
    fontFamily: 'var(--m-num)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  }
}

// Compact numeric input for the pitch rise:run driver (H2).
export const pitchInputStyle: React.CSSProperties = {
  width: 44,
  padding: '4px 6px',
  background: 'transparent',
  color: 'var(--m-ink)',
  border: '2px solid var(--m-ink)',
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  textAlign: 'center',
}

export const HEIGHT_PRESETS = [8, 9, 10, 12] as const

export const stepperBtn: React.CSSProperties = {
  width: 44,
  height: 44,
  background: 'transparent',
  border: '2px solid var(--m-ink)',
  fontFamily: 'var(--m-font-display)',
  fontWeight: 800,
  fontSize: 22,
  lineHeight: 1,
  cursor: 'pointer',
}
